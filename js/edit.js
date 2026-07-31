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
   * @param {{moved:boolean}} ctx
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
    var draftedPill = view.drafted ? '<span class="drafted-pill">DRAFTED</span>' : '';
    return (
      '<div class="' + rowClasses.join(' ') + '" data-id="' + esc(view.id) + '">' +
        '<button type="button" class="player-rank" data-action="rank-jump" data-id="' + esc(view.id) + '">' + view.rank + '</button>' +
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
      '<div id="edit-list"></div>' +
      '<div class="scrim edit-scrim" hidden></div>' +
      '<div class="edit-card" hidden></div>';

    var countPillEl = editRootEl.querySelector('.edit-count-pill');
    var searchInputEl = editRootEl.querySelector('.edit-search-input');
    var searchClearBtn = editRootEl.querySelector('.edit-search-clear');
    var listEl = editRootEl.querySelector('#edit-list');
    var scrimEl = editRootEl.querySelector('.edit-scrim');
    var cardEl = editRootEl.querySelector('.edit-card');

    // ---- closure state (mirrors ui.js's importPreviewState pattern; lives here, not in the store) ----

    var staged = null; // Array|null — working copy of players while the editor is open
    var marksAtOpen = null; // Object<string, Marks> — snapshot taken at open(), never mutated
    var originalOrderIds = null; // string[] — id order snapshot taken at open()
    var editSearchText = '';
    var activeDrag = null; // per-drag token object; identity-checked by every drag callback

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
      var html =
        '<div class="edit-card-title">Move ' + esc(player.name) + ' to rank</div>' +
        '<input type="text" class="rank-input" inputmode="numeric" pattern="[0-9]*" value="' + (idx + 1) + '">' +
        '<button type="button" class="edit-card-primary" data-action="rank-jump-move" data-id="' + esc(playerId) + '">Move</button>';
      showEditCard(html, 'rank-jump-cancel');

      var input = cardEl.querySelector('.rank-input');
      var moveBtn = cardEl.querySelector('.edit-card-primary');

      function refreshDisabled() {
        moveBtn.disabled = clampRank(input.value, staged.length) === null;
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
      var n = clampRank(rawValue, staged.length);
      if (n === null) {
        return;
      }
      staged = moveToRank(staged, playerId, n);
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
      var movedIds = diffMovedIds(originalOrderIds, staged);
      var movedSet = {};
      movedIds.forEach(function (id) {
        movedSet[id] = true;
      });

      var indexOfId = {};
      staged.forEach(function (p, i) {
        indexOfId[p.id] = i;
      });

      var searching = editSearchText.trim() !== '';
      editRootEl.classList.toggle('edit-searching', searching);

      var rows = searching
        ? staged.filter(function (p) { return DC.state.matchesSearch(p, editSearchText); })
        : staged;

      listEl.innerHTML = rows.map(function (p) {
        var view = Object.assign({}, p, marksAtOpen[p.id], { rank: indexOfId[p.id] + 1 });
        return editRowHTML(view, { moved: !!movedSet[p.id] });
      }).join('');

      updateCountPill(movedIds.length);
      searchClearBtn.style.display = editSearchText !== '' ? '' : 'none';
    }

    // ---- open / close lifecycle ----

    function open() {
      var state = store.getState();
      staged = fromPlayers(state.players);
      marksAtOpen = state.marks;
      originalOrderIds = idsOf(state.players);
      editSearchText = '';
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
      var fromIndex = rows.indexOf(row);
      if (fromIndex === -1) {
        return;
      }

      var token = {};
      activeDrag = token;

      var pointerId = ev.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch (e) {
        // capture is best-effort; a drag that never captures still works via document listeners
      }

      var startClientY = ev.clientY;
      var startScrollTop = listEl.scrollTop;
      var marginBottom = parseFloat(getComputedStyle(row).marginBottom) || 0;
      var rowStep = row.offsetHeight + marginBottom;
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
        return dropIndexFromPointer(pointerYRelativeToList, listEl.scrollTop, rowStep, staged.length);
      }

      function applyGapShifts(newTargetIndex) {
        rows.forEach(function (r, idx) {
          if (idx === fromIndex) {
            return;
          }
          var shift = 0;
          if (newTargetIndex > fromIndex && idx > fromIndex && idx <= newTargetIndex) {
            shift = -rowStep;
          } else if (newTargetIndex < fromIndex && idx < fromIndex && idx >= newTargetIndex) {
            shift = rowStep;
          }
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
        var landedIndex = currentTargetIndex;
        teardownDrag();
        if (landedIndex !== fromIndex) {
          // dropIndexFromPointer returns a slot in [0..count]; a slot AFTER fromIndex already
          // accounts for the dragged row's own vacated position, so shift the destination back
          // by 1 to get a valid moveByIndex toIndex (moveByIndex itself clamps).
          var toIndex = landedIndex > fromIndex ? landedIndex - 1 : landedIndex;
          var movedId = staged[fromIndex].id;
          staged = moveByIndex(staged, fromIndex, toIndex);
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
      var target = ev.target.closest('[data-action]');
      if (!target) {
        return;
      }
      var action = target.getAttribute('data-action');
      var id = target.getAttribute('data-id');

      switch (action) {
        case 'cancel-edit':
          if (staged === null) {
            break; // already closing (e.g. a double-tap during the 150ms leaving window)
          }
          if (diffMovedIds(originalOrderIds, staged).length === 0) {
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
          if (stagedOrderChanged(staged, committedPlayers)) {
            store.dispatch({ type: 'REORDER_PLAYERS', order: idsOf(staged) });
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
        default:
          break;
      }
    });

    searchInputEl.addEventListener('input', function () {
      editSearchText = searchInputEl.value;
      renderEditList();
    });

    listEl.addEventListener('pointerdown', function (ev) {
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
      stagedOrderChanged: stagedOrderChanged,
      diffMovedIds: diffMovedIds
    },
    geom: {
      dropIndexFromPointer: dropIndexFromPointer,
      clampRank: clampRank,
      rankJumpTargetIndex: rankJumpTargetIndex
    },
    templates: {
      editRowHTML: editRowHTML
    },
    mount: mount
  };
})();
