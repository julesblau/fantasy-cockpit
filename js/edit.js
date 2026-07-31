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
    }
  };
})();
