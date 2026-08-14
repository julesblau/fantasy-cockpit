(function () {
  'use strict';
  window.DC = window.DC || {};

  /** @typedef {"QB"|"RB"|"WR"|"TE"|"DST"|"K"} Position */
  /** @typedef {{id:string, rank:number, name:string, team:string, position:Position, byeWeek:number, tier:(number|null)}} Player */
  /** @typedef {{drafted:boolean, target:boolean, avoid:boolean, mine:boolean}} Marks */
  /** @typedef {{playerId:string, timestamp:number}} UndoEntry */
  /** @typedef {{position:("ALL"|"FLEX"|Position), status:("AVAILABLE"|"TARGETS"|"AVOID"|"DRAFTED"|"MINE")}} Filters */
  /** @typedef {{QB:number, RB:number, WR:number, TE:number, FLEX:number, DST:number, K:number, BENCH:number}} RosterReq */
  /** @typedef {{size:number, slot:number, snake:boolean, roster:RosterReq}} League */
  /**
   * @typedef {{
   *   schemaVersion: 4,
   *   players: Player[],
   *   marks: Object<string, Marks>,
   *   undoStack: UndoEntry[],
   *   filters: Filters,
   *   searchText: string,
   *   manuallyEdited: boolean,
   *   league: (League|null)
   * }} State
   */

  var CURRENT_SCHEMA_VERSION = 7;
  var STORAGE_KEY = 'draft-cockpit/state';
  var ADP_OVERRIDE_KEY = 'draft-cockpit/adp-override';
  var VALID_POSITIONS = { QB: true, RB: true, WR: true, TE: true, DST: true, K: true };
  var VALID_STATUSES = { AVAILABLE: true, TARGETS: true, AVOID: true, DRAFTED: true, MINE: true };
  var ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST', 'K', 'BENCH'];
  // upgrade detection only: a stored roster with exactly these 6 keys (no DST/K) predates K/DST support
  var LEGACY_ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BENCH'];
  // single source of truth for the roster default — ui.js reads this, never re-types the numbers
  var DEFAULT_ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DST: 1, K: 1, BENCH: 7 };
  var FLEX_ELIGIBLE = { RB: true, WR: true, TE: true };
  var VALUE_DRIFT_MIN = 15;
  var VALUE_RANK_CEILING = 75;

  // pre-market-order seed fingerprint: length + djb2 of the joined id list, for the one-time v7 reorder guard
  var LEGACY_SEED_IDS_LENGTH = 4888;
  var LEGACY_SEED_IDS_HASH = -698724641;

  /** @param {Player[]} players @returns {number} djb2 of players.map(id).join(',') */
  function hashIdList(players) {
    var str = players.map(function (p) { return p.id; }).join(',');
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h;
  }

  /** @type {Object<number, function(*): State>} old-version-number -> upgrader to next version */
  var migrations = {};

  migrations[1] = function (v1) {
    return { schemaVersion: 2, players: v1.players, marks: v1.marks, undoStack: v1.undoStack,
             filters: v1.filters, searchText: v1.searchText, manuallyEdited: false };
  };

  // pure pass-through: stamps schemaVersion itself, iterates nothing (mine healing is normalize's job)
  migrations[2] = function (v2) {
    return { schemaVersion: 3, players: v2.players, marks: v2.marks, undoStack: v2.undoStack,
             filters: v2.filters, searchText: v2.searchText, manuallyEdited: v2.manuallyEdited };
  };

  // pure pass-through: stamps schemaVersion itself, iterates nothing (tier/league healing is normalize's job)
  migrations[3] = function (v3) {
    return { schemaVersion: 4, players: v3.players, marks: v3.marks, undoStack: v3.undoStack,
             filters: v3.filters, searchText: v3.searchText, manuallyEdited: v3.manuallyEdited, league: null };
  };

  // pure pass-through: stamps schemaVersion itself, iterates nothing (adp healing is normalize's job)
  migrations[4] = function (v4) {
    return { schemaVersion: 5, players: v4.players, marks: v4.marks, undoStack: v4.undoStack,
             filters: v4.filters, searchText: v4.searchText, manuallyEdited: v4.manuallyEdited, league: v4.league };
  };

  // purges pre-v6 fake seed adp: rebuilds each player with adp forced null (tier/adp healing stays normalize's job)
  migrations[5] = function (v5) {
    return { schemaVersion: 6, players: v5.players.map(function (p) {
               return { id: p.id, rank: p.rank, name: p.name, team: p.team, position: p.position, byeWeek: p.byeWeek, tier: p.tier, adp: null };
             }), marks: v5.marks, undoStack: v5.undoStack,
             filters: v5.filters, searchText: v5.searchText, manuallyEdited: v5.manuallyEdited, league: v5.league };
  };

  // one-time board reorder: only a payload whose id sequence fingerprint-matches the pristine
  // pre-market-order legacy seed gets resorted by weighted consensus ADP; anything else (edited,
  // imported, already-reordered) is stamped through unchanged — never reorder a real user's board.
  migrations[6] = function (v6) {
    var joined = v6.players.map(function (p) { return p.id; }).join(',');
    var isLegacySeed = joined.length === LEGACY_SEED_IDS_LENGTH && hashIdList(v6.players) === LEGACY_SEED_IDS_HASH;
    var players = v6.players;
    if (isLegacySeed) {
      players = v6.players.slice().sort(function (a, b) {
        var ca = adpConsensus(a);
        var cb = adpConsensus(b);
        if (ca === null && cb === null) { return a.rank - b.rank; }
        if (ca === null) { return 1; }
        if (cb === null) { return -1; }
        if (ca !== cb) { return ca - cb; }
        return a.rank - b.rank;
      }).map(function (p, idx) {
        return { id: p.id, rank: idx + 1, name: p.name, team: p.team, position: p.position, byeWeek: p.byeWeek, tier: p.tier, adp: p.adp };
      });
    }
    return { schemaVersion: 7, players: players, marks: v6.marks, undoStack: v6.undoStack,
             filters: v6.filters, searchText: v6.searchText, manuallyEdited: v6.manuallyEdited, league: v6.league };
  };

  /** @returns {State} */
  function createSeedState() {
    var players = DC.data.SEED_PLAYERS.map(function (p) {
      return { id: p.id, rank: p.rank, name: p.name, team: p.team, position: p.position, byeWeek: p.byeWeek, tier: typeof p.tier === 'number' ? p.tier : null, adp: p.adp === undefined ? null : p.adp };
    });
    var marks = {};
    players.forEach(function (p) {
      marks[p.id] = { drafted: false, target: false, avoid: false, mine: false };
    });
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      players: players,
      marks: marks,
      undoStack: [],
      filters: { position: 'ALL', status: 'AVAILABLE' },
      searchText: '',
      manuallyEdited: false,
      league: null
    };
  }

  function setMark(state, playerId, patch) {
    var nextMarks = Object.assign({}, state.marks);
    nextMarks[playerId] = Object.assign({}, nextMarks[playerId], patch);
    return Object.assign({}, state, { marks: nextMarks });
  }

  // ---- tier invariant helpers (pure; position-scoped: among same-position tiered players,
  // tier is monotone non-decreasing in board order; nulls are transparent/skipped when
  // scanning for neighbors, as is any player at a different position) ---------------------

  function nearestTieredAbove(players, index) {
    var position = players[index].position;
    for (var i = index - 1; i >= 0; i--) {
      if (players[i].position !== position) {
        continue;
      }
      var t = players[i].tier;
      if (t !== null && t !== undefined) {
        return t;
      }
    }
    return null;
  }

  function nearestTieredBelow(players, index) {
    var position = players[index].position;
    for (var i = index + 1; i < players.length; i++) {
      if (players[i].position !== position) {
        continue;
      }
      var t = players[i].tier;
      if (t !== null && t !== undefined) {
        return t;
      }
    }
    return null;
  }

  /** @param {Player[]} players @param {number} index @param {number|null} desiredTier @returns {number|null} position-scoped */
  function clampTierAt(players, index, desiredTier) {
    if (desiredTier === null) {
      return null;
    }
    var above = nearestTieredAbove(players, index);
    var below = nearestTieredBelow(players, index);
    // asymmetric by design: no same-position-above leaves the floor at -Infinity (caller-healed
    // input assumed), whereas stepperBounds below floors min at 1 in the same situation.
    var min = above !== null ? above : -Infinity;
    var max = below !== null ? below : Infinity;
    return Math.min(Math.max(desiredTier, min), max);
  }

  /** @param {Player[]} players @returns {Player[]} new array (or same ref if nothing changed); position-scoped */
  function normalizeTiers(players) {
    var runningMax = {};
    var changed = false;
    var result = players.map(function (p) {
      var t = p.tier;
      if (t === null || t === undefined) {
        return p;
      }
      var prevMax = runningMax[p.position];
      var newTier = prevMax === undefined ? t : Math.max(t, prevMax);
      runningMax[p.position] = newTier;
      if (newTier === t) {
        return p;
      }
      changed = true;
      return { id: p.id, rank: p.rank, name: p.name, team: p.team, position: p.position, byeWeek: p.byeWeek, tier: newTier, adp: p.adp };
    });
    return changed ? result : players;
  }

  /** @param {Player[]} players @param {number} index @returns {{min:number, max:(number|null), start:number|undefined}} position-scoped */
  function stepperBounds(players, index) {
    var above = nearestTieredAbove(players, index);
    var below = nearestTieredBelow(players, index);
    var result = { min: above !== null ? above : 1, max: below !== null ? below : null };
    var ownTier = players[index].tier;
    if (ownTier === null || ownTier === undefined) {
      result.start = above !== null ? above : (below !== null ? below : 1);
    }
    return result;
  }

  /**
   * Single source of truth for the divider truth table — do not duplicate. edit.js is the sole
   * caller (ui.js's main board renders tier chips instead). Lives here rather than only on DC.edit
   * so a test that stubs out DC.edit wholesale can never take ui.js's render() down with it.
   * @param {{tier:(number|null)}|null} prevView the row rendered immediately before view, or null at list start
   * @param {{tier:(number|null)}} view
   * @returns {string|null} "Tier {n}" when view starts a new tiered block; null otherwise.
   *   An untiered view never breaks. A tiered view breaks when prev is the list start, prev is
   *   untiered, or prev's tier differs — but a tiered-then-untiered transition does NOT break
   *   (untiered rows carry no label of their own).
   */
  function tierBreakBefore(prevView, view) {
    var tier = view ? view.tier : null;
    if (tier === null || tier === undefined) {
      return null;
    }
    var prevTier = prevView ? prevView.tier : null;
    if (prevTier === null || prevTier === undefined || prevTier !== tier) {
      return 'Tier ' + tier;
    }
    return null;
  }

  function healTier(t) {
    if (t === null) {
      return null;
    }
    if (typeof t !== 'number' || !isFinite(t) || Math.floor(t) !== t || t < 1) {
      return null;
    }
    return t;
  }

  /** @param {*} n @returns {boolean} real ADP is decimal, so floats are allowed (unlike tier) */
  function isAdpNum(n) {
    return typeof n === 'number' && isFinite(n) && n >= 1;
  }

  /** @param {*} v @returns {{espn?:number, flock?:number, sleeper?:number, underdog?:number}|null} keeps whichever of the four survive isAdpNum, alphabetical key order; null when none do (or v itself isn't heal-able) */
  function healAdp(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return null;
    }
    var out = {};
    if (isAdpNum(v.espn)) { out.espn = v.espn; }
    if (isAdpNum(v.flock)) { out.flock = v.flock; }
    if (isAdpNum(v.sleeper)) { out.sleeper = v.sleeper; }
    if (isAdpNum(v.underdog)) { out.underdog = v.underdog; }
    return Object.keys(out).length > 0 ? out : null;
  }

  /** @param {number|null|undefined} tier @returns {string|null} CSS class for tiers 1-6, 'tier-cx' for >=7, null otherwise */
  function tierColorClass(tier) {
    if (tier === null || tier === undefined) {
      return null;
    }
    if (typeof tier !== 'number' || !isFinite(tier) || Math.floor(tier) !== tier || tier < 1) {
      return null;
    }
    return tier <= 6 ? 'tier-c' + tier : 'tier-cx';
  }

  /** @param {Player[]} players @returns {Player[]} rebuilt in canonical key order, tier healed */
  function healPlayers(players) {
    return players.map(function (p) {
      return {
        id: p.id, rank: p.rank, name: p.name, team: p.team,
        position: p.position, byeWeek: p.byeWeek, tier: healTier(p.tier), adp: healAdp(p.adp)
      };
    });
  }

  // ---- league helpers (pure) --------------------------------------------------------------

  /** loose coercion for load-time healing: accepts an exact int, an integral float, or a digit string */
  function coerceIntLoose(v) {
    if (typeof v === 'number') {
      return (isFinite(v) && Math.floor(v) === v) ? v : null;
    }
    if (typeof v === 'string') {
      var s = v.trim();
      return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
    }
    return null;
  }

  /** true when roster is exactly the pre-K/DST 6-key shape (upgrade-detection only, not general validation) */
  function isLegacySixKeyRoster(roster) {
    for (var i = 0; i < LEGACY_ROSTER_KEYS.length; i++) {
      var v = coerceIntLoose(roster[LEGACY_ROSTER_KEYS[i]]);
      if (v === null || v < 0) {
        return false;
      }
    }
    return !Object.prototype.hasOwnProperty.call(roster, 'DST') && !Object.prototype.hasOwnProperty.call(roster, 'K');
  }

  /** strict validation for the SET_LEAGUE reducer: exact ints only, no coercion */
  function isValidLeagueStrict(league) {
    if (!league || typeof league !== 'object' || Array.isArray(league)) {
      return false;
    }
    if (!Number.isInteger(league.size) || league.size < 4 || league.size > 20) {
      return false;
    }
    if (!Number.isInteger(league.slot) || league.slot < 1 || league.slot > league.size) {
      return false;
    }
    if (typeof league.snake !== 'boolean') {
      return false;
    }
    if (!league.roster || typeof league.roster !== 'object') {
      return false;
    }
    for (var i = 0; i < ROSTER_KEYS.length; i++) {
      var v = league.roster[ROSTER_KEYS[i]];
      if (!Number.isInteger(v) || v < 0) {
        return false;
      }
    }
    return true;
  }

  /** @param {League} league @returns {League} rebuilt in canonical key order */
  function buildCanonicalLeague(league) {
    var roster = {};
    for (var i = 0; i < ROSTER_KEYS.length; i++) {
      roster[ROSTER_KEYS[i]] = league.roster[ROSTER_KEYS[i]];
    }
    return { size: league.size, slot: league.slot, snake: league.snake, roster: roster };
  }

  /** load-time heal: non-conforming -> null; conforming-but-dirty (float/string ints) -> coerced; out-of-bounds -> null */
  function healLeague(league) {
    if (!league || typeof league !== 'object' || Array.isArray(league)) {
      return null;
    }
    var size = coerceIntLoose(league.size);
    var slot = coerceIntLoose(league.slot);
    if (size === null || slot === null) {
      return null;
    }
    if (typeof league.snake !== 'boolean') {
      return null;
    }
    if (!league.roster || typeof league.roster !== 'object') {
      return null;
    }
    var roster;
    if (isLegacySixKeyRoster(league.roster)) {
      // pre-K/DST upgrade: old roster values are discarded wholesale, never key-healed
      roster = Object.assign({}, DEFAULT_ROSTER);
    } else {
      roster = {};
      for (var i = 0; i < ROSTER_KEYS.length; i++) {
        var key = ROSTER_KEYS[i];
        var raw = league.roster[key];
        if ((key === 'DST' || key === 'K') && raw === undefined) {
          roster[key] = DEFAULT_ROSTER[key];
          continue;
        }
        var v = coerceIntLoose(raw);
        if (v === null || v < 0) {
          return null;
        }
        roster[key] = v;
      }
    }
    if (size < 4 || size > 20) {
      return null;
    }
    if (slot < 1 || slot > size) {
      return null;
    }
    return { size: size, slot: slot, snake: league.snake, roster: roster };
  }

  /**
   * @param {State} state
   * @param {{type:string, [key:string]: *}} action
   * @returns {State}
   */
  function reduce(state, action) {
    switch (action.type) {
      case 'DRAFT_PLAYER': {
        var mark = state.marks[action.playerId];
        if (!mark || mark.drafted) {
          return state;
        }
        var next = setMark(state, action.playerId, { drafted: true, mine: action.mine === true });
        next.undoStack = state.undoStack.concat([{ playerId: action.playerId, timestamp: Date.now() }]);
        next.searchText = '';
        return next;
      }

      case 'TOGGLE_MINE': {
        var curMine = state.marks[action.playerId];
        if (!curMine || !curMine.drafted) {
          return state;
        }
        return setMark(state, action.playerId, { mine: !curMine.mine });
      }

      case 'UNDO_DRAFT': {
        if (state.undoStack.length === 0) {
          return state;
        }
        var lastEntry = state.undoStack[state.undoStack.length - 1];
        var afterUndo = setMark(state, lastEntry.playerId, { drafted: false, mine: false });
        afterUndo.undoStack = state.undoStack.slice(0, -1);
        return afterUndo;
      }

      case 'UNDRAFT_PLAYER': {
        var undraftMark = state.marks[action.playerId];
        if (!undraftMark || !undraftMark.drafted) {
          return state;
        }
        var afterUndraft = setMark(state, action.playerId, { drafted: false, mine: false });
        afterUndraft.undoStack = state.undoStack.filter(function (e) {
          return e.playerId !== action.playerId;
        });
        return afterUndraft;
      }

      case 'TOGGLE_TARGET': {
        var curTarget = state.marks[action.playerId];
        if (!curTarget) {
          return state;
        }
        var nowTarget = !curTarget.target;
        return setMark(state, action.playerId, { target: nowTarget, avoid: nowTarget ? false : curTarget.avoid });
      }

      case 'TOGGLE_AVOID': {
        var curAvoid = state.marks[action.playerId];
        if (!curAvoid) {
          return state;
        }
        var nowAvoid = !curAvoid.avoid;
        return setMark(state, action.playerId, { avoid: nowAvoid, target: nowAvoid ? false : curAvoid.target });
      }

      case 'SET_SEARCH':
        return Object.assign({}, state, { searchText: action.text });

      case 'SET_POSITION_FILTER':
        return Object.assign({}, state, { filters: Object.assign({}, state.filters, { position: action.position }) });

      case 'SET_STATUS_FILTER': {
        var nextStatus = action.status === state.filters.status ? 'AVAILABLE' : action.status;
        return Object.assign({}, state, { filters: Object.assign({}, state.filters, { status: nextStatus }) });
      }

      case 'RESET_DRAFT': {
        var resetDraftMarks = {};
        Object.keys(state.marks).forEach(function (id) {
          resetDraftMarks[id] = Object.assign({}, state.marks[id], { drafted: false, mine: false });
        });
        return Object.assign({}, state, { marks: resetDraftMarks, undoStack: [] });
      }

      case 'RESET_TARGETS_AVOID': {
        var resetTAMarks = {};
        Object.keys(state.marks).forEach(function (id) {
          resetTAMarks[id] = Object.assign({}, state.marks[id], { target: false, avoid: false });
        });
        return Object.assign({}, state, { marks: resetTAMarks });
      }

      case 'CLEAR_ALL_DATA':
        return createSeedState();

      case 'IMPORT_PLAYERS': {
        var newPlayers = normalizeTiers(action.players);
        var newMarks = {};
        newPlayers.forEach(function (p) {
          newMarks[p.id] = state.marks[p.id] || { drafted: false, target: false, avoid: false, mine: false };
        });
        var survivingIds = {};
        newPlayers.forEach(function (p) {
          survivingIds[p.id] = true;
        });
        var newUndoStack = state.undoStack.filter(function (e) {
          return survivingIds[e.playerId];
        });
        return {
          schemaVersion: state.schemaVersion,
          players: newPlayers,
          marks: newMarks,
          undoStack: newUndoStack,
          filters: { position: 'ALL', status: 'AVAILABLE' },
          searchText: '',
          manuallyEdited: false,
          league: state.league
        };
      }

      case 'REORDER_PLAYERS': {
        var order = action.order;
        if (!Array.isArray(order) || order.length !== state.players.length) return state;
        var byId = {}; state.players.forEach(function (p) { byId[p.id] = p; });
        var seen = {};
        for (var i = 0; i < order.length; i++) {
          var id = order[i];
          if (typeof id !== 'string' || !byId[id] || seen[id]) return state;
          seen[id] = true;
        }
        var reordered = order.map(function (id, idx) { return Object.assign({}, byId[id], { rank: idx + 1 }); });
        if (action.tiers && typeof action.tiers === 'object') {
          reordered = reordered.map(function (p) {
            if (!Object.prototype.hasOwnProperty.call(action.tiers, p.id)) {
              return p;
            }
            var v = action.tiers[p.id];
            var t = (v === null) ? null : (Number.isInteger(v) && v >= 1 ? v : null);
            return Object.assign({}, p, { tier: t });
          });
        }
        // always re-normalize, tiers param or not: a plain drag-reorder on an already-tiered
        // board can shuffle tiers out of monotone order too, and that must never persist
        // mid-session (only healed on next load()). A no-op on an all-null-tier board, so
        // today's untiered back-compat is unchanged by construction.
        reordered = normalizeTiers(reordered);
        return Object.assign({}, state, { players: reordered, manuallyEdited: true });
      }

      case 'SET_LEAGUE': {
        if (action.league === null) {
          return Object.assign({}, state, { league: null });
        }
        if (!isValidLeagueStrict(action.league)) {
          return state;
        }
        return Object.assign({}, state, { league: buildCanonicalLeague(action.league) });
      }

      default:
        return state;
    }
  }

  /**
   * @param {Player} player
   * @param {string} query
   * @returns {boolean}
   */
  function matchesSearch(player, query) {
    var q = query.trim().toLowerCase();
    if (q === '') {
      return true;
    }
    return (
      player.name.toLowerCase().indexOf(q) !== -1 ||
      player.team.toLowerCase().indexOf(q) === 0 ||
      player.position.toLowerCase().indexOf(q) === 0
    );
  }

  /**
   * @param {State} state
   * @returns {Array<Player & Marks>}
   */
  function visiblePlayers(state) {
    var positionFiltered = state.players.filter(function (p) {
      return state.filters.position === 'ALL' ||
        (state.filters.position === 'FLEX' ? !!FLEX_ELIGIBLE[p.position] : p.position === state.filters.position);
    });

    var searchActive = state.searchText.trim() !== '';
    var statusFiltered;
    if (searchActive) {
      statusFiltered = positionFiltered.filter(function (p) {
        return matchesSearch(p, state.searchText);
      });
    } else {
      statusFiltered = positionFiltered.filter(function (p) {
        var mark = state.marks[p.id];
        switch (state.filters.status) {
          case 'AVAILABLE':
            return !mark.drafted;
          case 'TARGETS':
            return mark.target && !mark.drafted;
          case 'AVOID':
            return mark.avoid && !mark.drafted;
          case 'DRAFTED':
            return mark.drafted;
          case 'MINE':
            return mark.drafted && mark.mine;
          default:
            return true;
        }
      });
    }

    return statusFiltered.map(function (p) {
      return Object.assign({}, p, state.marks[p.id]);
    });
  }

  /**
   * @param {State} state
   * @returns {{QB:number, RB:number, WR:number, TE:number, DST:number, K:number}}
   */
  function availableCountsByPosition(state) {
    var counts = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0, K: 0 };
    state.players.forEach(function (p) {
      if (!state.marks[p.id].drafted) {
        counts[p.position]++;
      }
    });
    return counts;
  }

  /**
   * @param {State} state
   * @returns {{QB:number, RB:number, WR:number, TE:number, DST:number, K:number}}
   */
  function myRosterCounts(state) {
    var counts = { QB: 0, RB: 0, WR: 0, TE: 0, DST: 0, K: 0 };
    state.players.forEach(function (p) {
      var m = state.marks[p.id];
      if (m && m.drafted && m.mine) {
        counts[p.position]++;
      }
    });
    return counts;
  }

  /**
   * @param {State} state
   * @param {string} playerId
   * @returns {number|null}
   */
  function pickNumber(state, playerId) {
    for (var i = 0; i < state.undoStack.length; i++) {
      if (state.undoStack[i].playerId === playerId) {
        return i + 1;
      }
    }
    return null;
  }

  // ---- board-signal selectors (pure; scan-only, no .sort()) ------------------------------

  // module-private: overall pick number for round r under this league's slot/snake config
  function overallPickFor(league, r) {
    var slot = (league.snake && r % 2 === 0) ? (league.size - league.slot + 1) : league.slot;
    return (r - 1) * league.size + slot;
  }

  // module-private: count of players marked drafted; guard covers pre-heal state
  function draftedCount(state) {
    var n = 0;
    state.players.forEach(function (p) {
      var m = state.marks[p.id];
      if (m && m.drafted) { n++; }
    });
    return n;
  }

  /**
   * @param {State} state
   * @returns {null|{picksMade:number, currentPick:number, round:number, pickInRound:number, myNextPick:number, picksUntilMine:number, isMyPick:boolean}}
   */
  function pickMath(state) {
    if (!state.league) {
      return null;
    }
    var N = state.league.size;

    var picksMade = draftedCount(state);
    var currentPick = picksMade + 1;
    var round = Math.floor(picksMade / N) + 1;
    var pickInRound = (picksMade % N) + 1;

    var r = round;
    var myNextPick = overallPickFor(state.league, r);
    var guard = 0;
    while (myNextPick < currentPick && guard < 1000) {
      r++;
      myNextPick = overallPickFor(state.league, r);
      guard++;
    }
    var picksUntilMine = myNextPick - currentPick;

    return {
      picksMade: picksMade,
      currentPick: currentPick,
      round: round,
      pickInRound: pickInRound,
      myNextPick: myNextPick,
      picksUntilMine: picksUntilMine,
      isMyPick: picksUntilMine === 0
    };
  }

  /**
   * @param {State} state
   * @returns {Object<string, boolean>} ids of AVAILABLE players who are the sole available member of their (position, tier) group
   */
  function lastInTierIds(state) {
    var counts = {};
    state.players.forEach(function (p) {
      if (p.tier === null || p.tier === undefined) {
        return;
      }
      var m = state.marks[p.id];
      if (m && m.drafted) {
        return;
      }
      var key = p.position + '|' + p.tier;
      counts[key] = (counts[key] || 0) + 1;
    });

    var result = {};
    state.players.forEach(function (p) {
      if (p.tier === null || p.tier === undefined) {
        return;
      }
      var m = state.marks[p.id];
      if (m && m.drafted) {
        return;
      }
      var key = p.position + '|' + p.tier;
      if (counts[key] === 1) {
        result[p.id] = true;
      }
    });
    return result;
  }

  /**
   * @param {State} state
   * @returns {Object<string, boolean>} league-free: available ids drifting >= VALUE_DRIFT_MIN past current pick, consensus ADP <= VALUE_RANK_CEILING
   */
  function valueFlagIds(state) {
    var picksMade = draftedCount(state);
    var currentPick = picksMade + 1;

    var result = {};
    state.players.forEach(function (p) {
      var m = state.marks[p.id];
      if (m && m.drafted) {
        return;
      }
      var consensus = adpConsensus(p);
      if (consensus === null) {
        return;
      }
      if ((currentPick - consensus) >= VALUE_DRIFT_MIN && consensus <= VALUE_RANK_CEILING) {
        result[p.id] = true;
      }
    });
    return result;
  }

  /**
   * @param {State} state
   * @returns {Object<string, number>} playerId -> 1-based rank within its own position, in board order
   */
  // third copy of the per-position counter algorithm — lockstep with edit.js:81-91 (single-id
  // lookup over staged order) and edit.js:674-691 (bulk over staged order); those work on edit
  // mode's staged closure copy and can't be shared with this pass over committed state.players.
  function positionRanks(state) {
    var counters = {};
    var result = {};
    state.players.forEach(function (p) {
      counters[p.position] = (counters[p.position] || 0) + 1;
      result[p.id] = counters[p.position];
    });
    return result;
  }

  /**
   * @param {State} state
   * @returns {null|Array<{playerId:string, slot:('QB'|'RB'|'WR'|'TE'|'FLEX'|'DST'|'K'|'BENCH')}>} one entry per mine pick, in undoStack order
   */
  function fillAssignments(state) {
    if (!state.league || !state.league.roster) {
      return null;
    }
    var req = state.league.roster;
    var filled = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BENCH: 0 };
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });

    var result = [];
    state.undoStack.forEach(function (entry) {
      var mark = state.marks[entry.playerId];
      if (!mark || !mark.mine) {
        return;
      }
      var player = byId[entry.playerId];
      if (!player) {
        return;
      }
      var pos = player.position;
      var slot;
      if (filled[pos] < req[pos]) {
        filled[pos]++;
        slot = pos;
      } else if (FLEX_ELIGIBLE[pos] && filled.FLEX < req.FLEX) {
        filled.FLEX++;
        slot = 'FLEX';
      } else {
        filled.BENCH++;
        slot = 'BENCH';
      }
      result.push({ playerId: entry.playerId, slot: slot });
    });
    return result;
  }

  /**
   * @param {State} state
   * @returns {null|{QB:{filled:number,req:number}, RB:{filled:number,req:number}, WR:{filled:number,req:number}, TE:{filled:number,req:number}, FLEX:{filled:number,req:number}, DST:{filled:number,req:number}, K:{filled:number,req:number}, BENCH:{filled:number}}}
   */
  function rosterNeeds(state) {
    if (!state.league || !state.league.roster) {
      return null;
    }
    var req = state.league.roster;
    var filled = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DST: 0, K: 0, BENCH: 0 };
    fillAssignments(state).forEach(function (a) { filled[a.slot]++; });

    return {
      QB: { filled: filled.QB, req: req.QB },
      RB: { filled: filled.RB, req: req.RB },
      WR: { filled: filled.WR, req: req.WR },
      TE: { filled: filled.TE, req: req.TE },
      FLEX: { filled: filled.FLEX, req: req.FLEX },
      DST: { filled: filled.DST, req: req.DST },
      K: { filled: filled.K, req: req.K },
      BENCH: { filled: filled.BENCH }
    };
  }

  /**
   * @param {State} state
   * @returns {null|Array<{slot:string, player:(Player|null)}>} ordered slot-tile board, template in canonical Order A, bench overflow appended
   */
  function rosterBoard(state) {
    if (!state.league || !state.league.roster) {
      return null;
    }
    var req = state.league.roster;
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });

    var tiles = [];
    ROSTER_KEYS.forEach(function (key) {
      var count = key === 'BENCH' ? req.BENCH : req[key];
      for (var i = 0; i < count; i++) {
        tiles.push({ slot: key, player: null });
      }
    });

    fillAssignments(state).forEach(function (a) {
      var player = byId[a.playerId];
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i].slot === a.slot && tiles[i].player === null) {
          tiles[i].player = player;
          return;
        }
      }
      tiles.push({ slot: a.slot, player: player }); // bench overflow — never hide a pick
    });

    return tiles;
  }

  /**
   * @param {State} state
   * @returns {{current:number, next:(number|null), following:(number|null)}}
   */
  function upcomingPicks(state) {
    if (!state.league) {
      return { current: draftedCount(state) + 1, next: null, following: null };
    }

    var pm = pickMath(state);
    var current = pm.currentPick;
    var next = pm.myNextPick;

    var r = pm.round;
    var guard = 0;
    while (overallPickFor(state.league, r) <= next && guard < 1000) {
      r++;
      guard++;
    }
    var following = overallPickFor(state.league, r);

    return { current: current, next: next, following: following };
  }

  /** @param {*} s @returns {string} lowercase, diacritic-free, no punctuation, one trailing generational suffix dropped */
  function normalizeAdpName(s) {
    var n = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    n = n.replace(/\s+(jr|sr|ii|iii|iv|v)\.?\s*$/, '');
    return n.replace(/[^a-z0-9]+/g, '');
  }

  /** @param {*} player @returns {string|null} sidecar join key; null when the player can't be keyed */
  function adpKey(player) {
    if (!player || typeof player.name !== 'string' || typeof player.team !== 'string' || typeof player.position !== 'string') {
      return null;
    }
    if (player.position === 'DST') {
      return player.team.toLowerCase() + '|dst';
    }
    return normalizeAdpName(player.name) + '|' + player.position.toLowerCase();
  }

  var adpOverride = null; // in-app Sleeper+ESPN refresh overlay; live-read like DC.adpData, reloaded via reloadAdpOverride()

  /** @returns {{updatedAt:string, players:Object}|null} parses ADP_OVERRIDE_KEY; any parse/shape failure clears the key and returns null */
  function readAdpOverride() {
    var raw;
    try {
      raw = localStorage.getItem(ADP_OVERRIDE_KEY);
    } catch (e) {
      return null;
    }
    if (raw === null) {
      return null;
    }
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          typeof parsed.updatedAt !== 'string' ||
          !parsed.players || typeof parsed.players !== 'object' || Array.isArray(parsed.players)) {
        throw new Error('bad shape');
      }
      return parsed;
    } catch (e) {
      try { localStorage.removeItem(ADP_OVERRIDE_KEY); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  adpOverride = readAdpOverride();

  /** @returns {{updatedAt:string, players:Object}|null} re-reads ADP_OVERRIDE_KEY into module state; call after writing/clearing the override */
  function reloadAdpOverride() {
    adpOverride = readAdpOverride();
    return adpOverride;
  }

  /** @param {*} player @returns {Object|null} sidecar+override merge first; player.adp fallback is the fixture/legacy seam. espn/sleeper are override-eligible; flock/underdog are shipped-only (the refresh override layer never carries them) */
  function adpForPlayer(player) {
    var table = window.DC && DC.adpData && DC.adpData.players;
    var key = adpKey(player);
    var shipped = table && key ? table[key] : undefined;
    var over = adpOverride && adpOverride.players && key ? adpOverride.players[key] : undefined;
    var merged = over || shipped ? {
      espn: over && isAdpNum(over.espn) ? over.espn : (shipped ? shipped.espn : undefined),
      flock: shipped ? shipped.flock : undefined,
      sleeper: over && isAdpNum(over.sleeper) ? over.sleeper : (shipped ? shipped.sleeper : undefined),
      underdog: shipped ? shipped.underdog : undefined
    } : undefined;
    var hit;
    if (merged) {
      hit = {};
      if (isAdpNum(merged.espn)) { hit.espn = merged.espn; }
      if (isAdpNum(merged.flock)) { hit.flock = merged.flock; }
      if (isAdpNum(merged.sleeper)) { hit.sleeper = merged.sleeper; }
      if (isAdpNum(merged.underdog)) { hit.underdog = merged.underdog; }
      if (Object.keys(hit).length === 0) { hit = undefined; }
    }
    return hit || (player && player.adp) || null;
  }

  /** @returns {string|null} live read: override date wins when present, else DC.adpData's, else null */
  function adpUpdatedAt() {
    return adpOverride ? adpOverride.updatedAt : (DC.adpData ? DC.adpData.updatedAt : null);
  }

  var ADP_WEIGHTS = { flock: 0.30, sleeper: 0.30, underdog: 0.25, espn: 0.15 }; // user-chosen blend; flock = expert consensus

  /**
   * @param {Player} player
   * @returns {number|null}
   */
  function adpConsensus(player) {
    var adp = adpForPlayer(player);
    if (!adp) { return null; }
    var sum = 0, wsum = 0;
    var sites = ['flock', 'sleeper', 'underdog', 'espn'];
    for (var i = 0; i < sites.length; i++) {
      if (isAdpNum(adp[sites[i]])) { sum += ADP_WEIGHTS[sites[i]] * adp[sites[i]]; wsum += ADP_WEIGHTS[sites[i]]; }
    }
    return wsum > 0 ? Math.round((sum / wsum) * 10) / 10 : null;
  }

  // full position line set required for a projection; partial data yields null, never a partial sum
  var DK_REQUIRED_COMPONENTS = {
    QB: ['passYds', 'passTds', 'rushYds', 'rushTds'],
    RB: ['rushYds', 'rushTds', 'rec', 'recYds', 'recTds'],
    WR: ['rec', 'recYds', 'recTds'],
    TE: ['rec', 'recYds', 'recTds']
  };

  /** @param {*} n @returns {boolean} */
  function isDkNum(n) {
    return typeof n === 'number' && isFinite(n);
  }

  /** @param {*} player @returns {number|null} live DK-line-implied fantasy points; null when player is ungated, unkeyed, or missing any required component */
  function dkProjForPlayer(player) {
    if (!player || typeof player !== 'object' || typeof player.name !== 'string' || typeof player.position !== 'string') {
      return null;
    }
    var required = DK_REQUIRED_COMPONENTS[player.position];
    if (!required) {
      return null;
    }
    var table = window.DC && DC.dkData && DC.dkData.players;
    var key = normalizeAdpName(player.name);
    var entry = table && key ? table[key] : undefined;
    if (!entry) {
      return null;
    }
    for (var r = 0; r < required.length; r++) {
      if (!isDkNum(entry[required[r]])) {
        return null;
      }
    }
    var sum = 0;
    if (isDkNum(entry.passYds)) { sum += entry.passYds / 25; }
    if (isDkNum(entry.passTds)) { sum += entry.passTds * 4; }
    if (isDkNum(entry.rushYds)) { sum += entry.rushYds / 10; }
    if (isDkNum(entry.rushTds)) { sum += entry.rushTds * 6; }
    if (isDkNum(entry.rec)) { sum += entry.rec * 1; }
    if (isDkNum(entry.recYds)) { sum += entry.recYds / 10; }
    if (isDkNum(entry.recTds)) { sum += entry.recTds * 6; }
    return Math.round(sum);
  }

  /** @returns {string|null} live read: DK sidecar's updatedAt, else null */
  function dkUpdatedAt() {
    return (window.DC && DC.dkData && DC.dkData.updatedAt) || null;
  }

  function isValidState(obj) {
    if (!obj || typeof obj !== 'object') {
      return false;
    }
    if (typeof obj.schemaVersion !== 'number') {
      return false;
    }
    if (!Array.isArray(obj.players) || obj.players.length < 1) {
      return false;
    }
    for (var i = 0; i < obj.players.length; i++) {
      var p = obj.players[i];
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.team !== 'string') {
        return false;
      }
      if (typeof p.rank !== 'number' || typeof p.byeWeek !== 'number') {
        return false;
      }
      if (!VALID_POSITIONS[p.position]) {
        return false;
      }
    }
    if (typeof obj.marks !== 'object' || obj.marks === null || Array.isArray(obj.marks)) {
      return false;
    }
    if (!Array.isArray(obj.undoStack)) {
      return false;
    }
    if (typeof obj.filters !== 'object' || obj.filters === null) {
      return false;
    }
    if (!VALID_POSITIONS[obj.filters.position] && obj.filters.position !== 'ALL' && obj.filters.position !== 'FLEX') {
      return false;
    }
    if (!VALID_STATUSES[obj.filters.status]) {
      return false;
    }
    if (typeof obj.searchText !== 'string') {
      return false;
    }
    return true;
  }

  /** @param {State} state */
  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // quota/privacy errors: swallow, app keeps working in-memory
    }
  }

  /**
   * Repairs (rather than discards) a structurally-valid-but-inconsistent state:
   * missing/invalid marks entries default to false, orphan marks/undoStack
   * entries for ids not in players are dropped, target/avoid exclusivity
   * is re-enforced, players are rebuilt in canonical key order with tier
   * healed, and a non-conforming league is healed to null. localStorage is
   * the only copy of a live draft, so a bad-shaped single field shouldn't
   * cost the whole draft.
   * @param {State} state
   * @returns {State}
   */
  function normalize(state) {
    var validIds = {};
    state.players.forEach(function (p) {
      validIds[p.id] = true;
    });

    var marks = {};
    state.players.forEach(function (p) {
      var m = state.marks[p.id];
      var drafted = m && typeof m.drafted === 'boolean' ? m.drafted : false;
      var target = m && typeof m.target === 'boolean' ? m.target : false;
      var avoid = m && typeof m.avoid === 'boolean' ? m.avoid : false;
      if (target && avoid) {
        avoid = false;
      }
      var mine = !!(m && m.drafted === true && m.mine === true);
      marks[p.id] = { drafted: drafted, target: target, avoid: avoid, mine: mine };
    });

    var undoStack = state.undoStack.filter(function (e) {
      return e && typeof e.playerId === 'string' && validIds[e.playerId];
    });

    return {
      schemaVersion: state.schemaVersion,
      players: normalizeTiers(healPlayers(state.players)),
      marks: marks,
      undoStack: undoStack,
      filters: state.filters,
      searchText: state.searchText,
      manuallyEdited: (typeof state.manuallyEdited === 'boolean' ? state.manuallyEdited : false),
      league: healLeague(state.league)
    };
  }

  /** @returns {State} */
  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return createSeedState();
    }
    if (raw === null) {
      return createSeedState();
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return createSeedState();
    }

    // belt-and-suspenders: isValidState/migrate/normalize are defensive but a poisoned
    // payload should never crash-loop the boot even if one of them has a gap - fall back to seed.
    try {
      if (!parsed || typeof parsed.schemaVersion !== 'number') {
        return createSeedState();
      }

      if (parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
        return createSeedState();
      }

      var initialVersion = parsed.schemaVersion;
      var version = initialVersion;
      while (version < CURRENT_SCHEMA_VERSION) {
        var migrate = migrations[version];
        if (typeof migrate !== 'function') {
          return createSeedState();
        }
        parsed = migrate(parsed);
        version++;
      }

      if (!isValidState(parsed)) {
        return createSeedState();
      }

      var result = normalize(parsed);
      if (version !== initialVersion) {
        // migration ran: persist the upgraded shape now instead of waiting for the next dispatch
        save(result);
      }
      return result;
    } catch (e) {
      return createSeedState();
    }
  }

  /**
   * @param {State} initialState
   * @returns {{getState: function(): State, dispatch: function(*): void, subscribe: function(function(State): void): function(): void}}
   */
  function createStore(initialState) {
    var state = initialState;
    var listeners = [];

    function getState() {
      return state;
    }

    function dispatch(action) {
      var next = reduce(state, action);
      if (next !== state) {
        state = next;
        save(state);
        listeners.forEach(function (listener) {
          listener(state);
        });
      }
    }

    function subscribe(listener) {
      listeners.push(listener);
      return function unsubscribe() {
        var idx = listeners.indexOf(listener);
        if (idx !== -1) {
          listeners.splice(idx, 1);
        }
      };
    }

    return { getState: getState, dispatch: dispatch, subscribe: subscribe };
  }

  DC.state = {
    CURRENT_SCHEMA_VERSION: CURRENT_SCHEMA_VERSION,
    STORAGE_KEY: STORAGE_KEY,
    VALUE_DRIFT_MIN: VALUE_DRIFT_MIN,
    VALUE_RANK_CEILING: VALUE_RANK_CEILING,
    DEFAULT_ROSTER: DEFAULT_ROSTER,
    createSeedState: createSeedState,
    reduce: reduce,
    createStore: createStore,
    load: load,
    save: save,
    visiblePlayers: visiblePlayers,
    availableCountsByPosition: availableCountsByPosition,
    myRosterCounts: myRosterCounts,
    pickNumber: pickNumber,
    matchesSearch: matchesSearch,
    clampTierAt: clampTierAt,
    normalizeTiers: normalizeTiers,
    stepperBounds: stepperBounds,
    tierBreakBefore: tierBreakBefore,
    tierColorClass: tierColorClass,
    pickMath: pickMath,
    lastInTierIds: lastInTierIds,
    valueFlagIds: valueFlagIds,
    rosterNeeds: rosterNeeds,
    positionRanks: positionRanks,
    fillAssignments: fillAssignments,
    rosterBoard: rosterBoard,
    upcomingPicks: upcomingPicks,
    adpConsensus: adpConsensus,
    normalizeAdpName: normalizeAdpName,
    adpKey: adpKey,
    adpForPlayer: adpForPlayer,
    reloadAdpOverride: reloadAdpOverride,
    adpUpdatedAt: adpUpdatedAt,
    ADP_OVERRIDE_KEY: ADP_OVERRIDE_KEY,
    dkProjForPlayer: dkProjForPlayer,
    dkUpdatedAt: dkUpdatedAt
  };
})();
