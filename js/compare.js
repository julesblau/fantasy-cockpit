(function () {
  'use strict';
  window.DC = window.DC || {};

  var MIDDOT = '·';
  var EMDASH = '—';
  var SLACK = 3; // picks of cushion on either side of a bucket boundary
  var BACK_TO_BACK_MAX_GAP = 1; // following - current this small means no one else picks in between -- his own next pick, not a rival's
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

  // avatarHTML duplicated from ui.js (44px box via .avatar-lg, ESPN combiner at w=96&h=70 for
  // 2x) — same esc()/tierChipHTML precedent, not exported/shared
  function avatarHTML(player) {
    var src = null;
    if (player && player.position === 'DST') {
      src = 'https://sleepercdn.com/images/team_logos/nfl/' + String(player.team).toLowerCase() + '.png';
    } else {
      var key = DC.state.adpKey(player);
      var imageId = key && DC.adpData && DC.adpData.images && DC.adpData.images[key];
      if (imageId) {
        src = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/' + imageId + '.png&w=96&h=70';
      }
    }
    var inner = src
      ? '<img class="player-avatar" src="' + esc(src) + '" alt="" loading="lazy" onerror="this.classList.add(\'avatar-error\')">'
      : '<span class="player-avatar avatar-empty"></span>';
    return '<span class="player-avatar-box avatar-lg">' + inner + '</span>';
  }

  function adpRowHTML(label, value) {
    return '<div class="adp-row"><span class="adp-site">' + esc(label) + '</span><span class="adp-val">' + esc(value) + '</span></div>';
  }

  // isAdpNum semantics duplicated from state.js -- not exported, same esc()/tierChipHTML precedent
  function isAdpNum(n) {
    return typeof n === 'number' && isFinite(n) && n >= 1;
  }

  /** @param {*} iso YYYY-MM-DD @returns {string|null} short human date e.g. 'Aug 12'; string-parsed, no Date object */
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

  /**
   * @param {number|null} a consensus ADP, or null when the player has no ADP data
   * @param {{current:number, next:(number|null), following:(number|null)}} picks
   * @returns {{cls:string, text:string}}
   */
  function verdictFor(a, picks) {
    if (a === null) {
      return { cls: 'verdict-none', text: 'no ADP data' };
    }
    var adpLabel = 'ADP ' + a;
    if (picks.next === null) {
      if (a < picks.current) {
        return { cls: 'verdict-green', text: adpLabel + ' ' + MIDDOT + ' ' + Math.round(picks.current - a) + ' past ADP ' + EMDASH + ' value now' };
      }
      if (a === picks.current) {
        return { cls: 'verdict-orange', text: adpLabel + ' ' + MIDDOT + ' at his market price now' };
      }
      return { cls: 'verdict-wait', text: adpLabel + ' ' + MIDDOT + ' market price in ' + Math.round(a - picks.current) + ' picks' };
    }
    if (picks.next === picks.current) {
      if (picks.following - picks.current <= BACK_TO_BACK_MAX_GAP) {
        return { cls: 'verdict-wait', text: adpLabel + ' ' + MIDDOT + ' on the clock ' + EMDASH + ' you also pick #' + picks.following };
      }
      if (a <= picks.following - SLACK) {
        return { cls: 'verdict-red', text: adpLabel + ' ' + MIDDOT + ' on the clock ' + EMDASH + ' gone by #' + picks.following };
      }
      if (a <= picks.following + SLACK) {
        return { cls: 'verdict-orange', text: adpLabel + ' ' + MIDDOT + ' on the clock ' + EMDASH + ' coin flip at #' + picks.following };
      }
      return { cls: 'verdict-wait', text: adpLabel + ' ' + MIDDOT + ' on the clock ' + EMDASH + ' likely there at #' + picks.following };
    }
    if (a <= picks.next - SLACK) {
      return { cls: 'verdict-red', text: adpLabel + ' ' + MIDDOT + ' likely gone by your #' + picks.next };
    }
    if (a <= picks.next + SLACK) {
      return { cls: 'verdict-orange', text: adpLabel + ' ' + MIDDOT + ' coin flip at your #' + picks.next };
    }
    if (a <= picks.following - SLACK) {
      return { cls: 'verdict-green', text: adpLabel + ' ' + MIDDOT + ' should reach #' + picks.next + ' ' + EMDASH + ' gone by #' + picks.following };
    }
    if (a <= picks.following + SLACK) {
      return { cls: 'verdict-orange', text: adpLabel + ' ' + MIDDOT + ' reaches #' + picks.next + ' ' + EMDASH + ' coin flip at #' + picks.following };
    }
    return { cls: 'verdict-wait', text: adpLabel + ' ' + MIDDOT + ' can wait ' + EMDASH + ' likely there at #' + picks.following };
  }

  /**
   * @param {Object} state
   * @param {string[]} ids in caller order; ids missing from state.players are skipped (stale after import)
   * @returns {Array<{player:Object, adp:(Object|null), posRank:number, pickNumber:(number|null), marks:Object, verdict:{cls:string, text:string}}>}
   */
  function buildCards(state, ids) {
    var byId = {};
    state.players.forEach(function (p) { byId[p.id] = p; });
    var posRanks = DC.state.positionRanks(state);
    var picks = DC.state.upcomingPicks(state);
    var cards = [];
    ids.forEach(function (id) {
      var player = byId[id];
      if (!player) {
        return;
      }
      var marks = state.marks[id];
      cards.push({
        player: player,
        adp: DC.state.adpForPlayer(player),
        posRank: posRanks[id],
        pickNumber: marks && marks.drafted ? DC.state.pickNumber(state, id) : null,
        marks: marks,
        verdict: marks && marks.drafted
          ? { cls: 'verdict-none', text: 'drafted' }
          : verdictFor(DC.state.adpConsensus(player), picks)
      });
    });
    return cards;
  }

  function cardHTML(card) {
    var player = card.player;
    var marks = card.marks || {};
    var adp = card.adp;
    var espnVal = adp && isAdpNum(adp.espn) ? adp.espn : EMDASH;
    var yahooVal = adp && isAdpNum(adp.yahoo) ? adp.yahoo : EMDASH;
    var sleeperVal = adp && isAdpNum(adp.sleeper) ? adp.sleeper : EMDASH;
    var weightedConsensus = DC.state.adpConsensus(player);
    var weightedVal = typeof weightedConsensus === 'number' ? weightedConsensus : EMDASH;

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
        '<button class="compare-card-x" data-action="compare-remove-card" data-id="' + esc(player.id) + '" aria-label="Remove from compare">' + DC.ui.icon('x') + '</button>' +
        '<div class="compare-card-head">' +
          avatarHTML(player) +
          '<div class="compare-card-meta">' + esc(player.team) + ' ' + MIDDOT + ' ' + esc(player.position) + ' ' + MIDDOT + ' BYE ' + player.byeWeek + '</div>' +
        '</div>' +
        '<div class="compare-card-name">' + esc(player.name) + '</div>' +
        '<div class="compare-card-ranks">#' + player.rank + ' ' + MIDDOT + ' ' + esc(player.position) + card.posRank + tierChipHTML(player.tier) + '</div>' +
        '<div class="compare-card-adp">' +
          adpRowHTML('ESPN', espnVal) +
          adpRowHTML('Yahoo', yahooVal) +
          adpRowHTML('Sleeper', sleeperVal) +
          adpRowHTML('Weighted', weightedVal) +
        '</div>' +
        '<div class="compare-verdict ' + card.verdict.cls + '">' + esc(card.verdict.text) + '</div>' +
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

  function headerHTML() {
    var updated = DC.adpData ? shortAdpDate(DC.adpData.updatedAt) : null;
    var updatedHTML = updated ? '<div class="compare-adp-updated">ADP as of ' + esc(updated) + '</div>' : '';
    return (
      '<div class="compare-header">' +
        '<div><div class="compare-title">Compare</div>' + updatedHTML + '</div>' +
        '<button class="compare-done" data-action="compare-done">Done</button>' +
      '</div>'
    );
  }

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
      rootEl.innerHTML = headerHTML() + gridHTML(buildCards(state, workingIds));
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

  DC.compare = { templates: { buildCards: buildCards, cardHTML: cardHTML, gridHTML: gridHTML }, mount: mount };
})();
