(function () {
  'use strict';
  window.DC = window.DC || {};

  var MIDDOT = '·';
  var EMDASH = '—';
  var ARROW = '→';
  var STAR_GLYPH = '★';
  var NDASH_BYE = '—';
  var LONG_PRESS_MS = 500;

  var STATUS_LABELS = { AVAILABLE: 'Available', TARGETS: 'Targets', AVOID: 'Avoid', DRAFTED: 'Drafted' };
  var POSITIONS = ['QB', 'RB', 'WR', 'TE'];

  // signal tag priority order: VALUE > CLIFF, max 2 rendered (vacuous now but kept for future signals)
  var SIGNAL_DEFS = [
    ['value', 'sig-value', 'VALUE'],
    ['cliff', 'sig-cliff', 'CLIFF']
  ];

  var LEAGUE_SIZE_MIN = 4;
  var LEAGUE_SIZE_MAX = 20;
  var LEAGUE_ROSTER_MIN = 0;
  var LEAGUE_ROSTER_MAX = 12;
  var LEAGUE_ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BENCH'];
  var DEFAULT_LEAGUE = { size: 12, slot: 1, snake: true, roster: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, BENCH: 6 } };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---- icons ---------------------------------------------------------------

  var ICON_BODIES = {
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
    x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    search: '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
    'search-slash': '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="5" y1="17" x2="17" y2="5"></line>',
    undo: '<path d="M3 11a8 8 0 1 1 2.34 5.66"></path><polyline points="3 5 3 11 9 11"></polyline>',
    gear: '<circle cx="12" cy="12" r="3"></circle><line x1="12" y1="2" x2="12" y2="5"></line><line x1="12" y1="19" x2="12" y2="22"></line><line x1="2" y1="12" x2="5" y2="12"></line><line x1="19" y1="12" x2="22" y2="12"></line><line x1="4.9" y1="4.9" x2="7" y2="7"></line><line x1="17" y1="17" x2="19.1" y2="19.1"></line><line x1="4.9" y1="19.1" x2="7" y2="17"></line><line x1="17" y1="7" x2="19.1" y2="4.9"></line>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"></path><path d="M8 5H5a2 2 0 0 0 0 4h2"></path><path d="M16 5h3a2 2 0 0 1 0 4h-2"></path><line x1="12" y1="13" x2="12" y2="17"></line><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>'
  };

  /** @param {string} name @param {number} [size] pixel width/height, default 20 */
  function icon(name, size) {
    var px = size || 20;
    if (name === 'star-filled') {
      return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON_BODIES.star + '</svg>';
    }
    var body = ICON_BODIES[name];
    if (!body) {
      return '';
    }
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

  // ---- pure templates --------------------------------------------------------

  function metaLine(view) {
    var bye = view.byeWeek === 0 ? NDASH_BYE : String(view.byeWeek);
    return esc(view.team) + ' ' + MIDDOT + ' ' + esc(view.position) + ' ' + MIDDOT + ' Bye ' + bye;
  }

  /**
   * @param {string} playerId
   * @param {{value:Object, cliff:Object}} [signals] id->true maps (DC.state.valueFlagIds/
   *   lastInTierIds), computed ONCE per render — never call the selectors per row. Unrecognized
   *   keys (e.g. a stray 'gone') are silently ignored — only keys in SIGNAL_DEFS are read.
   * @returns {string} up to 2 .sig-tag spans, priority VALUE > CLIFF; '' when none/absent
   */
  function signalTagsHTML(playerId, signals) {
    if (!signals) {
      return '';
    }
    var tags = [];
    for (var i = 0; i < SIGNAL_DEFS.length && tags.length < 2; i++) {
      var def = SIGNAL_DEFS[i];
      var set = signals[def[0]];
      if (set && set[playerId]) {
        tags.push('<span class="sig-tag ' + def[1] + '">' + def[2] + '</span>');
      }
    }
    return tags.length ? '<div class="signal-tags">' + tags.join('') + '</div>' : '';
  }

  // duplicated per the esc() precedent — not exported from state, not shared with edit.js
  function tierChipHTML(tier) {
    var cls = DC.state.tierColorClass(tier);
    return cls ? '<span class="tier-chip ' + cls + '">T' + tier + '</span>' : '';
  }

  /** @param {{signals:*}} [ctx] */
  function availableRowHTML(view, ctx) {
    ctx = ctx || {};
    var rowClasses = ['player-row'];
    if (view.target) {
      rowClasses.push('is-target');
    }
    if (view.avoid) {
      rowClasses.push('is-avoid');
    }
    var starClass = 'btn-toggle' + (view.target ? ' on-target' : '');
    var starIcon = view.target ? icon('star-filled') : icon('star');
    var xClass = 'btn-toggle' + (view.avoid ? ' on-avoid' : '');
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        '<div class="player-rank">' + view.rank + '</div>' +
        '<div class="player-info">' +
          '<div class="player-name"><span class="name-text">' + esc(view.name) + '</span>' + tierChipHTML(view.tier) + '</div>' +
          '<div class="player-meta">' + metaLine(view) + '</div>' +
          signalTagsHTML(view.id, ctx.signals) +
        '</div>' +
        '<button class="' + starClass + '" data-action="toggle-target" data-id="' + esc(view.id) + '">' + starIcon + '</button>' +
        '<button class="' + xClass + '" data-action="toggle-avoid" data-id="' + esc(view.id) + '">' + icon('x') + '</button>' +
        '<button class="btn-draft" data-action="draft" data-id="' + esc(view.id) + '">DRAFT</button>' +
      '</div>'
    );
  }

  function draftedSearchRowHTML(view) {
    var rowClasses = ['player-row', 'is-drafted-search'];
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        '<div class="player-rank">' + view.rank + '</div>' +
        '<div class="player-info">' +
          '<div class="player-name"><span class="name-text">' + esc(view.name) + '</span>' + tierChipHTML(view.tier) + '</div>' +
          '<div class="player-meta">' + metaLine(view) + '</div>' +
        '</div>' +
        '<span class="drafted-pill">DRAFTED</span>' +
      '</div>'
    );
  }

  /** @param {{pickNumber:(number|null)}} [ctx] */
  function draftedRowHTML(view, ctx) {
    ctx = ctx || {};
    var pickText = typeof ctx.pickNumber === 'number' ? ctx.pickNumber : EMDASH;
    var rowClasses = ['player-row'];
    if (view.mine) {
      rowClasses.push('is-mine');
    }
    var mineToggleClass = 'btn-toggle' + (view.mine ? ' on-mine' : '');
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        '<div class="player-rank">' + view.rank + '</div>' +
        '<div class="player-info">' +
          '<div class="player-name">' +
            '<span style="display:inline-flex;width:16px;height:16px;align-self:center;color:var(--accent-draft)">' + icon('check', 16) + '</span>' +
            '<span class="name-text">' + esc(view.name) + '</span>' + tierChipHTML(view.tier) +
          '</div>' +
          '<div class="player-meta">' + metaLine(view) + '</div>' +
        '</div>' +
        '<span class="pick-badge">Pick ' + pickText + '</span>' +
        '<button class="' + mineToggleClass + '" data-action="toggle-mine" data-id="' + esc(view.id) + '">' + icon('user') + '</button>' +
        '<button class="btn-undraft" data-action="undraft" data-id="' + esc(view.id) + '">UNDO</button>' +
      '</div>'
    );
  }

  /**
   * @param {Object} view player + marks (id, rank, name, team, position, byeWeek, tier, drafted, target, avoid)
   * @param {{searching:boolean, statusFilter:string, pickNumber:(number|null), signals:*}} ctx
   */
  function playerRowHTML(view, ctx) {
    ctx = ctx || {};
    if (view.drafted) {
      if (ctx.searching) {
        return draftedSearchRowHTML(view);
      }
      return draftedRowHTML(view, ctx);
    }
    return availableRowHTML(view, ctx);
  }

  /**
   * @param {{QB:number, RB:number, WR:number, TE:number}} counts
   * @param {string} positionFilter
   */
  function statsStripHTML(counts, positionFilter) {
    var items = POSITIONS.map(function (pos) {
      var active = positionFilter === pos ? ' active' : '';
      return (
        '<button class="stat' + active + '" data-action="set-position" data-position="' + pos + '">' +
          '<span class="stat-count">' + (counts[pos] || 0) + '</span>' +
          '<span class="stat-label">' + pos + '</span>' +
        '</button>'
      );
    });
    return '<div class="stats-strip">' + items.join('') + '</div>';
  }

  /** @param {{round:number, currentPick:number, picksUntilMine:number, isMyPick:boolean}} pm non-null DC.state.pickMath(state) result */
  function trackerStripHTML(pm) {
    if (pm.isMyPick) {
      return '<div class="tracker-strip">' + "You're up " + EMDASH + ' R' + pm.round + ', Pick ' + pm.currentPick + '</div>';
    }
    return '<div class="tracker-strip">R' + pm.round + ' ' + MIDDOT + ' Pick ' + pm.currentPick + ' ' + MIDDOT + ' ' + pm.picksUntilMine + ' until you</div>';
  }

  var POSITION_CHIPS = [['ALL', 'All'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']];

  /** @param {{position:string, status:string}} filters */
  function chipsHTML(filters) {
    var positionRow = '<div class="chip-row">' + POSITION_CHIPS.map(function (pair) {
      var val = pair[0];
      var label = pair[1];
      var active = filters.position === val ? ' active-position' : '';
      return '<button class="chip' + active + '" data-action="set-position" data-position="' + val + '">' + label + '</button>';
    }).join('') + '</div>';

    var statusRow = '<div class="chip-row">' +
      '<button class="chip' + (filters.status === 'TARGETS' ? ' active-target' : '') + '" data-action="set-status" data-status="TARGETS">' + icon('star') + ' Targets</button>' +
      '<button class="chip' + (filters.status === 'AVOID' ? ' active-avoid' : '') + '" data-action="set-status" data-status="AVOID">' + icon('x') + ' Avoid</button>' +
      '<button class="chip' + (filters.status === 'DRAFTED' ? ' active-drafted' : '') + '" data-action="set-status" data-status="DRAFTED">' + icon('check') + ' Drafted</button>' +
      '<button class="chip' + (filters.status === 'MINE' ? ' active-mine' : '') + '" data-action="set-status" data-status="MINE">' + icon('user') + ' Mine</button>' +
    '</div>';

    return positionRow + statusRow;
  }

  /**
   * @param {{filters:{position:string, status:string}, searchText:string}} state
   * @param {number} visibleCount
   */
  function summaryHTML(state, visibleCount) {
    var filters = state.filters || {};
    var posLabel = (!filters.position || filters.position === 'ALL') ? 'All positions' : filters.position;
    var searching = !!(state.searchText && state.searchText.trim() !== '');
    var statusHTML = searching
      ? '"' + esc(state.searchText) + '"'
      : esc(STATUS_LABELS[filters.status] || filters.status || '');
    var n = typeof visibleCount === 'number' ? visibleCount : 0;
    return '<div class="summary">' + esc(posLabel) + ' ' + MIDDOT + ' ' + statusHTML + ' ' + EMDASH + ' ' + n + ' players</div>';
  }

  /**
   * @param {?{QB:{filled:number,req:number}, RB:*, WR:*, TE:*, FLEX:*, BENCH:{filled:number}}} needs
   *   DC.state.rosterNeeds(state), or null when league is unset — drives the needs-line format
   * @param {{QB:number, RB:number, WR:number, TE:number}} counts DC.state.myRosterCounts(state) —
   *   used only in the fallback (needs===null) branch; total is summed HERE, never passed in, so a
   *   position-filtered caller can never under-count the real total (the R3 minor this replaces)
   */
  function rosterSummaryHTML(needs, counts) {
    if (needs) {
      var needParts = ['QB', 'RB', 'WR', 'TE', 'FLEX'].map(function (k) {
        return k + ' ' + needs[k].filled + '/' + needs[k].req;
      });
      return '<div class="summary">My roster ' + EMDASH + ' ' + needParts.join(' ' + MIDDOT + ' ') + ' ' + MIDDOT + ' Bench ' + needs.BENCH.filled + '</div>';
    }
    var total = POSITIONS.reduce(function (sum, pos) { return sum + (counts[pos] || 0); }, 0);
    var parts = POSITIONS.map(function (pos) {
      return pos + ' ' + (counts[pos] || 0);
    });
    var pickWord = total === 1 ? 'pick' : 'picks';
    return '<div class="summary">My roster ' + EMDASH + ' ' + parts.join(' ' + MIDDOT + ' ') + ' (' + total + ' ' + pickWord + ')</div>';
  }

  function emptyBody(iconName, title, sub, actionLabel, actionName) {
    var html = '<div class="empty">' +
      '<div style="display:inline-flex;width:40px;height:40px;opacity:0.5;margin-bottom:8px">' + icon(iconName, 40) + '</div>' +
      '<div class="empty-title">' + title + '</div>' +
      '<div class="empty-sub">' + sub + '</div>';
    if (actionLabel) {
      html += '<button class="empty-action" data-action="' + actionName + '">' + esc(actionLabel) + '</button>';
    }
    html += '</div>';
    return html;
  }

  /**
   * @param {"search"|"targets"|"drafted"|"combo"|"complete"} kind
   * @param {*} [detail] search: query string; combo: {status, position}
   */
  function emptyStateHTML(kind, detail) {
    switch (kind) {
      case 'search':
        return emptyBody('search-slash', 'No players match "' + esc(detail || '') + '"', 'Try a different name, team, or position', 'Clear search', 'clear-search');
      case 'targets':
        return emptyBody('star', 'No targets yet', 'Tap the ' + STAR_GLYPH + ' on any player to mark them as a target.', null, null);
      case 'drafted':
        return emptyBody('check', 'No picks yet', 'Players you draft will show up here.', null, null);
      case 'mine':
        return emptyBody('user', 'No picks of yours yet', "Long-press DRAFT when it's your turn, or tag your picks in the Drafted view.", null, null);
      case 'combo': {
        var status = (detail && detail.status) || '';
        var position = (detail && detail.position) || '';
        var noun = position ? esc(position) + 's' : 'players';
        return emptyBody('x', 'No ' + esc(status) + ' ' + noun, 'Adjust filters or check All.', 'Clear filters', 'clear-filters');
      }
      case 'complete':
        return emptyBody('trophy', 'Draft complete', 'All available players have been drafted.', null, null);
      default:
        return emptyBody('x', 'Nothing here', '', null, null);
    }
  }

  /** @param {{undoStack:Array, filters:{position:string, status:string}}} state */
  function bottomBarHTML(state) {
    var undoDisabled = !state.undoStack || state.undoStack.length === 0;
    var status = state.filters ? state.filters.status : '';
    return (
      '<div class="bar-items">' +
        '<button class="bar-item" data-action="focus-search">' + icon('search') + '<span>Search</span></button>' +
        '<button class="bar-item' + (status === 'TARGETS' ? ' active' : '') + '" data-action="set-status" data-status="TARGETS">' + icon('star') + '<span>Targets</span></button>' +
        '<div class="bar-item">' +
          '<button class="bar-undo" data-action="undo"' + (undoDisabled ? ' disabled' : '') + '>' + icon('undo') + '</button>' +
          '<span class="bar-undo-label">UNDO</span>' +
        '</div>' +
        '<button class="bar-item' + (status === 'DRAFTED' ? ' active' : '') + '" data-action="set-status" data-status="DRAFTED">' + icon('check') + '<span>Drafted</span></button>' +
        '<button class="bar-item" data-action="open-settings">' + icon('gear') + '<span>Settings</span></button>' +
      '</div>'
    );
  }

  /**
   * Pure decision for the backup-apply flow (Task 5 controller integration requirement):
   * a backup written by a newer schema version must not silently reach
   * DC.state.save + reload, since load() would then discard it back to seed.
   * @param {{schemaVersion:*}} backupState
   * @returns {{ok:true}|{ok:false, error:string}}
   */
  function backupApplyCheck(backupState) {
    if (backupState && typeof backupState.schemaVersion === 'number' &&
        backupState.schemaVersion >= 1 && backupState.schemaVersion % 1 === 0 &&
        backupState.schemaVersion <= DC.state.CURRENT_SCHEMA_VERSION) {
      return { ok: true };
    }
    return { ok: false, error: 'This backup is from a different app version.' };
  }

  /**
   * Pure decision for the import auto-backup interlock (Task 5): a manually
   * reordered board must be backed up before an import overwrites it.
   * @param {{manuallyEdited:*}} state
   * @returns {boolean}
   */
  function shouldAutoBackupBeforeImport(state) {
    return !!(state && state.manuallyEdited);
  }

  var templates = {
    playerRowHTML: playerRowHTML,
    signalTagsHTML: signalTagsHTML,
    trackerStripHTML: trackerStripHTML,
    statsStripHTML: statsStripHTML,
    chipsHTML: chipsHTML,
    summaryHTML: summaryHTML,
    rosterSummaryHTML: rosterSummaryHTML,
    emptyStateHTML: emptyStateHTML,
    bottomBarHTML: bottomBarHTML,
    backupApplyCheck: backupApplyCheck,
    shouldAutoBackupBeforeImport: shouldAutoBackupBeforeImport
  };

  // ---- league settings editors (imperative DOM in mount()'s sheet block; pure HTML builders) ----

  function cloneLeague(league) {
    return { size: league.size, slot: league.slot, snake: league.snake, roster: Object.assign({}, league.roster) };
  }

  function leagueStepperRowHTML(label, value, min, max, action, key) {
    var keyAttr = key ? ' data-key="' + esc(key) + '"' : '';
    return (
      '<div class="tier-stepper-row">' +
        '<span class="tier-stepper-label">' + esc(label) + '</span>' +
        '<button type="button" class="tier-step-btn" data-action="' + action + '" data-dir="-1"' + keyAttr + (value <= min ? ' disabled' : '') + '>−</button>' +
        '<span class="tier-stepper-value">' + value + '</span>' +
        '<button type="button" class="tier-step-btn" data-action="' + action + '" data-dir="1"' + keyAttr + (value >= max ? ' disabled' : '') + '>+</button>' +
      '</div>'
    );
  }

  /** @param {boolean} pendingApply true while editing a not-yet-applied setup draft (renders Apply, not Clear) */
  function leagueEditorsHTML(league, pendingApply) {
    var html = '';
    html += leagueStepperRowHTML('League size', league.size, LEAGUE_SIZE_MIN, LEAGUE_SIZE_MAX, 'league-size-step');
    html += leagueStepperRowHTML('Draft slot', league.slot, 1, league.size, 'league-slot-step');
    html +=
      '<div class="tier-stepper-row">' +
        '<span class="tier-stepper-label">Snake</span>' +
        '<button type="button" class="snake-toggle-btn" data-action="league-snake-toggle" aria-pressed="' + (league.snake ? 'true' : 'false') + '">' + (league.snake ? icon('check', 16) : '') + '</button>' +
      '</div>';
    LEAGUE_ROSTER_KEYS.forEach(function (key) {
      html += leagueStepperRowHTML(key, league.roster[key], LEAGUE_ROSTER_MIN, LEAGUE_ROSTER_MAX, 'league-roster-step', key);
    });
    html += pendingApply
      ? '<button type="button" class="sheet-row" data-action="league-apply">Apply</button>'
      : '<button type="button" class="sheet-row destructive" data-action="league-clear">Clear league setup</button>';
    return html;
  }

  // ---- mount / render (impure — DOM + store wiring) --------------------------

  function attrSelector(id) {
    return String(id).replace(/"/g, '\\"');
  }

  function mount(store) {
    var appEl = document.getElementById('app');
    var searchContainer = document.getElementById('search-container');
    var statsEl = document.getElementById('stats-strip');
    var trackerEl = document.getElementById('tracker-strip');
    var chipsEl = document.getElementById('filter-chips');
    var summaryEl = document.getElementById('summary-line');
    var listEl = document.getElementById('player-list');
    var undoBannerRoot = document.getElementById('undo-banner-root');
    var bottomBarEl = document.getElementById('bottom-bar');
    var sheetRoot = document.getElementById('sheet-root');

    // ---- static DOM, built once ----

    searchContainer.innerHTML =
      '<div class="search-bar">' +
        '<input type="text" class="search-input" placeholder="Search players by name, team, or position" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
        '<button class="search-clear" data-action="clear-search" aria-label="Clear search">' + icon('x') + '</button>' +
      '</div>';
    var searchInput = searchContainer.querySelector('.search-input');
    var searchClearBtn = searchContainer.querySelector('.search-clear');

    sheetRoot.innerHTML =
      '<div class="scrim" data-action="close-settings" hidden></div>' +
      '<div class="sheet" hidden>' +
        '<h2 class="sheet-title">Settings</h2>' +
        '<button class="sheet-row" data-action="reset-draft">Reset Draft</button>' +
        '<button class="sheet-row" data-action="reset-targets-avoid">Reset Targets/Avoid</button>' +
        '<button class="sheet-row destructive" data-action="clear-all-data">Clear All Data</button>' +
        '<button class="sheet-row" data-action="edit-rankings">Edit Rankings</button>' +
        '<button class="sheet-row" data-action="toggle-import">Import Rankings</button>' +
        '<div class="import-area" hidden>' +
          '<textarea class="import-textarea" placeholder="Paste rankings or a backup JSON file&#39;s contents here"></textarea>' +
          '<input type="file" class="import-file" accept=".csv,.txt,.tsv,.json">' +
          '<button class="sheet-row" data-action="import-parse">Parse</button>' +
          '<div class="import-preview"></div>' +
        '</div>' +
        '<button class="sheet-row" data-action="export">Export Backup</button>' +
        '<div class="sheet-note">Save this file somewhere safe ' + EMDASH + ' it restores via Import.</div>' +
        '<h3 class="sheet-section-title">League</h3>' +
        '<div class="league-section"></div>' +
        '<button class="sheet-row" data-action="close-settings">Done</button>' +
      '</div>';
    var sheetScrim = sheetRoot.querySelector('.scrim');
    var sheetEl = sheetRoot.querySelector('.sheet');
    var importArea = sheetRoot.querySelector('.import-area');
    var importTextarea = sheetRoot.querySelector('.import-textarea');
    var importFile = sheetRoot.querySelector('.import-file');
    var importPreviewEl = sheetRoot.querySelector('.import-preview');
    var leagueSectionEl = sheetRoot.querySelector('.league-section');

    var importPreviewState = null; // {kind:'rankings'|'backup', result} — lives here, not in the store
    var leagueSetupOpen = false; // UI-only: true while "Set up draft tracker" editors are expanded pre-Apply
    var leagueDraft = null; // League|null — uncommitted defaults being edited before Apply; never touches the store
    var undoBannerTimer = null;
    var lastFiltersKey = null;
    var lastSearchText = null;

    // ---- settings sheet helpers ----

    function openSettings() {
      sheetScrim.hidden = false;
      sheetEl.hidden = false;
    }

    function resetImportArea() {
      importTextarea.value = '';
      importFile.value = '';
      importArea.hidden = true;
      importPreviewState = null;
      importPreviewEl.innerHTML = '';
    }

    function closeSettings() {
      sheetScrim.hidden = true;
      sheetEl.hidden = true;
      disarmAllConfirmButtons(); // a pending two-tap confirm must not survive a sheet close
      resetImportArea();
      leagueSetupOpen = false; // closing discards an un-applied setup draft, same as the import area reset above
      leagueDraft = null;
      renderLeagueSection(store.getState());
    }

    function toggleImportArea() {
      importArea.hidden = !importArea.hidden;
    }

    // ---- league settings section (imperative; league-section is fully rebuilt every render()) ----

    function renderLeagueSection(state) {
      var league = state.league;
      if (!league && !leagueSetupOpen) {
        leagueSectionEl.innerHTML = '<button type="button" class="sheet-row" data-action="league-setup-open">Set up draft tracker</button>';
      } else {
        leagueSectionEl.innerHTML = leagueEditorsHTML(league || leagueDraft, !league);
      }
    }

    // patchFn mutates a clone in place and returns it; slot is re-clamped into [1,size] unconditionally
    // afterward regardless of which field changed — the strict SET_LEAGUE reducer requires a complete,
    // always-valid integer object, so every dispatch here is exactly one full League, never a partial patch.
    function updateLeagueDraftOrDispatch(patchFn) {
      var current = store.getState().league;
      if (current) {
        var next = patchFn(cloneLeague(current));
        next.slot = Math.max(1, Math.min(next.size, next.slot));
        store.dispatch({ type: 'SET_LEAGUE', league: next });
      } else if (leagueDraft) {
        leagueDraft = patchFn(cloneLeague(leagueDraft));
        leagueDraft.slot = Math.max(1, Math.min(leagueDraft.size, leagueDraft.slot));
        renderLeagueSection(store.getState());
      }
    }

    // ---- two-tap confirm (Reset Draft / Reset Targets-Avoid / Clear All Data / import Apply buttons) ----
    // Only one confirmable button may be armed at a time, and closing the sheet always
    // clears any pending arm — otherwise a stale "Tap again to confirm" state could fire
    // a destructive dispatch on a single, unconfirmed tap after the sheet is reopened.

    function clearArmTimer(btn) {
      if (btn._armTimer) {
        clearTimeout(btn._armTimer);
        btn._armTimer = null;
      }
    }

    function restoreLabel(btn) {
      var original = btn.getAttribute('data-original-label');
      if (original !== null) {
        btn.textContent = original;
      }
    }

    function disarmButton(btn) {
      clearArmTimer(btn);
      btn.removeAttribute('data-armed');
      restoreLabel(btn);
    }

    function disarmAllConfirmButtons() {
      var armed = sheetRoot.querySelectorAll('[data-armed]');
      for (var i = 0; i < armed.length; i++) {
        disarmButton(armed[i]);
      }
    }

    function armButton(btn) {
      disarmAllConfirmButtons(); // arming one disarms any other pending confirm
      if (!btn.hasAttribute('data-original-label')) {
        btn.setAttribute('data-original-label', btn.textContent);
      }
      btn.setAttribute('data-armed', '1');
      btn.textContent = 'Tap again to confirm';
      clearArmTimer(btn);
      btn._armTimer = setTimeout(function () {
        disarmButton(btn);
      }, 3000);
    }

    function confirmAction(btn, onConfirm) {
      if (btn.getAttribute('data-armed') === '1') {
        disarmButton(btn);
        onConfirm();
      } else {
        armButton(btn);
      }
    }

    // ---- import parse / preview / apply ----

    function showImportError(message) {
      importPreviewState = null;
      importPreviewEl.innerHTML = '<div class="sheet-note">' + esc(message) + '</div>';
    }

    function renderImportPreview() {
      if (!importPreviewState) {
        importPreviewEl.innerHTML = '';
        return;
      }
      if (importPreviewState.kind === 'rankings') {
        var r = importPreviewState.result;
        var msg = '';
        if (store.getState().manuallyEdited) {
          msg += "You've manually reordered rankings — a backup will download automatically before this replaces them. ";
        }
        msg += 'Parsed ' + r.players.length + ' players (skipped ' + r.skipped + ' K/DST)';
        if (r.warnings && r.warnings.length) {
          msg += ' ' + EMDASH + ' ' + r.warnings.length + ' warning(s)';
        }
        importPreviewEl.innerHTML =
          '<div class="sheet-note">' + esc(msg) + '</div>' +
          '<button class="sheet-row" data-action="import-apply-rankings">Replace rankings</button>';
      } else {
        var st = importPreviewState.result.state;
        importPreviewEl.innerHTML =
          '<div class="sheet-note">Restore backup from ' + st.players.length + ' players?</div>' +
          '<button class="sheet-row" data-action="import-apply-backup">Restore Backup</button>';
      }
    }

    function handleImportParse() {
      var text = importTextarea.value;
      var format = DC.importer.detectFormat(text);
      if (format === 'backup') {
        var backupResult = DC.importer.parseBackup(text);
        if (!backupResult.ok) {
          showImportError(backupResult.error);
          return;
        }
        importPreviewState = { kind: 'backup', result: backupResult };
        renderImportPreview();
      } else {
        var rankingsResult = DC.importer.parseRankings(text);
        if (!rankingsResult.ok) {
          showImportError(rankingsResult.error);
          return;
        }
        importPreviewState = { kind: 'rankings', result: rankingsResult };
        renderImportPreview();
      }
    }

    function applyRankings() {
      if (!importPreviewState || importPreviewState.kind !== 'rankings') {
        return;
      }
      if (DC.ui.templates.shouldAutoBackupBeforeImport(store.getState())) {
        handleExport(); // captures the pre-import, manually-ordered state
      }
      store.dispatch({ type: 'IMPORT_PLAYERS', players: importPreviewState.result.players });
      closeSettings();
    }

    function applyBackup() {
      if (!importPreviewState || importPreviewState.kind !== 'backup') {
        return;
      }
      var backupState = importPreviewState.result.state;
      var check = DC.ui.templates.backupApplyCheck(backupState);
      if (!check.ok) {
        showImportError(check.error);
        return;
      }
      DC.state.save(backupState);
      location.reload();
    }

    importFile.addEventListener('change', function () {
      var file = importFile.files && importFile.files[0];
      if (!file) {
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        importTextarea.value = String(reader.result || '');
      };
      reader.readAsText(file);
    });

    // ---- export ----

    function handleExport() {
      var state = store.getState();
      var blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'draft-cockpit-backup.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 0);
    }

    // ---- draft tap / long-press / undo tap ----

    // shared by a normal tap (mine:false) and a fired long-press (mine:true)
    function runDraftSequence(target, mine) {
      var row = target.closest('.player-row');
      if (!row) {
        return;
      }
      var id = target.getAttribute('data-id');
      if (row.classList.contains('exiting')) {
        return; // double-tap guard
      }
      row.classList.add(mine ? 'flash-mine' : 'flash-draft');
      row.classList.add('exiting');
      setTimeout(function () {
        // clear here, not in the click handler: a click before this point is blocked by the
        // .exiting guard above; after this point the row is gone and no click can arrive.
        longPressFiredId = null;
        store.dispatch({ type: 'DRAFT_PLAYER', playerId: id, mine: mine });
      }, 150);
    }

    function handleDraftTap(target) {
      runDraftSequence(target, false);
    }

    // ---- long-press machinery: pointerdown arms a 500ms timer; pointerup/cancel/leave
    // before it fires cancel back to a normal tap; firing marks mine:true and sets
    // longPressFiredId so the click that always follows pointerup is suppressed once. ----

    var pressTimer = null;
    var pressBtn = null;
    var pressPointerId = null;
    var longPressFiredId = null;

    function teardownPress() {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      if (pressBtn) {
        pressBtn.classList.remove('arming');
        pressBtn.removeEventListener('pointerup', onPressUp);
        pressBtn.removeEventListener('pointercancel', onPressEnd);
        pressBtn.removeEventListener('pointerleave', onPressEnd);
      }
      pressBtn = null;
      pressPointerId = null;
    }

    function onPressEnd(ev) {
      if (ev.pointerId !== pressPointerId) {
        return;
      }
      teardownPress();
    }

    function onPressUp(ev) {
      if (ev.pointerId !== pressPointerId) {
        return;
      }
      teardownPress(); // browser's ensuing click runs the normal mine:false path
    }

    function onPressFire(target, id) {
      teardownPress();
      longPressFiredId = id;
      runDraftSequence(target, true);
    }

    appEl.addEventListener('pointerdown', function (ev) {
      var target = ev.target.closest('.btn-draft');
      if (!target || ev.button !== 0 || pressBtn) {
        return;
      }
      var row = target.closest('.player-row');
      if (row && row.classList.contains('exiting')) {
        return;
      }
      var id = target.getAttribute('data-id');
      pressBtn = target;
      pressPointerId = ev.pointerId;
      target.classList.add('arming');
      target.addEventListener('pointerup', onPressUp);
      target.addEventListener('pointercancel', onPressEnd);
      target.addEventListener('pointerleave', onPressEnd);
      pressTimer = setTimeout(function () {
        onPressFire(target, id);
      }, LONG_PRESS_MS);
    });

    appEl.addEventListener('contextmenu', function (ev) {
      if (ev.target.closest('.btn-draft')) {
        ev.preventDefault();
      }
    });

    function showUndoBanner(name) {
      if (undoBannerTimer) {
        clearTimeout(undoBannerTimer);
        undoBannerTimer = null;
      }
      undoBannerRoot.innerHTML = '<div class="undo-banner">Undid: ' + esc(name) + ' ' + ARROW + ' back to Available</div>';
      undoBannerTimer = setTimeout(function () {
        undoBannerRoot.innerHTML = '';
        undoBannerTimer = null;
      }, 2000);
    }

    function handleUndoTap() {
      var state = store.getState();
      if (!state.undoStack.length) {
        return;
      }
      var lastEntry = state.undoStack[state.undoStack.length - 1];
      var playerId = lastEntry.playerId;
      var player = state.players.filter(function (p) { return p.id === playerId; })[0];
      store.dispatch({ type: 'UNDO_DRAFT' }); // synchronous — render() has already run by the next line
      var row = listEl.querySelector('[data-id="' + attrSelector(playerId) + '"]');
      if (row) {
        row.classList.add('restored');
        row.addEventListener('animationend', function onDone() {
          row.classList.remove('restored');
          row.removeEventListener('animationend', onDone);
        });
      } else {
        showUndoBanner(player ? player.name : 'Player');
      }
    }

    // ---- delegated click handling ----

    appEl.addEventListener('click', function (ev) {
      var target = ev.target.closest('[data-action]');
      if (!target) {
        return;
      }
      var action = target.getAttribute('data-action');
      var id = target.getAttribute('data-id');

      switch (action) {
        case 'toggle-target':
          store.dispatch({ type: 'TOGGLE_TARGET', playerId: id });
          break;
        case 'toggle-avoid':
          store.dispatch({ type: 'TOGGLE_AVOID', playerId: id });
          break;
        case 'draft':
          if (longPressFiredId === id) {
            longPressFiredId = null; // the click that follows a fired long-press must not double-draft
            break;
          }
          handleDraftTap(target);
          break;
        case 'undraft':
          store.dispatch({ type: 'UNDRAFT_PLAYER', playerId: id });
          break;
        case 'toggle-mine':
          store.dispatch({ type: 'TOGGLE_MINE', playerId: id });
          break;
        case 'set-position': {
          var pos = target.getAttribute('data-position');
          var current = store.getState().filters.position;
          store.dispatch({ type: 'SET_POSITION_FILTER', position: pos === current ? 'ALL' : pos });
          break;
        }
        case 'set-status': {
          var status = target.getAttribute('data-status');
          store.dispatch({ type: 'SET_STATUS_FILTER', status: status });
          break;
        }
        case 'clear-search':
          store.dispatch({ type: 'SET_SEARCH', text: '' });
          break;
        case 'clear-filters':
          store.dispatch({ type: 'SET_POSITION_FILTER', position: 'ALL' });
          store.dispatch({ type: 'SET_STATUS_FILTER', status: 'AVAILABLE' });
          break;
        case 'focus-search':
          searchInput.focus();
          listEl.scrollTop = 0;
          break;
        case 'undo':
          handleUndoTap();
          break;
        case 'open-settings':
          openSettings();
          break;
        case 'close-settings':
          closeSettings();
          break;
        case 'toggle-import':
          toggleImportArea();
          break;
        case 'edit-rankings':
          closeSettings();
          DC.edit.open();
          break;
        case 'reset-draft':
          confirmAction(target, function () {
            store.dispatch({ type: 'RESET_DRAFT' });
            closeSettings();
          });
          break;
        case 'reset-targets-avoid':
          confirmAction(target, function () {
            store.dispatch({ type: 'RESET_TARGETS_AVOID' });
            closeSettings();
          });
          break;
        case 'clear-all-data':
          confirmAction(target, function () {
            store.dispatch({ type: 'CLEAR_ALL_DATA' });
            closeSettings();
          });
          break;
        case 'import-parse':
          handleImportParse();
          break;
        case 'import-apply-rankings':
          confirmAction(target, applyRankings);
          break;
        case 'import-apply-backup':
          confirmAction(target, applyBackup);
          break;
        case 'export':
          handleExport();
          break;
        case 'league-setup-open':
          leagueSetupOpen = true;
          leagueDraft = cloneLeague(DEFAULT_LEAGUE);
          renderLeagueSection(store.getState());
          break;
        case 'league-apply':
          if (leagueDraft) {
            store.dispatch({ type: 'SET_LEAGUE', league: leagueDraft });
          }
          leagueSetupOpen = false;
          leagueDraft = null;
          break;
        case 'league-clear':
          confirmAction(target, function () {
            store.dispatch({ type: 'SET_LEAGUE', league: null });
          });
          break;
        case 'league-size-step': {
          var sizeDir = target.getAttribute('data-dir') === '1' ? 1 : -1;
          updateLeagueDraftOrDispatch(function (lg) {
            lg.size = Math.max(LEAGUE_SIZE_MIN, Math.min(LEAGUE_SIZE_MAX, lg.size + sizeDir));
            return lg;
          });
          break;
        }
        case 'league-slot-step': {
          var slotDir = target.getAttribute('data-dir') === '1' ? 1 : -1;
          updateLeagueDraftOrDispatch(function (lg) {
            lg.slot = lg.slot + slotDir;
            return lg;
          });
          break;
        }
        case 'league-snake-toggle':
          updateLeagueDraftOrDispatch(function (lg) {
            lg.snake = !lg.snake;
            return lg;
          });
          break;
        case 'league-roster-step': {
          var rosterKey = target.getAttribute('data-key');
          var rosterDir = target.getAttribute('data-dir') === '1' ? 1 : -1;
          updateLeagueDraftOrDispatch(function (lg) {
            lg.roster[rosterKey] = Math.max(LEAGUE_ROSTER_MIN, Math.min(LEAGUE_ROSTER_MAX, lg.roster[rosterKey] + rosterDir));
            return lg;
          });
          break;
        }
        default:
          break;
      }
    });

    searchInput.addEventListener('input', function () {
      store.dispatch({ type: 'SET_SEARCH', text: searchInput.value });
    });
    searchInput.addEventListener('focus', function () {
      document.body.classList.add('searching');
    });
    searchInput.addEventListener('blur', function () {
      document.body.classList.remove('searching');
    });

    // ---- render ----

    function pickEmptyKind(state) {
      var searching = !!(state.searchText && state.searchText.trim() !== '');
      if (searching) {
        return { kind: 'search', detail: state.searchText };
      }
      if (state.filters.status === 'TARGETS') {
        return { kind: 'targets' };
      }
      if (state.filters.status === 'DRAFTED') {
        return { kind: 'drafted' };
      }
      if (state.filters.status === 'MINE') {
        return { kind: 'mine' };
      }
      var allDrafted = state.players.every(function (p) { return state.marks[p.id].drafted; });
      if (allDrafted) {
        return { kind: 'complete' };
      }
      return {
        kind: 'combo',
        detail: {
          status: STATUS_LABELS[state.filters.status] || state.filters.status,
          position: state.filters.position === 'ALL' ? '' : state.filters.position
        }
      };
    }

    function render(state) {
      var visible = DC.state.visiblePlayers(state);
      var searching = !!(state.searchText && state.searchText.trim() !== '');

      if (searchInput.value !== state.searchText) {
        searchInput.value = state.searchText;
      }
      searchClearBtn.style.display = state.searchText !== '' ? '' : 'none';

      var counts = DC.state.availableCountsByPosition(state);
      statsEl.innerHTML = templates.statsStripHTML(counts, state.filters.position);

      var pm = DC.state.pickMath(state);
      trackerEl.innerHTML = pm ? templates.trackerStripHTML(pm) : ''; // hidden entirely when league unset

      chipsEl.innerHTML = templates.chipsHTML(state.filters);
      if (state.filters.status === 'MINE' && !searching) {
        summaryEl.innerHTML = templates.rosterSummaryHTML(DC.state.rosterNeeds(state), DC.state.myRosterCounts(state));
      } else {
        summaryEl.innerHTML = templates.summaryHTML(state, visible.length);
      }

      if (visible.length === 0) {
        var empty = pickEmptyKind(state);
        listEl.innerHTML = templates.emptyStateHTML(empty.kind, empty.detail);
      } else {
        // signal id-sets computed ONCE per render, shared by every row's ctx — never per row
        var signals = {
          value: DC.state.valueFlagIds(state),
          cliff: DC.state.lastInTierIds(state)
        };
        listEl.innerHTML = visible.map(function (v) {
          var ctx = {
            searching: searching,
            statusFilter: state.filters.status,
            pickNumber: v.drafted ? DC.state.pickNumber(state, v.id) : null,
            signals: signals
          };
          return templates.playerRowHTML(v, ctx);
        }).join('');
      }

      bottomBarEl.innerHTML = templates.bottomBarHTML(state);
      renderLeagueSection(state);

      var filtersKey = state.filters.position + '|' + state.filters.status;
      if (filtersKey !== lastFiltersKey || state.searchText !== lastSearchText) {
        listEl.scrollTop = 0;
      }
      lastFiltersKey = filtersKey;
      lastSearchText = state.searchText;
    }

    store.subscribe(render);
    render(store.getState());
  }

  DC.ui = { mount: mount, templates: templates, icon: icon };
})();
