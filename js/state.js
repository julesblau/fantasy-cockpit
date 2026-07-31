(function () {
  'use strict';
  window.DC = window.DC || {};

  /** @typedef {"QB"|"RB"|"WR"|"TE"} Position */
  /** @typedef {{id:string, rank:number, name:string, team:string, position:Position, byeWeek:number}} Player */
  /** @typedef {{drafted:boolean, target:boolean, avoid:boolean, mine:boolean}} Marks */
  /** @typedef {{playerId:string, timestamp:number}} UndoEntry */
  /** @typedef {{position:("ALL"|Position), status:("AVAILABLE"|"TARGETS"|"AVOID"|"DRAFTED"|"MINE")}} Filters */
  /**
   * @typedef {{
   *   schemaVersion: 3,
   *   players: Player[],
   *   marks: Object<string, Marks>,
   *   undoStack: UndoEntry[],
   *   filters: Filters,
   *   searchText: string,
   *   manuallyEdited: boolean
   * }} State
   */

  var CURRENT_SCHEMA_VERSION = 3;
  var STORAGE_KEY = 'draft-cockpit/state';
  var VALID_POSITIONS = { QB: true, RB: true, WR: true, TE: true };
  var VALID_STATUSES = { AVAILABLE: true, TARGETS: true, AVOID: true, DRAFTED: true, MINE: true };

  /** @type {Object<number, function(*): State>} old-version-number -> upgrader to next version */
  var migrations = {};

  migrations[1] = function (v1) {
    return { schemaVersion: 2, players: v1.players, marks: v1.marks, undoStack: v1.undoStack,
             filters: v1.filters, searchText: v1.searchText, manuallyEdited: false };
  };

  // pure pass-through: stamps schemaVersion itself, iterates nothing (mine healing is normalizeMarks' job)
  migrations[2] = function (v2) {
    return { schemaVersion: 3, players: v2.players, marks: v2.marks, undoStack: v2.undoStack,
             filters: v2.filters, searchText: v2.searchText, manuallyEdited: v2.manuallyEdited };
  };

  /** @returns {State} */
  function createSeedState() {
    var players = DC.data.SEED_PLAYERS;
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
      manuallyEdited: false
    };
  }

  function setMark(state, playerId, patch) {
    var nextMarks = Object.assign({}, state.marks);
    nextMarks[playerId] = Object.assign({}, nextMarks[playerId], patch);
    return Object.assign({}, state, { marks: nextMarks });
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
        var newPlayers = action.players;
        var newMarks = {};
        newPlayers.forEach(function (p) {
          newMarks[p.id] = state.marks[p.id] || { drafted: false, target: false, avoid: false };
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
          manuallyEdited: false
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
        return Object.assign({}, state, { players: reordered, manuallyEdited: true });
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
      return state.filters.position === 'ALL' || p.position === state.filters.position;
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
   * @returns {{QB:number, RB:number, WR:number, TE:number}}
   */
  function availableCountsByPosition(state) {
    var counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    state.players.forEach(function (p) {
      if (!state.marks[p.id].drafted) {
        counts[p.position]++;
      }
    });
    return counts;
  }

  /**
   * @param {State} state
   * @returns {{QB:number, RB:number, WR:number, TE:number}}
   */
  function myRosterCounts(state) {
    var counts = { QB: 0, RB: 0, WR: 0, TE: 0 };
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
    if (!VALID_POSITIONS[obj.filters.position] && obj.filters.position !== 'ALL') {
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
   * is re-enforced. localStorage is the only copy of a live draft, so a
   * bad-shaped single mark shouldn't cost the whole draft.
   * @param {State} state
   * @returns {State}
   */
  function normalizeMarks(state) {
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
      players: state.players,
      marks: marks,
      undoStack: undoStack,
      filters: state.filters,
      searchText: state.searchText,
      manuallyEdited: (typeof state.manuallyEdited === 'boolean' ? state.manuallyEdited : false)
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

    // belt-and-suspenders: isValidState/migrate/normalizeMarks are defensive but a poisoned
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

      var result = normalizeMarks(parsed);
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
    createSeedState: createSeedState,
    reduce: reduce,
    createStore: createStore,
    load: load,
    save: save,
    visiblePlayers: visiblePlayers,
    availableCountsByPosition: availableCountsByPosition,
    myRosterCounts: myRosterCounts,
    pickNumber: pickNumber,
    matchesSearch: matchesSearch
  };
})();
