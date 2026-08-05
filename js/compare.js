(function () {
  'use strict';
  window.DC = window.DC || {};

  var MIDDOT = '·';
  var EMDASH = '—';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // duplicated per the esc() precedent — not exported from state, not shared with ui.js/edit.js
  function tierChipHTML(tier) {
    var cls = DC.state.tierColorClass(tier);
    return cls ? '<span class="tier-chip ' + cls + '">T' + tier + '</span>' : '';
  }

  function adpRowHTML(label, value) {
    return '<div class="adp-row"><span class="adp-site">' + esc(label) + '</span><span class="adp-val">' + esc(value) + '</span></div>';
  }

  /**
   * @param {Object} state
   * @param {string[]} ids in caller order; ids missing from state.players are skipped (stale after import)
   * @returns {Array<{player:Object, posRank:number, pickNumber:(number|null), marks:Object}>}
   */
  function buildCards(state, ids) {
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });
    var posRanks = DC.state.positionRanks(state);
    var cards = [];
    ids.forEach(function (id) {
      var player = byId[id];
      if (!player) {
        return;
      }
      var marks = state.marks[id];
      cards.push({
        player: player,
        posRank: posRanks[id],
        pickNumber: marks && marks.drafted ? DC.state.pickNumber(state, id) : null,
        marks: marks
      });
    });
    return cards;
  }

  function cardHTML(card) {
    var player = card.player;
    var marks = card.marks || {};
    var adp = player.adp;
    var espnVal = adp ? adp.espn : EMDASH;
    var yahooVal = adp ? adp.yahoo : EMDASH;
    var sleeperVal = adp ? adp.sleeper : EMDASH;

    var statusHTML = '';
    if (marks.target) {
      statusHTML += DC.ui.icon('star');
    }
    if (marks.avoid) {
      statusHTML += DC.ui.icon('x');
    }
    if (marks.drafted) {
      var pickText = typeof card.pickNumber === 'number' ? card.pickNumber : EMDASH;
      statusHTML += DC.ui.icon('check') + '<span>Pick ' + pickText + '</span>';
    }
    if (marks.mine) {
      statusHTML += DC.ui.icon('user');
    }

    return (
      '<div class="compare-card" data-id="' + esc(player.id) + '">' +
        '<button class="compare-card-x" data-action="compare-remove-card" data-id="' + esc(player.id) + '">' + DC.ui.icon('x') + '</button>' +
        '<div class="compare-card-name">' + esc(player.name) + '</div>' +
        '<div class="compare-card-meta">' + esc(player.team) + ' ' + MIDDOT + ' ' + esc(player.position) + ' ' + MIDDOT + ' BYE ' + player.byeWeek + '</div>' +
        '<div class="compare-card-ranks">#' + player.rank + ' ' + MIDDOT + ' ' + esc(player.position) + card.posRank + tierChipHTML(player.tier) + '</div>' +
        '<div class="compare-card-adp">' +
          adpRowHTML('ESPN', espnVal) +
          adpRowHTML('Yahoo', yahooVal) +
          adpRowHTML('Sleeper', sleeperVal) +
        '</div>' +
        '<div class="compare-card-status">' + statusHTML + '</div>' +
      '</div>'
    );
  }

  /** @param {Array} cards @returns {string} cols-2 for <=2 cards, quad for 3-4; a hint cell fills the lone empty slot at 1 or 3 */
  function gridHTML(cards) {
    var isQuad = cards.length > 2;
    var html = cards.map(cardHTML).join('');
    if (cards.length === 1 || cards.length === 3) {
      html += '<div class="compare-empty-cell">Long-press players on the board to add more</div>';
    }
    return '<div class="compare-grid ' + (isQuad ? 'quad' : 'cols-2') + '">' + html + '</div>';
  }

  var HEADER_HTML = '<div class="compare-header"><div class="compare-title">Compare</div><button class="compare-done" data-action="compare-done">Done</button></div>';

  function mount(store) {
    var rootEl = document.getElementById('compare-root');
    var workingIds = [];
    var hooks = null;

    function render(state) {
      if (rootEl.hidden) {
        return;
      }
      workingIds = workingIds.filter(function (id) {
        return state.players.some(function (p) { return p.id === id; }); // stale after IMPORT_PLAYERS/CLEAR_ALL_DATA
      });
      if (workingIds.length < 1) {
        DC.compare.close();
        return;
      }
      rootEl.innerHTML = HEADER_HTML + gridHTML(buildCards(state, workingIds));
    }

    function removeCard(id) {
      var idx = workingIds.indexOf(id);
      if (idx !== -1) {
        workingIds.splice(idx, 1);
      }
      if (hooks && typeof hooks.onRemove === 'function') {
        hooks.onRemove(id); // keeps ui.js's tray chip + row ring in sync
      }
      if (workingIds.length === 0) {
        DC.compare.close();
        return;
      }
      render(store.getState());
    }

    rootEl.addEventListener('click', function (ev) {
      var target = ev.target.closest('[data-action]');
      if (!target) {
        return;
      }
      var action = target.getAttribute('data-action');
      if (action === 'compare-done') {
        DC.compare.close(); // survivors stay selected — never calls hooks.onRemove
        return;
      }
      if (action === 'compare-remove-card') {
        removeCard(target.getAttribute('data-id'));
      }
    });

    store.subscribe(function (state) {
      render(state); // mid-compare draft/undraft/mine toggles update the cards live
    });

    DC.compare.open = function (ids, h) {
      workingIds = ids.slice(); // caller's array is never held onto — mutating it afterward can't affect us
      hooks = h || null;
      rootEl.hidden = false;
      render(store.getState());
    };
    DC.compare.close = function () {
      rootEl.hidden = true;
      hooks = null;
      workingIds = [];
    };
  }

  DC.compare = { templates: { cardHTML: cardHTML, gridHTML: gridHTML }, mount: mount };
})();
