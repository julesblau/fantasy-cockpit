(function () {
  'use strict';
  window.DC = window.DC || {};

  var MIDDOT = '·';
  var EMDASH = '—';
  var ARROW = '→';
  var STAR_GLYPH = '★';
  var NDASH_BYE = '—';
  var LONG_PRESS_MS = 500;
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var STATUS_LABELS = { AVAILABLE: 'Available', TARGETS: 'Targets', AVOID: 'Avoid', DRAFTED: 'Drafted' };

  // VALUE-only right now; the up-to-2-tags/priority-order machinery below stays generic for future signals
  var SIGNAL_DEFS = [
    ['value', 'sig-value', 'VALUE']
  ];

  var LEAGUE_SIZE_MIN = 4;
  var LEAGUE_SIZE_MAX = 20;
  var LEAGUE_ROSTER_MIN = 0;
  var LEAGUE_ROSTER_MAX = 12;
  var LEAGUE_ROSTER_KEYS = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST', 'K', 'BENCH']; // matches js/state.js ROSTER_KEYS — keep in lockstep
  // roster reads the single source in js/state.js — never re-typed here
  var DEFAULT_LEAGUE = { size: 12, slot: 1, snake: true, roster: Object.assign({}, DC.state.DEFAULT_ROSTER) };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** @param {*} iso YYYY-MM-DD @returns {string|null} short human date e.g. 'Aug 12'; string-parsed, no Date object -- duplicated from compare.js's shortAdpDate (module-private there), same esc() precedent */
  function shortAdpDate(iso) {
    var m = typeof iso === 'string' ? iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
    if (!m) {
      return null;
    }
    var month = parseInt(m[2], 10);
    if (month < 1 || month > 12) {
      return null;
    }
    return MONTH_ABBR[month - 1] + ' ' + parseInt(m[3], 10);
  }

  /** @returns {string} live-read from DC.state.adpUpdatedAt() so it can be re-rendered after a refresh or a clear */
  function adpNoteInnerHTML() {
    var updated = shortAdpDate(DC.state.adpUpdatedAt());
    return updated ? '<div class="sheet-note">ADP updated ' + esc(updated) + '</div>' : '';
  }

  /** @returns {string} live-read from DC.state.dkUpdatedAt() — DK lines have no refresh flow, so unlike adpNoteInnerHTML this is never re-rendered after mount */
  function dkNoteInnerHTML() {
    var updated = shortAdpDate(DC.state.dkUpdatedAt());
    return updated ? '<div class="sheet-note">DK lines as of ' + esc(updated) + '</div>' : '';
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
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
    list: '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
    // matches edit.js's GRIP_ICON glyph -- same drag-handle visual language, different context
    grip: '<line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line>'
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

  /**
   * @param {string} playerId @param {*} [signals] same shape as signalTagsHTML's param
   * @returns {number} rendered tag count for this player (0-1) — mirrors signalTagsHTML's own
   *   cap so the suppression check below agrees with what actually rendered
   */
  function signalTagCount(playerId, signals) {
    if (!signals) {
      return 0;
    }
    var n = 0;
    for (var i = 0; i < SIGNAL_DEFS.length && n < 2; i++) {
      var set = signals[SIGNAL_DEFS[i][0]];
      if (set && set[playerId]) {
        n++;
      }
    }
    return n;
  }

  /**
   * @param {Object} view
   * @param {{posRanks:*, signals:*}} [ctx] posRanks id->positionRank map, computed once per
   *   render (see render()'s comment) — always has every id in real usage; templates exercised
   *   standalone without ctx simply omit the bold leading token, same graceful-fallback
   *   precedent as the old rankBadgeHTML. ctx.signals is read only to decide proj-badge
   *   suppression (see below) — callers that never render signalTagsHTML (drafted/
   *   drafted-search rows) simply pass a ctx without it, so the badge always renders there.
   * @returns {string} '<span class="meta-main">POSn · BN</span>[<span
   *   class="adp-badge">n</span>][<span class="proj-badge">n</span>]' — team is omitted (the
   *   name-line logo carries it instead, see teamLogoHTML) except for FA, which has no logo and
   *   so keeps its team text (POSn · FA · BN); text run always wrapped
   *   in .meta-main so it's the only piece that ellipsizes under flex shrink; ADP trailing badge
   *   (bare number, no label) only when adpConsensus resolves; proj badge only when
   *   dkProjForPlayer resolves AND this player isn't already carrying both signal tags (redundant
   *   once 2 tags render — see the .proj-badge comment in styles.css for the measured overflow
   *   this avoids); badge margins are the only separators, never a middot, so no combination
   *   dangles one
   */
  function metricsLineHTML(view, ctx) {
    var posRank = ctx && ctx.posRanks && ctx.posRanks[view.id];
    var parts = [];
    if (posRank) {
      parts.push('<b>' + esc(view.position) + posRank + '</b>');
    }
    if (view.team === 'FA') {
      parts.push(esc(view.team)); // no team logo exists for FA, so the text stays or the info is lost
    }
    var bye = view.byeWeek === 0 ? NDASH_BYE : String(view.byeWeek);
    parts.push('B' + bye);
    var html = '<span class="meta-main">' + parts.join(' ' + MIDDOT + ' ') + '</span>';
    var consensus = DC.state.adpConsensus(view);
    if (typeof consensus === 'number') {
      html += '<span class="adp-badge">' + consensus + '</span>';
    }
    var proj = DC.state.dkProjForPlayer(view);
    if (typeof proj === 'number' && signalTagCount(view.id, ctx && ctx.signals) < 2) {
      html += '<span class="proj-badge">' + proj + '</span>';
    }
    return html;
  }

  /**
   * @param {string} playerId
   * @param {{value:Object}} [signals] id->true maps (DC.state.valueFlagIds), computed ONCE per
   *   render — never call the selectors per row. Unrecognized keys (e.g. a stray 'gone') are
   *   silently ignored — only keys in SIGNAL_DEFS are read.
   * @returns {string} up to 2 .sig-tag spans (currently at most 1, VALUE); '' when none/absent
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

  /**
   * @param {number|null} tier
   * @returns {string} full-card-width band above the row body; '' when tier is null (card starts
   *   at the body, no strip at all) — replaces the old main-board .tier-chip (edit.js keeps its
   *   own tierChipHTML copy; compare.js has its own tierStripHTML, untouched)
   */
  function tierStripHTML(tier) {
    var cls = DC.state.tierColorClass(tier);
    return cls ? '<div class="tier-strip ' + cls + '"><span>TIER ' + tier + '</span></div>' : '';
  }

  /**
   * @param {*} player
   * @returns {string} one .player-avatar-box, always the same wrapper regardless of branch so
   *   the box's 28px geometry never varies with data availability. DST -> sleeper team logo
   *   (unconditional); else an ESPN headshot when DC.adpData.images has the join key; else a
   *   bare empty span. onerror hides a broken <img> behind the box's own circle background —
   *   duplicated (larger, w=96&h=70) in compare.js per the esc()/tierStripHTML precedent.
   */
  function avatarHTML(player) {
    var src = null;
    if (player && player.position === 'DST') {
      src = 'https://sleepercdn.com/images/team_logos/nfl/' + String(player.team).toLowerCase() + '.png';
    } else {
      var key = DC.state.adpKey(player);
      var imageId = key && DC.adpData && DC.adpData.images && DC.adpData.images[key];
      if (imageId) {
        src = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/' + imageId + '.png&w=64&h=47';
      }
    }
    var inner = src
      ? '<img class="player-avatar" src="' + esc(src) + '" alt="" loading="lazy" onerror="this.classList.add(\'avatar-error\')">'
      : '<span class="player-avatar avatar-empty"></span>';
    return '<span class="player-avatar-box">' + inner + '</span>';
  }

  // wraps avatarHTML in a peek tap target -- carries data-action so the compare-select
  // long-press recognizer bails on it (listEl pointerdown, see mount() below)
  function avatarTapHTML(view) {
    return '<span class="avatar-tap" data-action="peek" data-id="' + esc(view.id) + '" role="button" aria-label="Show player card">' + avatarHTML(view) + '</span>';
  }

  // inline name-line team logo -- no fa.png on sleepercdn (FA), and DST's avatar photo is
  // already the team logo (no doubling). pointer-events/draggable are inline, not class-based,
  // so the gesture-inertness guarantee holds even if styles.css fails to load.
  function teamLogoHTML(view) {
    if (!view || view.position === 'DST' || view.team === 'FA') {
      return '';
    }
    var src = 'https://sleepercdn.com/images/team_logos/nfl/' + String(view.team).toLowerCase() + '.png';
    return '<img class="team-logo" src="' + esc(src) + '" alt="" loading="lazy" draggable="false" style="pointer-events:none;-webkit-user-drag:none" onerror="this.style.display=\'none\'">';
  }

  // shared by all three main-board row templates — the two-line pos-rank badge is gone here
  // (posRank moved to metricsLineHTML's bold leading token); edit.js keeps its own two-line
  // rank-position/rank-overall badge in editRowHTML, untouched.
  function cardRankHTML(view) {
    return '<div class="player-rank">' + view.rank + '</div>';
  }

  // queue-view-only, rendered when ctx.dragHandle is true -- data-action excludes it from the
  // compare long-press recognizer and the swipe gesture's arm check (same [data-action] guard
  // that already excludes avatarTapHTML/the star/x/draft buttons), so it can never steal a tap.
  function queueDragHandleHTML(id) {
    return '<div class="drag-handle queue-drag-handle" data-action="queue-drag-handle" data-id="' + esc(id) + '">' + icon('grip') + '</div>';
  }

  /** @param {{signals:*, posRanks:*, myPick:boolean, isCompared:boolean, queuedIds:*, dragHandle:boolean}} [ctx] */
  function availableRowHTML(view, ctx) {
    ctx = ctx || {};
    var rowClasses = ['player-row'];
    if (view.target) {
      rowClasses.push('is-target');
    }
    if (view.avoid) {
      rowClasses.push('is-avoid');
    }
    if (ctx.isCompared) {
      rowClasses.push('is-compared');
    }
    if (ctx.queuedIds && ctx.queuedIds[view.id]) {
      rowClasses.push('is-queued');
    }
    var starClass = 'btn-toggle btn-toggle-star' + (view.target ? ' on-target' : '');
    var starIcon = view.target ? icon('star-filled') : icon('star');
    var xClass = 'btn-toggle btn-toggle-x' + (view.avoid ? ' on-avoid' : '');
    var draftClass = 'btn-draft' + (ctx.myPick ? ' my-pick' : '');
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        tierStripHTML(view.tier) +
        '<div class="player-row-body">' +
          cardRankHTML(view) +
          avatarTapHTML(view) +
          '<div class="player-info">' +
            '<div class="player-name"><span class="player-name-text">' + esc(view.name) + '</span>' + teamLogoHTML(view) + '</div>' +
            '<div class="player-meta player-meta-card">' + metricsLineHTML(view, ctx) + signalTagsHTML(view.id, ctx.signals) + '</div>' +
          '</div>' +
          '<button class="' + starClass + '" data-action="toggle-target" data-id="' + esc(view.id) + '">' + starIcon + '</button>' +
          '<button class="' + xClass + '" data-action="toggle-avoid" data-id="' + esc(view.id) + '">' + icon('x') + '</button>' +
          '<button class="' + draftClass + '" data-action="draft" data-id="' + esc(view.id) + '">DRAFT</button>' +
          (ctx.dragHandle ? queueDragHandleHTML(view.id) : '') +
        '</div>' +
      '</div>'
    );
  }

  /** @param {{pickLabel:(string|null), posRanks:*, isCompared:boolean, queuedIds:*}} [ctx] */
  function draftedSearchRowHTML(view, ctx) {
    ctx = ctx || {};
    var rowClasses = ['player-row', 'is-drafted-search'];
    if (ctx.isCompared) {
      rowClasses.push('is-compared');
    }
    if (ctx.queuedIds && ctx.queuedIds[view.id]) {
      rowClasses.push('is-queued');
    }
    var mineToggleClass = 'btn-toggle' + (view.mine ? ' on-mine' : '');
    var pillClass = 'drafted-pill' + (ctx.pickLabel ? ' pill-mine' : '');
    var pillText = ctx.pickLabel ? ctx.pickLabel : 'DRAFTED';
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        tierStripHTML(view.tier) +
        '<div class="player-row-body">' +
          cardRankHTML(view) +
          avatarTapHTML(view) +
          '<div class="player-info">' +
            '<div class="player-name"><span class="player-name-text">' + esc(view.name) + '</span>' + teamLogoHTML(view) + '</div>' +
            '<div class="player-meta player-meta-card">' + metricsLineHTML(view, ctx) + '</div>' +
          '</div>' +
          '<span class="' + pillClass + '">' + pillText + '</span>' +
          '<button class="' + mineToggleClass + '" data-action="toggle-mine" data-id="' + esc(view.id) + '" aria-label="Toggle whether this pick is yours">' + icon('user') + '</button>' +
        '</div>' +
      '</div>'
    );
  }

  /** @param {{pickNumber:(number|null), pickLabel:(string|null), posRanks:*, isCompared:boolean}} [ctx] */
  function draftedRowHTML(view, ctx) {
    ctx = ctx || {};
    var pickText = typeof ctx.pickNumber === 'number' ? ctx.pickNumber : EMDASH;
    var badgeHTML = ctx.pickLabel
      ? '<span class="pick-badge pick-badge-mine">' + ctx.pickLabel + '</span>'
      : '<span class="pick-badge">Pick ' + pickText + '</span>';
    var rowClasses = ['player-row'];
    if (view.mine) {
      rowClasses.push('is-mine');
    }
    if (ctx.isCompared) {
      rowClasses.push('is-compared');
    }
    var mineToggleClass = 'btn-toggle' + (view.mine ? ' on-mine' : '');
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        tierStripHTML(view.tier) +
        '<div class="player-row-body">' +
          cardRankHTML(view) +
          avatarTapHTML(view) +
          '<div class="player-info">' +
            '<div class="player-name">' +
              '<span style="display:inline-flex;flex-shrink:0;width:16px;height:16px;vertical-align:-3px;color:var(--accent-draft);margin-right:4px">' + icon('check', 16) + '</span>' +
              '<span class="player-name-text">' + esc(view.name) + '</span>' +
              teamLogoHTML(view) +
            '</div>' +
            '<div class="player-meta player-meta-card">' + metricsLineHTML(view, ctx) + '</div>' +
          '</div>' +
          badgeHTML +
          '<button class="' + mineToggleClass + '" data-action="toggle-mine" data-id="' + esc(view.id) + '" aria-label="Toggle whether this pick is yours">' + icon('user') + '</button>' +
          '<button class="btn-undraft" data-action="undraft" data-id="' + esc(view.id) + '">UNDO</button>' +
        '</div>' +
      '</div>'
    );
  }

  /**
   * @param {Object} view player + marks (id, rank, name, team, position, byeWeek, tier, drafted, target, avoid)
   * @param {{searching:boolean, statusFilter:string, pickNumber:(number|null), pickLabel:(string|null), signals:*}} ctx
   */
  function playerRowHTML(view, ctx) {
    ctx = ctx || {};
    if (view.drafted) {
      if (ctx.searching) {
        return draftedSearchRowHTML(view, ctx);
      }
      return draftedRowHTML(view, ctx);
    }
    return availableRowHTML(view, ctx);
  }

  /**
   * @param {Array<{slot:string, player:(Object|null), pickLabel:(string|null|undefined)}>} tiles DC.state.rosterBoard(state) output (non-null), pickLabel attached by the caller
   */
  function rosterBoardHTML(tiles) {
    return tiles.map(function (tile) {
      var label = tile.slot === 'BENCH' ? 'BN' : tile.slot;
      if (!tile.player) {
        return '<div class="roster-tile is-empty" data-slot="' + tile.slot + '"><div class="tile-slot">' + label + '</div><div class="tile-body"><div class="tile-empty">' + EMDASH + ' empty ' + EMDASH + '</div></div></div>';
      }
      var p = tile.player;
      var pickHTML = tile.pickLabel ? '<div class="tile-pick">' + tile.pickLabel + '</div>' : '';
      // team-only meta is removed entirely once the logo carries it; FA has no logo, so it keeps the meta line
      var tileMetaHTML = p.team === 'FA' ? '<div class="tile-meta">' + esc(p.team) + '</div>' : '';
      // display-only: every tile is already mine, so un-mine/undraft live in the Drafted row (and Mine's no-league fallback rows)
      return '<div class="roster-tile" data-slot="' + tile.slot + '"><div class="tile-slot">' + label + '</div><div class="tile-body"><div class="tile-name"><span class="player-name-text">' + esc(p.name) + '</span>' + teamLogoHTML(p) + '</div>' + tileMetaHTML + '</div><div class="tile-right">' + pickHTML + '<div class="tile-bye">BYE ' + p.byeWeek + '</div></div></div>';
    }).join('');
  }

  function trackerStatHTML(value, label) {
    return '<div class="tracker-stat"><div class="tracker-value">' + esc(value) + '</div><div class="tracker-label">' + esc(label) + '</div></div>';
  }

  /** @param {{round:number, currentPick:number, picksUntilMine:number, isMyPick:boolean}} pm non-null DC.state.pickMath(state) result */
  function trackerStripHTML(pm) {
    if (pm.isMyPick) {
      return (
        '<div class="tracker-card my-pick">' +
          '<div class="tracker-up">' +
            '<div class="tracker-up-text">' + "YOU'RE UP" + '</div>' +
            '<div class="tracker-up-sub">R' + pm.round + ' ' + MIDDOT + ' Pick ' + pm.currentPick + '</div>' +
          '</div>' +
        '</div>'
      );
    }
    return (
      '<div class="tracker-card">' +
        trackerStatHTML('R' + pm.round, 'ROUND') +
        trackerStatHTML('#' + pm.currentPick, 'PICK') +
        trackerStatHTML(pm.picksUntilMine, 'UNTIL YOU') +
      '</div>'
    );
  }

  var POSITION_CHIPS = [['ALL', 'All'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE'], ['FLEX', 'FLEX'], ['DST', 'DST'], ['K', 'K']];

  /**
   * @param {{position:string, status:string}} filters
   * @param {number} [queuedCount] undrafted-queued count, badge hidden when falsy/zero
   */
  function chipsHTML(filters, queuedCount) {
    var sticky = (filters && filters.stickyPositions) || [];
    var stickySet = {};
    sticky.forEach(function (p) { stickySet[p] = true; });
    var positionRow = '<div class="chip-row chip-row-positions">' + POSITION_CHIPS.map(function (pair) {
      var val = pair[0];
      var label = pair[1];
      // ALL/FLEX are never sticky-set members (only the six real positions are) -- while sticky
      // mode is on, active status comes solely from the set, so ALL/FLEX read as inactive even
      // though filters.position itself is always 'ALL' during sticky mode
      var isActive = sticky.length > 0 ? !!stickySet[val] : filters.position === val;
      var cls = isActive ? ' active-position' : '';
      if (stickySet[val]) {
        cls += ' sticky-position';
      }
      return '<button class="chip' + cls + '" data-action="set-position" data-position="' + val + '">' + label + '</button>';
    }).join('') + '</div>';

    var queueBadge = queuedCount > 0 ? '<span class="chip-count">' + queuedCount + '</span>' : '';
    var statusRow = '<div class="chip-row">' +
      '<button class="chip' + (filters.status === 'TARGETS' ? ' active-target' : '') + '" data-action="set-status" data-status="TARGETS">' + icon('star') + ' Targets</button>' +
      '<button class="chip' + (filters.status === 'AVOID' ? ' active-avoid' : '') + '" data-action="set-status" data-status="AVOID">' + icon('x') + ' Avoid</button>' +
      '<button class="chip' + (filters.status === 'DRAFTED' ? ' active-drafted' : '') + '" data-action="set-status" data-status="DRAFTED">' + icon('check') + ' Drafted</button>' +
      '<button class="chip' + (filters.status === 'MINE' ? ' active-mine' : '') + '" data-action="set-status" data-status="MINE">' + icon('user') + ' Mine</button>' +
      '<button class="chip' + (filters.status === 'QUEUE' ? ' active-queue' : '') + '" data-action="set-status" data-status="QUEUE">' + icon('list') + ' Queue' + queueBadge + '</button>' +
    '</div>';

    return positionRow + statusRow;
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
        return emptyBody('user', 'No picks of yours yet', 'Draft your pick on your turn, or tag your picks in the Drafted view.', null, null);
      case 'queue':
        return emptyBody('list', 'Queue is empty', 'Swipe a player right on the board to queue him.', null, null);
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
    availableRowHTML: availableRowHTML,
    draftedRowHTML: draftedRowHTML,
    draftedSearchRowHTML: draftedSearchRowHTML,
    signalTagsHTML: signalTagsHTML,
    trackerStripHTML: trackerStripHTML,
    chipsHTML: chipsHTML,
    rosterBoardHTML: rosterBoardHTML,
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
    var trackerEl = document.getElementById('tracker-strip');
    var chipsEl = document.getElementById('filter-chips');
    var listEl = document.getElementById('player-list');
    var undoBannerRoot = document.getElementById('undo-banner-root');
    var bottomBarEl = document.getElementById('bottom-bar');
    var sheetRoot = document.getElementById('sheet-root');

    var trayEl = document.getElementById('compare-tray');
    if (!trayEl) {
      trayEl = document.createElement('div');
      trayEl.id = 'compare-tray';
      appEl.insertBefore(trayEl, bottomBarEl);
    }

    // photo-tap peek popup -- direct child of #app, same structural slot as #edit-root/#compare-root
    var peekRoot = document.getElementById('peek-root');
    if (!peekRoot) {
      peekRoot = document.createElement('div');
      peekRoot.id = 'peek-root';
      peekRoot.hidden = true;
      peekRoot.innerHTML = '<div class="scrim" data-action="peek-close"></div><div class="peek-card"></div>';
      appEl.appendChild(peekRoot);
    }
    var peekCardEl = peekRoot.querySelector('.peek-card');

    function closePeek() {
      peekRoot.hidden = true;
      peekCardEl.innerHTML = '';
    }

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
        '<div class="adp-note-slot">' + adpNoteInnerHTML() + '</div>' +
        '<div class="dk-note-slot">' + dkNoteInnerHTML() + '</div>' +
        '<button class="sheet-row" data-action="adp-refresh">Refresh ADP</button>' +
        '<div class="adp-refresh-status"></div>' +
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
    var adpNoteSlot = sheetRoot.querySelector('.adp-note-slot');
    var adpRefreshBtn = sheetRoot.querySelector('[data-action="adp-refresh"]');
    var adpRefreshStatusEl = sheetRoot.querySelector('.adp-refresh-status');

    var importPreviewState = null; // {kind:'rankings'|'backup', result} — lives here, not in the store
    var leagueSetupOpen = false; // UI-only: true while "Set up draft tracker" editors are expanded pre-Apply
    var leagueDraft = null; // League|null — uncommitted defaults being edited before Apply; never touches the store
    var leagueFoldOpen = false; // UI-only: configured-league editors expanded in Settings
    var adpRefreshInFlight = false; // guards double-taps on Refresh ADP
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
      leagueFoldOpen = false; // closing re-collapses a configured league's editors
      renderLeagueSection(store.getState());
    }

    function toggleImportArea() {
      importArea.hidden = !importArea.hidden;
    }

    function setAdpRefreshStatus(message) {
      adpRefreshStatusEl.innerHTML = message ? '<div class="sheet-note">' + esc(message) + '</div>' : '';
    }

    // ---- league settings section (imperative; league-section is fully rebuilt every render()) ----

    function renderLeagueSection(state) {
      var league = state.league;
      var toggleRowHTML = '<button type="button" class="sheet-row" data-action="league-toggle">League settings</button>';
      if (!league && !leagueSetupOpen) {
        leagueSectionEl.innerHTML = '<button type="button" class="sheet-row" data-action="league-setup-open">Set up draft tracker</button>';
      } else if (league && !leagueFoldOpen) {
        leagueSectionEl.innerHTML = toggleRowHTML;
      } else {
        leagueSectionEl.innerHTML = (league ? toggleRowHTML : '') + leagueEditorsHTML(league || leagueDraft, !league);
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
        msg += 'Parsed ' + r.players.length + ' players (skipped ' + r.skipped + ' unrecognized row(s))';
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

    // shared by a tap and a fired long-press; mine is decided by the caller, not here
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
      var pm = DC.state.pickMath(store.getState());
      var isMyPick = !!(pm && pm.isMyPick);
      runDraftSequence(target, isMyPick);
    }

    // ---- long-press machinery: pointerdown arms a 500ms timer; pointerup/cancel/leave
    // before it fires cancel back to a normal tap; firing inverts the tap's mine flag and
    // sets longPressFiredId so the click that always follows pointerup is suppressed once. ----

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
      var pm = DC.state.pickMath(store.getState());
      var isMyPick = !!(pm && pm.isMyPick);
      runDraftSequence(target, !isMyPick);
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

    // ---- compare selection: long-pressing a row body (~500ms) toggles it into the compare
    // tray (max 4). listEl-scoped (not appEl) so #edit-root -- a SIBLING of #player-list
    // inside #app -- can never bubble through this, even mid-drag. A separate mechanism
    // from the .btn-draft press above; never reads/writes longPressFiredId. ----

    var compareIds = [];
    var comparePressTimer = null;
    var comparePressId = null;
    var comparePressPointerId = null;
    var comparePressStartX = 0;
    var comparePressStartY = 0;

    function teardownComparePress() {
      if (comparePressTimer !== null) {
        clearTimeout(comparePressTimer);
        comparePressTimer = null;
      }
      comparePressId = null;
      comparePressPointerId = null;
    }

    function setCompareRing(id, on) {
      var row = listEl.querySelector('.player-row[data-id="' + attrSelector(id) + '"]');
      if (row) {
        row.classList.toggle('is-compared', on);
      }
    }

    function renderCompareTray() {
      var players = store.getState().players;
      compareIds = compareIds.filter(function (id) {
        return players.some(function (p) { return p.id === id; }); // IMPORT_PLAYERS/clear-all can invalidate stale ids
      });
      if (!compareIds.length) {
        trayEl.innerHTML = '';
        return;
      }
      var chipsHtml = compareIds.map(function (id) {
        var p = players.filter(function (pp) { return pp.id === id; })[0];
        var name = esc(p ? p.name : '');
        return '<div class="compare-chip"><span class="chip-name">' + name + '</span>' +
          '<button class="chip-remove" data-action="compare-remove" data-id="' + esc(id) + '" aria-label="Remove ' + name + ' from compare">✕</button></div>';
      }).join('');
      var disabledAttr = compareIds.length < 2 ? ' disabled' : '';
      trayEl.innerHTML = chipsHtml +
        '<button class="compare-open-btn" data-action="open-compare" aria-label="Compare selected players"' + disabledAttr + '>Compare</button>' +
        '<button class="compare-clear-btn" data-action="compare-clear" aria-label="Clear compare selection">Clear</button>';
    }

    function toggleCompareId(id) {
      var idx = compareIds.indexOf(id);
      if (idx !== -1) {
        compareIds.splice(idx, 1);
      } else if (compareIds.length < 4) {
        compareIds.push(id);
      } else {
        return; // full, and this id isn't already selected -- no-op
      }
      setCompareRing(id, compareIds.indexOf(id) !== -1);
      renderCompareTray();
    }

    // shared by the compare-remove click case AND the Compare screen's onRemove hook
    function onCompareRemove(id) {
      var idx = compareIds.indexOf(id);
      if (idx !== -1) {
        compareIds.splice(idx, 1);
      }
      setCompareRing(id, false);
      renderCompareTray();
    }

    listEl.addEventListener('pointerdown', function (ev) {
      var row = ev.target.closest('.player-row');
      if (!row || ev.target.closest('[data-action]')) {
        return; // every button (draft/star/x/undraft/mine/rank-jump) carries data-action
      }
      if (ev.button !== 0 && ev.pointerType === 'mouse') {
        return;
      }
      teardownComparePress(); // a second pointerdown while armed cancels the first
      comparePressId = row.getAttribute('data-id');
      comparePressPointerId = ev.pointerId;
      comparePressStartX = ev.clientX;
      comparePressStartY = ev.clientY;
      comparePressTimer = setTimeout(function () {
        var id = comparePressId;
        teardownComparePress();
        toggleCompareId(id);
      }, LONG_PRESS_MS);
    });

    listEl.addEventListener('pointermove', function (ev) {
      if (ev.pointerId !== comparePressPointerId) {
        return;
      }
      var dx = ev.clientX - comparePressStartX;
      var dy = ev.clientY - comparePressStartY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        teardownComparePress();
      }
    });

    function onComparePressEnd(ev) {
      if (ev.pointerId !== comparePressPointerId) {
        return;
      }
      teardownComparePress();
    }

    listEl.addEventListener('pointerup', onComparePressEnd);
    listEl.addEventListener('pointercancel', onComparePressEnd);

    // ---- swipe-to-queue: pointerdown on a player row (never the photo/buttons/drag-handle --
    // same [data-action] exclusion the compare-press recognizer above already uses) arms only a
    // RIGHTWARD intent once dx>40 AND |dx|>|dy| (only a rightward release ever commits); a
    // vertical-first OR leftward-first move abandons the gesture outright so the list keeps
    // scrolling normally. Mirrors runDraftSequence's flash-then-delayed-dispatch shape so the
    // snap transition gets to play on the real row before the next render replaces it wholesale. ----

    var SWIPE_ARM_PX = 40;
    var SWIPE_EDGE_ZONE_PX = 24; // iOS standalone back-swipe zone -- never arm from here

    var swipeRow = null;
    var swipePointerId = null;
    var swipeStartX = 0;
    var swipeStartY = 0;
    var swipeLastDx = 0;
    var swipeArmed = false;
    var swipeClickSuppressed = false;

    function teardownSwipe() {
      if (swipeRow) {
        swipeRow.classList.remove('swipe-dragging');
        swipeRow.style.transform = '';
      }
      swipeRow = null;
      swipePointerId = null;
      swipeArmed = false;
    }

    listEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0 && ev.pointerType === 'mouse') {
        return;
      }
      if (ev.clientX < SWIPE_EDGE_ZONE_PX) {
        return;
      }
      var row = ev.target.closest('.player-row');
      if (!row || ev.target.closest('[data-action]')) {
        return;
      }
      var id = row.getAttribute('data-id');
      var mark = store.getState().marks[id];
      if (!mark || mark.drafted) {
        return; // never on Drafted rows or Mine tiles (roster tiles aren't .player-row at all)
      }
      if (swipeRow) {
        return; // a swipe is already tracking a different pointer
      }
      swipeRow = row;
      swipePointerId = ev.pointerId;
      swipeStartX = ev.clientX;
      swipeStartY = ev.clientY;
      swipeLastDx = 0;
      swipeArmed = false;
      try {
        row.setPointerCapture(ev.pointerId);
      } catch (e) {
        // best-effort; the gesture still works via listEl's own listeners without capture
      }
    });

    listEl.addEventListener('pointermove', function (ev) {
      if (!swipeRow || ev.pointerId !== swipePointerId) {
        return;
      }
      var dx = ev.clientX - swipeStartX;
      var dy = ev.clientY - swipeStartY;
      swipeLastDx = dx;
      if (!swipeArmed) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
          teardownSwipe(); // vertical-first: abandon outright, let the page scroll
          return;
        }
        if (dx < 0 && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
          teardownSwipe(); // leftward-first: abandon outright, same as vertical-first -- only rightward ever arms
          return;
        }
        if (dx > SWIPE_ARM_PX && Math.abs(dx) > Math.abs(dy)) {
          swipeArmed = true;
          swipeClickSuppressed = true;
          teardownComparePress();
          swipeRow.classList.add('swipe-dragging');
        }
      }
      if (swipeArmed) {
        swipeRow.style.transform = 'translateX(' + dx + 'px)';
      }
    });

    function endSwipe(commit) {
      if (!swipeRow) {
        return;
      }
      var row = swipeRow;
      var id = row.getAttribute('data-id');
      var wasArmed = swipeArmed;
      var finalDx = swipeLastDx;
      try {
        row.releasePointerCapture(swipePointerId);
      } catch (e) {
        // no-op: capture may already be released (e.g. by the browser on pointercancel)
      }
      row.classList.remove('swipe-dragging');
      row.style.transform = '';
      swipeRow = null;
      swipePointerId = null;
      swipeArmed = false;
      if (!wasArmed) {
        return;
      }
      row.classList.add('swipe-snap');
      if (commit && finalDx > SWIPE_ARM_PX) {
        row.classList.add('flash-queue');
        setTimeout(function () {
          // the row itself is about to be destroyed by this dispatch's re-render -- no cleanup needed
          store.dispatch({ type: 'QUEUE_TOGGLE', playerId: id });
        }, 150);
      } else {
        row.addEventListener('transitionend', function onDone() {
          row.classList.remove('swipe-snap');
          row.removeEventListener('transitionend', onDone);
        });
      }
      // real browsers fire NO click after a pointer sequence that moved past slop, so the click
      // handler's consume-on-click never runs to clear this -- bound its life to this tick
      // instead: a genuine trailing click (when one does arrive) always runs synchronously before
      // this timer's task, so that case is untouched; a later, unrelated tap is never swallowed.
      setTimeout(function () {
        swipeClickSuppressed = false;
      }, 0);
    }

    listEl.addEventListener('pointerup', function (ev) {
      if (!swipeRow || ev.pointerId !== swipePointerId) {
        return;
      }
      endSwipe(true);
    });
    listEl.addEventListener('pointercancel', function (ev) {
      if (!swipeRow || ev.pointerId !== swipePointerId) {
        return;
      }
      endSwipe(false);
    });

    // ---- queue drag reorder: handle-initiated pointer drag, a lightweight sibling of edit.js's
    // drag machinery -- row follows the pointer vertically, drop slot computed from real row
    // offsets via the geometry helper edit.js already exports for reuse; no gap-shift preview or
    // auto-scroll (a personal queue is short, unlike the full board edit.js drags over). ----

    var queueDragRow = null;
    var queueDragPointerId = null;
    var queueDragFromIndex = -1;
    var queueDragRows = [];
    var queueDragVisibleIds = []; // ids of queueDragRows, i.e. the VISIBLE subsequence of state.queueIds
    var queueDragRowTops = [];
    var queueDragRowHeights = [];
    var queueDragStartClientY = 0;
    var queueDragCurrentSlot = -1;

    function teardownQueueDrag() {
      if (queueDragRow) {
        queueDragRow.classList.remove('dragging');
        queueDragRow.style.transform = '';
      }
      queueDragRow = null;
      queueDragPointerId = null;
      queueDragFromIndex = -1;
    }

    listEl.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) {
        return;
      }
      var handle = ev.target.closest('.queue-drag-handle');
      if (!handle) {
        return;
      }
      if (queueDragRow) {
        return; // a drag is already active
      }
      var row = handle.closest('.player-row');
      if (!row) {
        return;
      }
      queueDragRows = Array.prototype.slice.call(listEl.querySelectorAll('.player-row'));
      queueDragFromIndex = queueDragRows.indexOf(row);
      if (queueDragFromIndex === -1) {
        return;
      }
      queueDragVisibleIds = queueDragRows.map(function (r) { return r.getAttribute('data-id'); });
      var listRect = listEl.getBoundingClientRect();
      var scrollTop = listEl.scrollTop;
      queueDragRowTops = queueDragRows.map(function (r) { return (r.getBoundingClientRect().top - listRect.top) + scrollTop; });
      queueDragRowHeights = queueDragRows.map(function (r) { return r.getBoundingClientRect().height; });
      queueDragRow = row;
      queueDragPointerId = ev.pointerId;
      queueDragStartClientY = ev.clientY;
      queueDragCurrentSlot = queueDragFromIndex;
      row.classList.add('dragging');
      try {
        handle.setPointerCapture(ev.pointerId);
      } catch (e) {
        // best-effort; the drag still works via listEl's own listeners without capture
      }
    });

    listEl.addEventListener('pointermove', function (ev) {
      if (!queueDragRow || ev.pointerId !== queueDragPointerId) {
        return;
      }
      queueDragRow.style.transform = 'translateY(' + (ev.clientY - queueDragStartClientY) + 'px)';
      var listRect = listEl.getBoundingClientRect();
      var y = (ev.clientY - listRect.top) + listEl.scrollTop;
      queueDragCurrentSlot = DC.edit.geom.slotFromPointerOffsets(y, queueDragRowTops, queueDragRowHeights, queueDragRows.length);
    });

    function finishQueueDrag(commit) {
      if (!queueDragRow) {
        return;
      }
      var fromVisibleIdx = queueDragFromIndex;
      var toVisibleSlot = queueDragCurrentSlot;
      var visibleIds = queueDragVisibleIds;
      var id = queueDragRow.getAttribute('data-id');
      teardownQueueDrag();
      if (!commit) {
        return;
      }
      // queueDragRows/visibleIds are the VISIBLE queue rows, but QUEUE_REORDER's toIndex applies
      // against the FULL state.queueIds (which also holds drafted ids, hidden from this view but
      // kept in place) -- translate the visible drop slot with the same primitive edit.js's own
      // filtered-view drags use, rather than treating visible and overall index spaces as one.
      var move = DC.edit.staging.visibleSlotToOverallMove(store.getState().queueIds, visibleIds, fromVisibleIdx, toVisibleSlot);
      if (move.fromIndex === -1 || move.toIndex === move.fromIndex) {
        return; // no-op landing spot, or the id vanished from queueIds mid-drag
      }
      store.dispatch({ type: 'QUEUE_REORDER', playerId: id, toIndex: move.toIndex });
    }

    listEl.addEventListener('pointerup', function (ev) {
      if (!queueDragRow || ev.pointerId !== queueDragPointerId) {
        return;
      }
      finishQueueDrag(true);
    });
    listEl.addEventListener('pointercancel', function (ev) {
      if (!queueDragRow || ev.pointerId !== queueDragPointerId) {
        return;
      }
      finishQueueDrag(false);
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

    // ---- sticky-position hold: pointerdown on a position chip arms a ~500ms timer; pointerup/
    // cancel or movement past ~8px (the chip row scrolls horizontally on iPhone -- a scroll must
    // never arm a hold) cancels back to a normal tap. On fire, a real or FLEX position dispatches
    // TOGGLE_STICKY_POSITION; ALL/FLEX route through the same tap logic as a plain click. Firing
    // re-renders the chip row (chipsEl.innerHTML), which can replace the very node under the
    // finger before the trailing click arrives -- chipHoldFired is a container-level flag (cleared
    // on the next chip pointerdown), never a per-node/per-id check, so the suppression in the
    // 'set-position' click case above holds regardless of which node the click lands on. ----

    var chipPressTimer = null;
    var chipPressPointerId = null;
    var chipPressStartX = 0;
    var chipPressStartY = 0;
    var chipPressPosition = null;
    var chipHoldFired = false;
    var CHIP_HOLD_MOVE_PX = 8;

    function teardownChipPress() {
      if (chipPressTimer !== null) {
        clearTimeout(chipPressTimer);
        chipPressTimer = null;
      }
      chipPressPointerId = null;
      chipPressPosition = null;
    }

    chipsEl.addEventListener('pointerdown', function (ev) {
      var chipTarget = ev.target.closest('[data-action="set-position"]');
      if (!chipTarget || (ev.button !== 0 && ev.pointerType === 'mouse')) {
        return;
      }
      chipHoldFired = false; // the only place this flag is cleared -- see block comment above
      teardownChipPress(); // a second pointerdown while armed cancels the first
      chipPressPointerId = ev.pointerId;
      chipPressPosition = chipTarget.getAttribute('data-position');
      chipPressStartX = ev.clientX;
      chipPressStartY = ev.clientY;
      chipPressTimer = setTimeout(function () {
        var position = chipPressPosition;
        teardownChipPress();
        chipHoldFired = true;
        if (position === 'ALL' || position === 'FLEX') {
          var current = store.getState().filters.position;
          store.dispatch({ type: 'SET_POSITION_FILTER', position: position === current ? 'ALL' : position });
        } else {
          store.dispatch({ type: 'TOGGLE_STICKY_POSITION', position: position });
        }
      }, LONG_PRESS_MS);
    });

    chipsEl.addEventListener('pointermove', function (ev) {
      if (ev.pointerId !== chipPressPointerId) {
        return;
      }
      var dx = ev.clientX - chipPressStartX;
      var dy = ev.clientY - chipPressStartY;
      if (Math.abs(dx) > CHIP_HOLD_MOVE_PX || Math.abs(dy) > CHIP_HOLD_MOVE_PX) {
        teardownChipPress();
      }
    });

    function onChipPressEnd(ev) {
      if (ev.pointerId !== chipPressPointerId) {
        return;
      }
      teardownChipPress();
    }

    chipsEl.addEventListener('pointerup', onChipPressEnd);
    chipsEl.addEventListener('pointercancel', onChipPressEnd);

    chipsEl.addEventListener('contextmenu', function (ev) {
      if (ev.target.closest('[data-action="set-position"]')) {
        ev.preventDefault();
      }
    });

    // ---- delegated click handling ----

    appEl.addEventListener('click', function (ev) {
      if (swipeClickSuppressed) {
        swipeClickSuppressed = false; // trailing click after an armed swipe, when the browser fires one
        return;
      }
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
        case 'compare-remove':
          onCompareRemove(id);
          break;
        case 'compare-clear': {
          var idsToClear = compareIds.slice();
          idsToClear.forEach(function (cid) { setCompareRing(cid, false); });
          compareIds = [];
          renderCompareTray();
          break;
        }
        case 'open-compare':
          DC.compare.open(compareIds.slice(), { onRemove: onCompareRemove });
          break;
        case 'peek': {
          var card = DC.compare.templates.buildCards(store.getState(), [id])[0];
          if (!card) {
            break; // stale/unknown id -- silent no-op
          }
          peekCardEl.innerHTML = DC.compare.templates.cardHTML(card, { xAria: 'Close' });
          peekRoot.hidden = false;
          break;
        }
        case 'peek-close':
          closePeek();
          break;
        case 'compare-remove-card':
          // only ours to handle when the click originated inside the peek popup -- the real
          // compare screen's own X is handled by compare.js's #compare-root-scoped listener
          if (target.closest('#peek-root')) {
            closePeek();
          }
          break;
        case 'set-position': {
          if (chipHoldFired) {
            break; // the click that follows a fired chip hold -- suppressed regardless of which node it landed on
          }
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
            localStorage.removeItem(DC.state.ADP_OVERRIDE_KEY);
            DC.state.reloadAdpOverride();
            adpNoteSlot.innerHTML = adpNoteInnerHTML();
            closeSettings();
          });
          break;
        case 'adp-refresh':
          if (adpRefreshInFlight) {
            break;
          }
          adpRefreshInFlight = true;
          adpRefreshBtn.disabled = true;
          adpRefreshBtn.textContent = 'Refreshing…';
          DC.adpRefresh.run().then(function () {
            adpNoteSlot.innerHTML = adpNoteInnerHTML();
            setAdpRefreshStatus('Sleeper + ESPN refreshed (Flock + Underdog update with re-bakes)');
          }, function (err) {
            setAdpRefreshStatus(err && err.message ? err.message : String(err));
          }).then(function () {
            adpRefreshInFlight = false;
            adpRefreshBtn.disabled = false;
            adpRefreshBtn.textContent = 'Refresh ADP';
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
        case 'league-toggle':
          leagueFoldOpen = !leagueFoldOpen;
          renderLeagueSection(store.getState());
          break;
        case 'league-setup-open':
          leagueSetupOpen = true;
          leagueFoldOpen = true; // Apply must not collapse the editors it was just applied from
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

    // ---- active-pointer tracking + deferred body.searching removal ----
    // independent of the long-press machinery above: tracks every pointer on appEl so a
    // tap's blur doesn't collapse the chrome and reflow #player-list under the finger.

    var activePointerIds = new Set();
    var searchingGen = 0;
    var blurPending = false;

    function makeSearchingRemoval() {
      var gen = searchingGen;
      return function () {
        if (gen === searchingGen) {
          document.body.classList.remove('searching');
        }
      };
    }

    function makeSearchingRemovalWithPointerCheck() { // 100ms callsite only -- re-checks pointer state before removing
      var gen = searchingGen;
      return function () {
        if (gen !== searchingGen) { return; }
        if (activePointerIds.size > 0) {
          blurPending = true;
          window.setTimeout(makeSearchingRemoval(), 700); // re-arm the backstop so a dropped pointerup can't strand collapsed chrome
        } else {
          document.body.classList.remove('searching');
        }
      };
    }

    appEl.addEventListener('pointerdown', function (ev) {
      activePointerIds.add(ev.pointerId);
    });

    function onSearchPointerLift(ev) {
      activePointerIds.delete(ev.pointerId);
      if (blurPending && activePointerIds.size === 0) {
        blurPending = false;
        window.requestAnimationFrame(makeSearchingRemoval());
      }
    }

    appEl.addEventListener('pointerup', onSearchPointerLift);
    appEl.addEventListener('pointercancel', onSearchPointerLift);

    searchInput.addEventListener('input', function () {
      store.dispatch({ type: 'SET_SEARCH', text: searchInput.value });
    });
    searchInput.addEventListener('focus', function () {
      searchingGen++; // invalidates any removal scheduled by a prior blur
      blurPending = false;
      document.body.classList.add('searching');
    });
    searchInput.addEventListener('blur', function () {
      if (activePointerIds.size > 0) {
        blurPending = true;
        window.setTimeout(makeSearchingRemoval(), 700); // backstop: rescues a dropped pointerup/cancel
      } else {
        window.setTimeout(makeSearchingRemovalWithPointerCheck(), 100);
      }
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
      if (state.filters.status === 'QUEUE') {
        return { kind: 'queue' };
      }
      var allDrafted = state.players.every(function (p) { return state.marks[p.id].drafted; });
      if (allDrafted) {
        return { kind: 'complete' };
      }
      var sticky = state.filters.stickyPositions || [];
      var positionLabel = sticky.length > 0 ? sticky.join('+') : (state.filters.position === 'ALL' ? '' : state.filters.position);
      return {
        kind: 'combo',
        detail: {
          status: STATUS_LABELS[state.filters.status] || state.filters.status,
          position: positionLabel
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

      var pm = DC.state.pickMath(state);
      trackerEl.innerHTML = pm ? templates.trackerStripHTML(pm) : ''; // hidden entirely when league unset

      // guarded rather than a bare DC.state.queueCount(state) -- some hand-built test-only
      // state fixtures predate the queue feature and omit queueIds entirely
      chipsEl.innerHTML = templates.chipsHTML(state.filters, state.queueIds ? DC.state.queueCount(state) : 0);

      var mineNoSearch = state.filters.status === 'MINE' && !searching;
      if (mineNoSearch && state.league) {
        // league configured: the roster board replaces both the row list and the empty-state,
        // regardless of pick count — takes priority over the visible.length===0 branch below
        // new tile objects only — never mutate rosterBoard()'s output
        var tiles = DC.state.rosterBoard(state).map(function (tile) {
          if (!tile.player) {
            return tile;
          }
          var tpn = DC.state.pickNumber(state, tile.player.id);
          return Object.assign({}, tile, { pickLabel: typeof tpn === 'number' ? DC.state.roundPickLabel(tpn, state.league.size) : null });
        });
        listEl.innerHTML = templates.rosterBoardHTML(tiles);
      } else if (visible.length === 0) {
        var empty = pickEmptyKind(state);
        listEl.innerHTML = templates.emptyStateHTML(empty.kind, empty.detail);
      } else {
        // signal id-sets and position ranks computed ONCE per render, shared by every row's ctx — never per row
        var signals = {
          value: DC.state.valueFlagIds(state)
        };
        var posRanks = DC.state.positionRanks(state);
        var myPick = !!(pm && pm.isMyPick);
        var queuedIds = {};
        (state.queueIds || []).forEach(function (id) { queuedIds[id] = true; });
        // drag reorder only makes sense over the WHOLE queue, in order -- a text search, a
        // narrowing position filter, OR a non-empty sticky set shows a subset, so the handle
        // hides rather than reorder ambiguously underneath it (edit.js's search-disables-drag
        // rule, same rationale)
        var noSticky = !state.filters.stickyPositions || state.filters.stickyPositions.length === 0;
        var showDragHandle = state.filters.status === 'QUEUE' && !searching && state.filters.position === 'ALL' && noSticky;
        var rowsHtml = visible.map(function (v) {
          var pn = v.drafted ? DC.state.pickNumber(state, v.id) : null;
          var ctx = {
            searching: searching,
            statusFilter: state.filters.status,
            pickNumber: pn,
            pickLabel: v.drafted && v.mine && state.league && typeof pn === 'number' ? DC.state.roundPickLabel(pn, state.league.size) : null,
            signals: signals,
            posRanks: posRanks,
            myPick: myPick,
            isCompared: compareIds.indexOf(v.id) !== -1,
            queuedIds: queuedIds,
            dragHandle: showDragHandle
          };
          return templates.playerRowHTML(v, ctx);
        }).join('');
        if (mineNoSearch && !state.league) {
          rowsHtml += '<div class="roster-tile is-empty roster-hint"><div class="tile-body"><div class="tile-empty">Set up your league (Settings) to see roster slots</div></div></div>';
        }
        listEl.innerHTML = rowsHtml;
      }

      bottomBarEl.innerHTML = templates.bottomBarHTML(state);
      renderLeagueSection(state);
      renderCompareTray(); // heals the tray/prunes stale ids after every store-driven render

      var filtersKey = state.filters.position + '|' + state.filters.status + '|' + (state.filters.stickyPositions || []).join(',');
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
