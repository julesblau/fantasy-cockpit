(function () {
  'use strict';
  window.DC = window.DC || {};

  /** @typedef {import('./state.js')} */ // Player shape: {id, rank, name, team, position, byeWeek}

  var MIDDOT = '·';
  var NDASH_BYE = '—';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function metaLine(view) {
    var bye = view.byeWeek === 0 ? NDASH_BYE : String(view.byeWeek);
    return esc(view.team) + ' ' + MIDDOT + ' ' + esc(view.position) + ' ' + MIDDOT + ' Bye ' + bye;
  }

  // ---- staging (pure array ops on a working copy of players; invalid input -> same ref) ----

  /** @param {Array} players @returns {Array} new array of shallow copies */
  function fromPlayers(players) {
    return players.map(function (p) { return Object.assign({}, p); });
  }

  /** @param {Array} players @returns {string[]} */
  function idsOf(players) {
    return players.map(function (p) { return p.id; });
  }

  /**
   * Splice-move the item at fromIndex to toIndex (clamped into [0, length-1]).
   * @param {Array} staged @param {number} fromIndex @param {number} toIndex
   * @returns {Array} new array, or the SAME reference if fromIndex is out of range
   *   or the (clamped) destination equals fromIndex.
   */
  function moveByIndex(staged, fromIndex, toIndex) {
    var len = staged.length;
    if (fromIndex < 0 || fromIndex >= len) {
      return staged;
    }
    var clampedTo = Math.max(0, Math.min(len - 1, toIndex));
    if (clampedTo === fromIndex) {
      return staged;
    }
    var next = staged.slice();
    var item = next.splice(fromIndex, 1)[0];
    next.splice(clampedTo, 0, item);
    return next;
  }

  /**
   * Find playerId's current index, clamp toRank into [1, length], delegate to moveByIndex.
   * @param {Array} staged @param {string} playerId @param {number} toRank 1-based
   * @returns {Array} new array, or the SAME reference if playerId is not found.
   */
  function moveToRank(staged, playerId, toRank) {
    var idx = -1;
    for (var i = 0; i < staged.length; i++) {
      if (staged[i].id === playerId) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      return staged;
    }
    var clampedRank = Math.max(1, Math.min(staged.length, toRank));
    return moveByIndex(staged, idx, clampedRank - 1);
  }

  /**
   * @param {Array} staged @param {string} playerId
   * @returns {number|null} 1-based rank among same-position players in staged order; null if id not found.
   */
  function positionRankOf(staged, playerId) {
    var position = null;
    for (var i = 0; i < staged.length; i++) {
      if (staged[i].id === playerId) {
        position = staged[i].position;
        break;
      }
    }
    if (position === null) {
      return null;
    }
    var rank = 0;
    for (var i = 0; i < staged.length; i++) {
      if (staged[i].position === position) {
        rank++;
        if (staged[i].id === playerId) {
          return rank;
        }
      }
    }
    return null; // unreachable: playerId was found above with this position
  }

  /**
   * Moves playerId so it becomes the posRank-th player of its OWN position, without disturbing
   * the relative order of any other player (same-position or not). Delegates the actual splice to
   * moveByIndex, so it inherits that function's non-mutating / same-ref-on-true-no-op contract.
   * @param {Array} staged @param {string} playerId @param {number} posRank 1-based
   * @returns {Array} new array, or the SAME reference if playerId is not found or is the sole
   *   player at its position (nothing to rank against).
   */
  function moveToPositionRank(staged, playerId, posRank) {
    var fromIndex = -1;
    for (var i = 0; i < staged.length; i++) {
      if (staged[i].id === playerId) {
        fromIndex = i;
        break;
      }
    }
    if (fromIndex === -1) {
      return staged;
    }
    var position = staged[fromIndex].position;
    var groupOverallIdx = []; // overall indices of same-position players, EXCLUDING the mover
    for (var i = 0; i < staged.length; i++) {
      if (i !== fromIndex && staged[i].position === position) {
        groupOverallIdx.push(i);
      }
    }
    if (groupOverallIdx.length === 0) {
      return staged; // sole player at this position: no neighbor to rank against
    }
    var clampedRank = Math.max(1, Math.min(groupOverallIdx.length + 1, posRank));
    var toIndex;
    if (clampedRank > groupOverallIdx.length) {
      // beyond group end: land immediately AFTER the last group member
      var lastIdx = groupOverallIdx[groupOverallIdx.length - 1];
      toIndex = lastIdx + (lastIdx < fromIndex ? 1 : 0);
    } else {
      // land immediately BEFORE the (clampedRank)-th group member
      var anchorIdx = groupOverallIdx[clampedRank - 1];
      toIndex = anchorIdx - (fromIndex < anchorIdx ? 1 : 0);
    }
    return moveByIndex(staged, fromIndex, toIndex);
  }

  /**
   * Positional id comparison; a length mismatch always counts as changed.
   * @param {Array} staged @param {Array} committedPlayers @returns {boolean}
   */
  function stagedOrderChanged(staged, committedPlayers) {
    if (staged.length !== committedPlayers.length) {
      return true;
    }
    for (var i = 0; i < staged.length; i++) {
      if (staged[i].id !== committedPlayers[i].id) {
        return true;
      }
    }
    return false;
  }

  /**
   * Ids whose position differs between the original snapshot and the current staging order.
   * @param {string[]} originalOrderIds snapshot taken when staging began
   * @param {Array} staged @returns {string[]}
   */
  function diffMovedIds(originalOrderIds, staged) {
    var stagedIds = idsOf(staged);
    var moved = [];
    for (var i = 0; i < originalOrderIds.length; i++) {
      if (originalOrderIds[i] !== stagedIds[i]) {
        moved.push(originalOrderIds[i]);
      }
    }
    return moved;
  }

  /**
   * Converts a drop slot within a FILTERED (visible) row list into overall staged indices, so a
   * drag inside a filtered/searched view can still call moveByIndex on the full staged order.
   *
   * Convention table (mirrors the single-list landedIndex -> toIndex seam in finishDrag, applied
   * per-anchor instead of uniformly):
   *   toVisibleSlot === fromVisibleIdx or fromVisibleIdx+1  -> no-op (toIndex = fromIndex)
   *   toVisibleSlot === 0                                   -> toIndex = overallIndexOf(visibleIds[0])
   *   otherwise: anchor = visibleIds[toVisibleSlot - 1] (the visible row immediately above the
   *     slot); anchorIdx = overallIndexOf(anchor);
   *       toIndex = anchorIdx + 1  if anchorIdx < fromIndex   (mover was above anchor: land after it)
   *       toIndex = anchorIdx      if anchorIdx > fromIndex   (mover was below anchor: land after it,
   *                                                             but removal hasn't shifted anchor yet)
   * In both non-degenerate branches the mover ends up immediately after `anchor` in overall order;
   * any staged ids NOT in visibleIds (filtered out) keep their relative order to everything else.
   *
   * @param {string[]} stagedIds overall order @param {string[]} visibleIds filtered subsequence of stagedIds
   * @param {number} fromVisibleIdx index of the mover within visibleIds
   * @param {number} toVisibleSlot drop slot within visibleIds, in [0, visibleIds.length]
   * @returns {{fromIndex:number, toIndex:number}} overall indices for moveByIndex; {-1,-1} if invalid
   */
  function visibleSlotToOverallMove(stagedIds, visibleIds, fromVisibleIdx, toVisibleSlot) {
    if (fromVisibleIdx < 0 || fromVisibleIdx >= visibleIds.length) {
      return { fromIndex: -1, toIndex: -1 };
    }
    var moverId = visibleIds[fromVisibleIdx];
    var fromIndex = stagedIds.indexOf(moverId);
    if (fromIndex === -1) {
      return { fromIndex: -1, toIndex: -1 };
    }
    if (toVisibleSlot === fromVisibleIdx || toVisibleSlot === fromVisibleIdx + 1) {
      return { fromIndex: fromIndex, toIndex: fromIndex };
    }
    var toIndex;
    if (toVisibleSlot === 0) {
      toIndex = stagedIds.indexOf(visibleIds[0]);
    } else {
      var anchorIdx = stagedIds.indexOf(visibleIds[toVisibleSlot - 1]);
      toIndex = anchorIdx + (anchorIdx < fromIndex ? 1 : 0);
    }
    return { fromIndex: fromIndex, toIndex: toIndex };
  }

  // tierBreakBefore moved to DC.state (shared truth table with ui.js; see state.js's doc comment) —
  // aliased below under DC.edit.staging so every existing internal/external call site is unchanged.
  var tierBreakBefore = DC.state.tierBreakBefore;

  // ---- geometry (pure math for drag/tap-to-jump) ----

  /**
   * @param {number} pointerY @param {number} scrollTop @param {number} rowStep @param {number} count
   * @returns {number} clamped drop index in [0, count]; rowStep <= 0 -> 0.
   */
  function dropIndexFromPointer(pointerY, scrollTop, rowStep, count) {
    if (!(rowStep > 0)) {
      return 0;
    }
    var idx = Math.round((pointerY + scrollTop) / rowStep);
    return Math.max(0, Math.min(count, idx));
  }

  /**
   * dropIndexFromPointer assumes every row occupies the same rowStep, which breaks once tier
   * dividers give some rows extra margin-top. This finds the drop slot from real per-row
   * offsets instead: slot k is returned when y sits at/after row k-1's midpoint but before row
   * k's midpoint (binary search over the monotonically increasing midpoints).
   * @param {number} y pointer position in content-space (same convention as dropIndexFromPointer:
   *   pointer-relative-to-list + scrollTop)
   * @param {number[]} rowTops offsetTop of each row, index-aligned with rowHeights
   * @param {number[]} rowHeights offsetHeight of each row
   * @param {number} count number of rows (rowTops/rowHeights length)
   * @returns {number} slot in [0, count]; count <= 0 -> 0
   */
  function slotFromPointerOffsets(y, rowTops, rowHeights, count) {
    if (!(count > 0)) {
      return 0;
    }
    var lo = 0;
    var hi = count;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      var midpoint = rowTops[mid] + rowHeights[mid] / 2;
      if (midpoint <= y) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * Per-displaced-row translateY (px) for the drag gap-shift preview, replacing a uniform
   * ±rowStep constant. A tier-break row's extra margin-top makes row PITCH non-uniform, but
   * (because .player-row's marginBottom is a constant 8px everywhere and only margin-top ever
   * varies, via .tier-break) removing/reinserting the dragged row still shifts EVERY displaced
   * row by the exact same amount, regardless of where a divider falls inside the displaced range
   * — that amount is driven entirely by the dragged row's own height plus the real measured gap
   * immediately ABOVE its ORIGINAL position (fixed for the whole drag; verified against real DOM
   * removal/insertion, not just algebra). Only exception: fromIdx===0 has no row above to measure
   * against, so it falls back to `fallbackGap` (the dragged row's own marginBottom) — correct
   * whenever the dragged first row isn't itself a divider; an accepted approximation when it is
   * (dragging the very first row while it's also a tier-break needs the list's own padding to
   * get exactly right, which this geometry-only function doesn't have).
   * @param {number[]} rowTops @param {number[]} rowHeights @param {number} fromIdx @param {number} targetIdx
   *   drop slot in [0,count] — same range convention as applyGapShifts (downward displaces
   *   (fromIdx,targetIdx) exclusive; upward displaces [targetIdx,fromIdx))
   * @param {number} fallbackGap used only when fromIdx===0
   * @returns {Object<number,number>} displaced row index -> translateY px (fromIdx itself never a key)
   */
  function gapShiftAmounts(rowTops, rowHeights, fromIdx, targetIdx, fallbackGap) {
    var gapBefore = fromIdx > 0
      ? (rowTops[fromIdx] - rowTops[fromIdx - 1] - rowHeights[fromIdx - 1])
      : fallbackGap;
    var pitch = rowHeights[fromIdx] + gapBefore;
    var shifts = {};
    var i;
    if (targetIdx > fromIdx) {
      for (i = fromIdx + 1; i < targetIdx; i++) {
        shifts[i] = -pitch;
      }
    } else if (targetIdx < fromIdx) {
      for (i = targetIdx; i < fromIdx; i++) {
        shifts[i] = pitch;
      }
    }
    return shifts;
  }

  /**
   * Parse a base-10 integer from a string or number. The null-vs-clamp split:
   * unparseable input (empty, non-numeric, a leading "-", decimals like "3.5") -> null;
   * a parseable but out-of-range integer is clamped into [1, count], not nulled.
   * @param {string|number} inputValue @param {number} count @returns {number|null}
   */
  function clampRank(inputValue, count) {
    if (inputValue === null || inputValue === undefined) {
      return null;
    }
    var str = String(inputValue).trim();
    if (!/^[0-9]+$/.test(str)) {
      return null;
    }
    var n = parseInt(str, 10);
    return Math.max(1, Math.min(count, n));
  }

  /**
   * Isolates the 1-based rank -> 0-based moveByIndex toIndex seam.
   * @param {number} fromIndex unused (reserved for future geometry, e.g. direction hints)
   * @param {number} targetRank 1-based @param {number} count
   * @returns {number} 0-based index, targetRank clamped into [1, count] first.
   */
  function rankJumpTargetIndex(fromIndex, targetRank, count) {
    var clamped = Math.max(1, Math.min(count, targetRank));
    return clamped - 1;
  }

  // ---- templates (pure string building; no DOM access) ----

  var GRIP_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="4" y1="7" x2="20" y2="7"></line>' +
      '<line x1="4" y1="12" x2="20" y2="12"></line>' +
      '<line x1="4" y1="17" x2="20" y2="17"></line>' +
    '</svg>';

  /**
   * @param {Object} view player + marks (same shape ui.js templates receive)
   * @param {{moved:boolean, tierBreak:(string|null), positionRank:(number|null)}} ctx
   */
  function editRowHTML(view, ctx) {
    ctx = ctx || {};
    var rowClasses = ['player-row'];
    if (view.drafted) {
      rowClasses.push('is-drafted-search');
    }
    if (ctx.moved) {
      rowClasses.push('row-moved');
    }
    var tierAttr = '';
    if (ctx.tierBreak) {
      rowClasses.push('tier-break');
      tierAttr = ' data-tier-label="' + esc(ctx.tierBreak) + '"';
    }
    var draftedPill = view.drafted ? '<span class="drafted-pill">DRAFTED</span>' : '';
    var rankBtnClass = 'player-rank';
    var rankHTML = String(view.rank);
    if (ctx.positionRank) {
      rankBtnClass += ' pos-rank';
      rankHTML =
        '<span class="rank-position">' + esc(view.position) + ctx.positionRank + '</span>' +
        '<span class="rank-overall">#' + view.rank + '</span>';
    }
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '"' + tierAttr + '>' +
        '<button type="button" class="' + rankBtnClass + '" data-action="rank-jump" data-id="' + esc(view.id) + '">' + rankHTML + '</button>' +
        '<div class="player-info">' +
          '<div class="player-name">' + esc(view.name) + '</div>' +
          '<div class="player-meta">' + metaLine(view) + '</div>' +
        '</div>' +
        draftedPill +
        '<div class="drag-handle" data-id="' + esc(view.id) + '">' + GRIP_ICON + '</div>' +
      '</div>'
    );
  }

  // ---- mount / render (impure — DOM + store wiring) --------------------------

  function attrSelector(id) {
    return String(id).replace(/"/g, '\\"');
  }

  var AUTO_SCROLL_EDGE = 64;
  var AUTO_SCROLL_MAX_SPEED = 16;

  function mount(store) {
    var editRootEl = document.getElementById('edit-root');

    editRootEl.innerHTML =
      '<div class="edit-topbar">' +
        '<button type="button" class="edit-topbar-btn edit-cancel" data-action="cancel-edit">Cancel</button>' +
        '<div class="edit-topbar-title">Edit Rankings</div>' +
        '<div class="edit-topbar-done-wrap">' +
          '<span class="edit-count-pill" hidden></span>' +
          '<button type="button" class="edit-topbar-btn edit-done" data-action="done-edit">Done</button>' +
        '</div>' +
      '</div>' +
      '<div class="search-bar">' +
        '<input type="text" class="search-input edit-search-input" placeholder="Search players by name, team, or position" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
        '<button type="button" class="search-clear edit-search-clear" data-action="edit-search-clear" aria-label="Clear search">' + (DC.ui && DC.ui.icon ? DC.ui.icon('x') : '×') + '</button>' +
      '</div>' +
      '<div class="chip-row" id="edit-position-chips"></div>' +
      '<div id="edit-list"></div>' +
      '<div class="scrim edit-scrim" hidden></div>' +
      '<div class="edit-card" hidden></div>';

    var countPillEl = editRootEl.querySelector('.edit-count-pill');
    var searchInputEl = editRootEl.querySelector('.edit-search-input');
    var searchClearBtn = editRootEl.querySelector('.edit-search-clear');
    var positionChipsEl = editRootEl.querySelector('#edit-position-chips');
    var listEl = editRootEl.querySelector('#edit-list');
    var scrimEl = editRootEl.querySelector('.edit-scrim');
    var cardEl = editRootEl.querySelector('.edit-card');

    // ---- closure state (mirrors ui.js's importPreviewState pattern; lives here, not in the store) ----

    var staged = null; // Array|null — working copy of players while the editor is open
    var marksAtOpen = null; // Object<string, Marks> — snapshot taken at open(), never mutated
    var originalOrderIds = null; // string[] — id order snapshot taken at open()
    var stagedTiers = null; // Object<string, number|null>|null — live tier edits, keyed by id
    var tiersAtOpen = null; // Object<string, number|null>|null — snapshot taken at open(), never mutated
    var editSearchText = '';
    var editPosition = 'ALL'; // UI-only chip filter; never touches the store
    var activeDrag = null; // per-drag token object; identity-checked by every drag callback

    var EDIT_POSITION_CHIPS = [['ALL', 'All'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']];

    function renderPositionChips() {
      positionChipsEl.innerHTML = EDIT_POSITION_CHIPS.map(function (pair) {
        var val = pair[0];
        var label = pair[1];
        var active = editPosition === val ? ' active-position' : '';
        return '<button type="button" class="chip' + active + '" data-action="edit-set-position" data-position="' + val + '">' + label + '</button>';
      }).join('');
    }

    // ---- tier staging helpers (stagedTiers is the live source of truth; staged[i].tier is stale
    // from open() and never read again — always overlay via mergedStagedView before calling the
    // DC.state tier helpers, which expect a Player[] with a live .tier field) ----

    function mergedStagedView() {
      return staged.map(function (p) {
        var t = stagedTiers[p.id];
        return Object.assign({}, p, { tier: t === undefined ? null : t });
      });
    }

    function countAtPosition(position) {
      var n = 0;
      for (var i = 0; i < staged.length; i++) {
        if (staged[i].position === position) {
          n++;
        }
      }
      return n;
    }

    // true iff no player strictly before `index` in `merged` carries a tier — the "min===1 is a
    // default, not a real neighbor constraint" case the tier stepper's clear-to-null relies on.
    function noTieredAbove(merged, index) {
      for (var i = 0; i < index; i++) {
        if (merged[i].tier !== null && merged[i].tier !== undefined) {
          return false;
        }
      }
      return true;
    }

    // Drag-retier clamp: called after EVERY staged move (drag drop, overall jump, position jump)
    // so a mover can never end up tiered out of monotone order relative to its new neighbors.
    function applyRetierClamp(playerId) {
      var newIndex = idsOf(staged).indexOf(playerId);
      if (newIndex === -1) {
        return;
      }
      var merged = mergedStagedView();
      var currentTier = stagedTiers[playerId];
      stagedTiers[playerId] = DC.state.clampTierAt(merged, newIndex, currentTier === undefined ? null : currentTier);
    }

    function tierStepperHTML(playerId) {
      var idx = idsOf(staged).indexOf(playerId);
      var merged = mergedStagedView();
      var bounds = DC.state.stepperBounds(merged, idx);
      var tier = stagedTiers[playerId];
      if (tier === undefined) {
        tier = null;
      }
      var display = tier === null ? '—' : String(tier);
      var noAbove = noTieredAbove(merged, idx);
      var minusDisabled = (tier !== null && tier <= bounds.min && !noAbove) ? ' disabled' : '';
      var plusDisabled = (tier !== null && bounds.max !== null && tier >= bounds.max) ? ' disabled' : '';
      return (
        '<div class="tier-stepper-row">' +
          '<span class="tier-stepper-label">Tier</span>' +
          '<button type="button" class="tier-step-btn" data-action="tier-step" data-dir="-1" data-id="' + esc(playerId) + '"' + minusDisabled + '>−</button>' +
          '<span class="tier-stepper-value">' + display + '</span>' +
          '<button type="button" class="tier-step-btn" data-action="tier-step" data-dir="1" data-id="' + esc(playerId) + '"' + plusDisabled + '>+</button>' +
        '</div>'
      );
    }

    // ---- edit-card primitive (rank-jump + discard-confirm share this) ----

    function showEditCard(html, scrimAction) {
      cardEl.innerHTML = html;
      cardEl.hidden = false;
      scrimEl.setAttribute('data-action', scrimAction);
      scrimEl.hidden = false;
    }

    function hideEditCard() {
      cardEl.hidden = true;
      cardEl.innerHTML = '';
      scrimEl.hidden = true;
      scrimEl.removeAttribute('data-action');
    }

    function openRankJumpCard(playerId) {
      var ids = idsOf(staged);
      var idx = ids.indexOf(playerId);
      if (idx === -1) {
        return;
      }
      var player = staged[idx];
      var posMode = editPosition !== 'ALL';
      var currentRank = posMode ? positionRankOf(staged, playerId) : (idx + 1);
      var rankCount = posMode ? countAtPosition(player.position) : staged.length;
      var title = posMode
        ? 'Move ' + esc(player.name) + ' to ' + esc(player.position) + ' rank'
        : 'Move ' + esc(player.name) + ' to rank';
      var html =
        '<div class="edit-card-title">' + title + '</div>' +
        '<input type="text" class="rank-input" inputmode="numeric" pattern="[0-9]*" value="' + currentRank + '">' +
        tierStepperHTML(playerId) +
        '<button type="button" class="edit-card-primary" data-action="rank-jump-move" data-id="' + esc(playerId) + '">Move</button>';
      showEditCard(html, 'rank-jump-cancel');

      var input = cardEl.querySelector('.rank-input');
      var moveBtn = cardEl.querySelector('.edit-card-primary');

      function refreshDisabled() {
        moveBtn.disabled = clampRank(input.value, rankCount) === null;
      }
      input.addEventListener('input', refreshDisabled);
      input.addEventListener('keydown', function (kev) {
        if (kev.key === 'Enter' && !moveBtn.disabled) {
          commitRankJump(playerId, input.value);
        }
      });
      refreshDisabled();
      input.select();
    }

    function commitRankJump(playerId, rawValue) {
      var idx = idsOf(staged).indexOf(playerId);
      if (idx === -1) {
        return;
      }
      var posMode = editPosition !== 'ALL';
      var rankCount = posMode ? countAtPosition(staged[idx].position) : staged.length;
      var n = clampRank(rawValue, rankCount);
      if (n === null) {
        return;
      }
      var prevStaged = staged;
      staged = posMode ? moveToPositionRank(staged, playerId, n) : moveToRank(staged, playerId, n);
      if (staged !== prevStaged) {
        applyRetierClamp(playerId);
      }
      hideEditCard();
      renderEditList();

      var rowEl = listEl.querySelector('[data-id="' + attrSelector(playerId) + '"]');
      if (rowEl) {
        var listHeight = listEl.clientHeight;
        var rowTop = rowEl.offsetTop;
        var rowHeight = rowEl.offsetHeight;
        var target = rowTop - listHeight / 2 + rowHeight / 2;
        var maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
        listEl.scrollTop = Math.max(0, Math.min(maxScroll, target));

        rowEl.classList.add('restored');
        rowEl.addEventListener('animationend', function onDone() {
          rowEl.classList.remove('restored');
          rowEl.removeEventListener('animationend', onDone);
        });
      }
    }

    function openDiscardCard() {
      var html =
        '<div class="edit-card-title">Discard your ranking changes?</div>' +
        '<button type="button" class="edit-card-danger" data-action="discard-confirm">Discard Changes</button>' +
        '<button type="button" class="edit-card-secondary" data-action="discard-keep">Keep Editing</button>';
      showEditCard(html, 'discard-keep');
    }

    // ---- render ----

    function updateCountPill(n) {
      if (n > 0) {
        countPillEl.hidden = false;
        countPillEl.textContent = String(n);
      } else {
        countPillEl.hidden = true;
        countPillEl.textContent = '';
      }
    }

    function renderEditList() {
      var changedSet = {};
      diffMovedIds(originalOrderIds, staged).forEach(function (id) {
        changedSet[id] = true;
      });
      staged.forEach(function (p) {
        var t = stagedTiers[p.id];
        if ((t === undefined ? null : t) !== tiersAtOpen[p.id]) {
          changedSet[p.id] = true;
        }
      });
      var changedCount = Object.keys(changedSet).length;

      var indexOfId = {};
      staged.forEach(function (p, i) {
        indexOfId[p.id] = i;
      });

      var searching = editSearchText.trim() !== '';
      editRootEl.classList.toggle('edit-searching', searching);

      renderPositionChips();

      var positionFiltered = editPosition === 'ALL'
        ? staged
        : staged.filter(function (p) { return p.position === editPosition; });

      var rows = searching
        ? positionFiltered.filter(function (p) { return DC.state.matchesSearch(p, editSearchText); })
        : positionFiltered;

      var posRankOfId = {};
      if (editPosition !== 'ALL') {
        var counter = 0;
        staged.forEach(function (p) {
          if (p.position === editPosition) {
            counter++;
            posRankOfId[p.id] = counter;
          }
        });
      }

      var prevTierView = null;
      listEl.innerHTML = rows.map(function (p) {
        var t = stagedTiers[p.id];
        t = t === undefined ? null : t;
        var tierView = { tier: t };
        var breakLabel = tierBreakBefore(prevTierView, tierView);
        prevTierView = tierView;

        var view = Object.assign({}, p, marksAtOpen[p.id], { rank: indexOfId[p.id] + 1, tier: t });
        var ctx = { moved: !!changedSet[p.id], tierBreak: breakLabel, positionRank: posRankOfId[p.id] || null };
        return editRowHTML(view, ctx);
      }).join('');

      updateCountPill(changedCount);
      searchClearBtn.style.display = editSearchText !== '' ? '' : 'none';
    }

    // ---- open / close lifecycle ----

    function open() {
      var state = store.getState();
      staged = fromPlayers(state.players);
      marksAtOpen = state.marks;
      originalOrderIds = idsOf(state.players);
      stagedTiers = {};
      tiersAtOpen = {};
      state.players.forEach(function (p) {
        var t = p.tier === undefined ? null : p.tier;
        stagedTiers[p.id] = t;
        tiersAtOpen[p.id] = t;
      });
      editSearchText = '';
      editPosition = 'ALL';
      searchInputEl.value = '';
      hideEditCard();
      renderEditList();
      listEl.scrollTop = 0;

      editRootEl.hidden = false;
      editRootEl.classList.remove('leaving');
      editRootEl.classList.add('entering');
      void editRootEl.offsetHeight; // force a reflow so the entering styles commit before we remove the class
      requestAnimationFrame(function () {
        editRootEl.classList.remove('entering');
      });
    }

    function closeEdit() {
      hideEditCard();
      editRootEl.classList.remove('entering');
      editRootEl.classList.add('leaving');
      staged = null;
      marksAtOpen = null;
      originalOrderIds = null;
      stagedTiers = null;
      tiersAtOpen = null;
      editPosition = 'ALL';
      setTimeout(function () {
        editRootEl.hidden = true;
        editRootEl.classList.remove('leaving');
        editRootEl.classList.remove('edit-searching');
      }, 150);
    }

    // ---- drag mechanics (pointer events on .drag-handle) ----

    function startDrag(ev, handle) {
      var row = handle.closest('.player-row');
      if (!row) {
        return;
      }
      var rows = Array.prototype.slice.call(listEl.querySelectorAll('.player-row'));
      var fromIndex = rows.indexOf(row); // index within the VISIBLE (filtered) row list
      if (fromIndex === -1) {
        return;
      }
      var visibleIds = rows.map(function (r) { return r.getAttribute('data-id'); });

      // captured once at drag start: staged/filters don't change while a drag is active, and
      // dividers make row pitch non-uniform, so slot lookup needs real per-row offsets (D's
      // FINAL DECISION), not a uniform rowStep. getBoundingClientRect (not offsetTop) keeps this
      // in the SAME content-space frame as pointerYRelativeToList below regardless of whether
      // #edit-list happens to be a positioned offsetParent for its rows.
      var startScrollTop = listEl.scrollTop;
      var listTopAtDragStart = listEl.getBoundingClientRect().top;
      var rowTops = rows.map(function (r) { return (r.getBoundingClientRect().top - listTopAtDragStart) + startScrollTop; });
      var rowHeights = rows.map(function (r) { return r.getBoundingClientRect().height; });

      var token = {};
      activeDrag = token;

      var pointerId = ev.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch (e) {
        // capture is best-effort; a drag that never captures still works via document listeners
      }

      var startClientY = ev.clientY;
      var marginBottom = parseFloat(getComputedStyle(row).marginBottom) || 0; // gapShiftAmounts' fromIdx===0 fallback
      var lastPointerY = ev.clientY;
      var currentTargetIndex = fromIndex;
      var rafId = null;

      row.classList.add('dragging');

      function onTouchMove(tev) {
        if (activeDrag !== token) {
          return;
        }
        tev.preventDefault();
      }
      document.addEventListener('touchmove', onTouchMove, { passive: false });

      function computeTargetIndex(clientY) {
        var listRect = listEl.getBoundingClientRect();
        var pointerYRelativeToList = clientY - listRect.top;
        var contentY = pointerYRelativeToList + listEl.scrollTop;
        return slotFromPointerOffsets(contentY, rowTops, rowHeights, rows.length);
      }

      // preview must mirror finishDrag's commit: downward shifts (fromIndex, target) exclusive of
      // target itself (finishDrag's toIndex = target - 1 leaves the target row's own slot as the
      // destination, not part of the displaced set); upward shifts [target, fromIndex). Per-row
      // pixel amounts come from gapShiftAmounts, not a uniform rowStep, so a displaced range that
      // crosses a tier-break row's extra margin-top still closes/opens cleanly (no gap/overlap).
      function applyGapShifts(newTargetIndex) {
        var shifts = gapShiftAmounts(rowTops, rowHeights, fromIndex, newTargetIndex, marginBottom);
        rows.forEach(function (r, idx) {
          if (idx === fromIndex) {
            return;
          }
          var shift = shifts[idx] || 0;
          if (shift !== 0) {
            r.classList.add('gap-shift');
            r.style.transform = 'translateY(' + shift + 'px)';
          } else {
            r.classList.remove('gap-shift');
            r.style.transform = '';
          }
        });
        currentTargetIndex = newTargetIndex;
      }

      function updateDragVisual() {
        // the row stays a normal flow child of the scrolling list, so its un-transformed
        // screen position already moves by -scrollDelta on its own; add scrollDelta back so
        // the row stays pinned to the pointer instead of drifting during edge auto-scroll
        var scrollDelta = listEl.scrollTop - startScrollTop;
        row.style.transform = 'translateY(' + (lastPointerY - startClientY + scrollDelta) + 'px) scale(1.02)';
        var newTargetIndex = computeTargetIndex(lastPointerY);
        if (newTargetIndex !== currentTargetIndex) {
          applyGapShifts(newTargetIndex);
        }
      }

      function autoScrollTick() {
        if (activeDrag !== token) {
          return;
        }
        var listRect = listEl.getBoundingClientRect();
        var clampedY = Math.max(listRect.top, Math.min(listRect.bottom, lastPointerY));
        var distTop = clampedY - listRect.top;
        var distBottom = listRect.bottom - clampedY;
        var maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
        var speed = 0;
        if (distTop < AUTO_SCROLL_EDGE) {
          speed = -(((AUTO_SCROLL_EDGE - distTop) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED);
        } else if (distBottom < AUTO_SCROLL_EDGE) {
          speed = ((AUTO_SCROLL_EDGE - distBottom) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED;
        }
        if (speed !== 0 && maxScroll > 0) {
          listEl.scrollTop = Math.max(0, Math.min(maxScroll, listEl.scrollTop + speed));
        }
        updateDragVisual();
        rafId = requestAnimationFrame(autoScrollTick);
      }

      function onPointerMove(mev) {
        if (activeDrag !== token || mev.pointerId !== pointerId) {
          return;
        }
        lastPointerY = mev.clientY;
        updateDragVisual();
      }

      function teardownDrag() {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('orientationchange', onViewportChange);
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', onViewportChange);
        }
        try {
          handle.releasePointerCapture(pointerId);
        } catch (e) {
          // no-op: capture may already be released (e.g. by the browser on pointercancel)
        }
        rows.forEach(function (r) {
          r.classList.remove('gap-shift');
          r.classList.remove('dragging');
          r.style.transform = '';
        });
        activeDrag = null;
      }

      function abortDrag() {
        if (activeDrag !== token) {
          return;
        }
        teardownDrag();
        // staged is intentionally left untouched — abort never commits a move
      }

      function finishDrag() {
        if (activeDrag !== token) {
          return;
        }
        var landedSlot = currentTargetIndex; // visible slot in [0, rows.length]
        teardownDrag();
        if (landedSlot !== fromIndex) {
          var movedId = visibleIds[fromIndex];
          // translate the visible-space drop into overall staged indices (identity when
          // unfiltered: visibleIds === idsOf(staged)) — see visibleSlotToOverallMove's doc comment.
          var move = visibleSlotToOverallMove(idsOf(staged), visibleIds, fromIndex, landedSlot);
          if (move.toIndex !== move.fromIndex) {
            staged = moveByIndex(staged, move.fromIndex, move.toIndex);
            applyRetierClamp(movedId);
          }
          renderEditList();
          var newRow = listEl.querySelector('[data-id="' + attrSelector(movedId) + '"]');
          if (newRow) {
            newRow.classList.add('settled');
            newRow.addEventListener('animationend', function onDone() {
              newRow.classList.remove('settled');
              newRow.removeEventListener('animationend', onDone);
            });
          }
        }
      }

      function onPointerUp(uev) {
        if (activeDrag !== token || uev.pointerId !== pointerId) {
          return;
        }
        finishDrag();
      }

      function onPointerCancel(cev) {
        if (activeDrag !== token || cev.pointerId !== pointerId) {
          return;
        }
        abortDrag();
      }

      function onViewportChange() {
        if (activeDrag !== token) {
          return;
        }
        abortDrag();
      }

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('orientationchange', onViewportChange);
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
      }

      rafId = requestAnimationFrame(autoScrollTick);
    }

    // ---- event wiring ----

    editRootEl.addEventListener('click', function (ev) {
      if (editRootEl.classList.contains('leaving')) {
        // Closes the whole leaving-window-crash class: CSS `pointer-events:none` already
        // blocks real pointers during this 150ms window; this covers everything else
        // (programmatic .click(), synthetic events) that bypasses hit-testing.
        return;
      }
      var target = ev.target.closest('[data-action]');
      if (!target) {
        return;
      }
      var action = target.getAttribute('data-action');
      var id = target.getAttribute('data-id');

      function hasTierChanges() {
        for (var i = 0; i < staged.length; i++) {
          var pid = staged[i].id;
          var t = stagedTiers[pid];
          if ((t === undefined ? null : t) !== tiersAtOpen[pid]) {
            return true;
          }
        }
        return false;
      }

      switch (action) {
        case 'cancel-edit':
          if (staged === null) {
            break; // already closing (e.g. a double-tap during the 150ms leaving window)
          }
          if (diffMovedIds(originalOrderIds, staged).length === 0 && !hasTierChanges()) {
            closeEdit();
          } else {
            openDiscardCard();
          }
          break;
        case 'done-edit': {
          if (staged === null) {
            break; // already closing (e.g. a double-tap during the 150ms leaving window)
          }
          var committedPlayers = store.getState().players;
          if (stagedOrderChanged(staged, committedPlayers) || hasTierChanges()) {
            store.dispatch({ type: 'REORDER_PLAYERS', order: idsOf(staged), tiers: stagedTiers });
          }
          closeEdit();
          break;
        }
        case 'rank-jump':
          openRankJumpCard(id);
          break;
        case 'rank-jump-move': {
          var input = cardEl.querySelector('.rank-input');
          commitRankJump(id, input ? input.value : '');
          break;
        }
        case 'rank-jump-cancel':
          hideEditCard();
          break;
        case 'discard-confirm':
          hideEditCard();
          closeEdit();
          break;
        case 'discard-keep':
          hideEditCard();
          break;
        case 'edit-search-clear':
          editSearchText = '';
          searchInputEl.value = '';
          renderEditList();
          break;
        case 'edit-set-position': {
          var pos = target.getAttribute('data-position');
          editPosition = pos === editPosition ? 'ALL' : pos;
          renderEditList();
          break;
        }
        case 'tier-step': {
          var dir = target.getAttribute('data-dir') === '1' ? 1 : -1;
          var idxNow = idsOf(staged).indexOf(id);
          if (idxNow === -1) {
            break;
          }
          var merged = mergedStagedView();
          var bounds = DC.state.stepperBounds(merged, idxNow);
          var current = stagedTiers[id];
          if (current === undefined) {
            current = null;
          }
          var next;
          if (current === null) {
            next = bounds.start; // first press always initializes, direction is ignored
          } else if (dir === -1 && current <= bounds.min && noTieredAbove(merged, idxNow)) {
            next = null; // clear-to-null: no real neighbor above enforcing the floor
          } else {
            var lo = bounds.min;
            var hi = bounds.max === null ? Infinity : bounds.max;
            next = Math.max(lo, Math.min(hi, current + dir));
          }
          stagedTiers[id] = next;
          renderEditList();
          var stepperRow = cardEl.querySelector('.tier-stepper-row');
          if (stepperRow) {
            stepperRow.outerHTML = tierStepperHTML(id);
          }
          break;
        }
        default:
          break;
      }
    });

    searchInputEl.addEventListener('input', function () {
      editSearchText = searchInputEl.value;
      renderEditList();
    });

    listEl.addEventListener('pointerdown', function (ev) {
      if (activeDrag) {
        return; // a drag is already active — a second finger must never overwrite it and orphan its listeners
      }
      if (ev.button !== 0) {
        return;
      }
      var handle = ev.target.closest('.drag-handle');
      if (!handle) {
        return;
      }
      if (editRootEl.classList.contains('edit-searching')) {
        return; // disabled while searching — see .edit-searching .drag-handle in styles.css
      }
      startDrag(ev, handle);
    });

    DC.edit.open = open;
    DC.edit.close = closeEdit;
  }

  DC.edit = {
    staging: {
      fromPlayers: fromPlayers,
      idsOf: idsOf,
      moveByIndex: moveByIndex,
      moveToRank: moveToRank,
      positionRankOf: positionRankOf,
      moveToPositionRank: moveToPositionRank,
      visibleSlotToOverallMove: visibleSlotToOverallMove,
      tierBreakBefore: tierBreakBefore,
      stagedOrderChanged: stagedOrderChanged,
      diffMovedIds: diffMovedIds
    },
    geom: {
      dropIndexFromPointer: dropIndexFromPointer,
      slotFromPointerOffsets: slotFromPointerOffsets,
      gapShiftAmounts: gapShiftAmounts,
      clampRank: clampRank,
      rankJumpTargetIndex: rankJumpTargetIndex
    },
    templates: {
      editRowHTML: editRowHTML
    },
    mount: mount
  };
})();
