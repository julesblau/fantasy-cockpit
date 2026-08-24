(function () {
  'use strict';
  window.DC = window.DC || {};

  var SLEEPER_URL = 'https://api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=adp_ppr';
  var ESPN_URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info';
  var ESPN_FILTER = '{"players":{"limit":500,"sortDraftRanks":{"sortPriority":1,"sortAsc":true,"value":"PPR"}}}';
  var MIN_USABLE = 150;

  // uppercased source code -> app code, applied after uppercasing the raw source value (mirrors scripts/update-adp.ps1)
  var TEAM_FOLD = { JAC: 'JAX', WSH: 'WAS', LA: 'LAR', OAK: 'LV', SD: 'LAC' };

  // ESPN proTeamId -> app team code; verbatim copy of scripts/update-adp.ps1's $espnTeamMap
  var ESPN_TEAM_MAP = {
    1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
    9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN',
    17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
    25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };
  var ESPN_POSITION_MAP = { 1: 'qb', 2: 'rb', 3: 'wr', 4: 'te', 5: 'k', 16: 'dst' };
  var SLEEPER_POSITION_MAP = { QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', K: 'k', DEF: 'dst' };

  function foldTeam(code) {
    var upper = String(code).toUpperCase();
    return TEAM_FOLD.hasOwnProperty(upper) ? TEAM_FOLD[upper] : upper;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function dstKey(rawTeamCode) {
    return foldTeam(rawTeamCode).toLowerCase() + '|dst';
  }

  // ---- sleeper row -> {key, value} or null -------------------------------------------------

  function parseSleeperRow(row) {
    var pl = row && row.player;
    if (!pl || !SLEEPER_POSITION_MAP.hasOwnProperty(pl.position)) {
      return null;
    }
    var pos = SLEEPER_POSITION_MAP[pl.position];
    var stats = row.stats;
    var adpRaw = stats && stats.adp_ppr;
    if (typeof adpRaw !== 'number' || !isFinite(adpRaw) || adpRaw < 1 || adpRaw >= 400) {
      return null;
    }
    var key;
    if (pos === 'dst') {
      if (!pl.team) {
        return null;
      }
      key = dstKey(pl.team);
    } else {
      var name = String(pl.first_name || '') + ' ' + String(pl.last_name || '');
      key = DC.state.normalizeAdpName(name) + '|' + pos;
    }
    return { key: key, value: round2(adpRaw) };
  }

  // ---- espn row -> {key, value} or null ----------------------------------------------------

  function parseEspnRow(row) {
    var pl = row && row.player;
    if (!pl || !ESPN_POSITION_MAP.hasOwnProperty(pl.defaultPositionId)) {
      return null;
    }
    var pos = ESPN_POSITION_MAP[pl.defaultPositionId];
    // ownership.averageDraftPosition blends all ESPN league formats (DST/K land rounds too early); PPR-scoped draft rank tracks the reference far more closely
    var adp = pl.draftRanksByRankType && pl.draftRanksByRankType.PPR && pl.draftRanksByRankType.PPR.rank;
    if (typeof adp !== 'number' || !isFinite(adp) || adp <= 0) {
      return null;
    }
    var key;
    if (pos === 'dst') {
      var teamCode = ESPN_TEAM_MAP[pl.proTeamId];
      if (!teamCode) {
        return null;
      }
      key = dstKey(teamCode);
    } else {
      key = DC.state.normalizeAdpName(pl.fullName) + '|' + pos;
    }
    return { key: key, value: round2(adp) };
  }

  // plain object accumulation, no sort; last write wins on an in-source key collision
  function buildTable(rows, parseFn) {
    var table = {};
    var usable = 0;
    rows.forEach(function (row) {
      var parsed = parseFn(row);
      if (!parsed) {
        return;
      }
      usable++;
      table[parsed.key] = parsed.value;
    });
    return { table: table, usable: usable };
  }

  function fetchSleeper() {
    return fetch(SLEEPER_URL).then(function (res) {
      if (!res.ok) {
        throw new Error('Sleeper refresh failed (HTTP ' + res.status + ')');
      }
      return res.json();
    });
  }

  function fetchEspn() {
    return fetch(ESPN_URL, { headers: { 'x-fantasy-filter': ESPN_FILTER } }).then(function (res) {
      if (!res.ok) {
        throw new Error('ESPN refresh failed (HTTP ' + res.status + ')');
      }
      return res.json();
    });
  }

  // local date (not UTC), matching scripts/update-adp.ps1's Get-Date default
  function isoDate(d) {
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /** @returns {Promise<{ok:true, counts:{espn:number, sleeper:number}}>} rejects with a user-displayable Error; no partial writes */
  function run() {
    return Promise.all([fetchSleeper(), fetchEspn()]).then(function (results) {
      var sleeperRows = Array.isArray(results[0]) ? results[0] : [];
      var espnJson = results[1];
      var espnRows = (espnJson && Array.isArray(espnJson.players)) ? espnJson.players : [];

      var sleeper = buildTable(sleeperRows, parseSleeperRow);
      var espn = buildTable(espnRows, parseEspnRow);

      if (sleeper.usable < MIN_USABLE) {
        throw new Error('Sleeper ADP refresh returned only ' + sleeper.usable + ' usable players (need ' + MIN_USABLE + ')');
      }
      if (espn.usable < MIN_USABLE) {
        throw new Error('ESPN ADP refresh returned only ' + espn.usable + ' usable players (need ' + MIN_USABLE + ')');
      }

      var keys = {};
      Object.keys(espn.table).forEach(function (k) { keys[k] = true; });
      Object.keys(sleeper.table).forEach(function (k) { keys[k] = true; });

      var players = {};
      Object.keys(keys).forEach(function (key) {
        var entry = {};
        if (espn.table.hasOwnProperty(key)) { entry.espn = espn.table[key]; }
        if (sleeper.table.hasOwnProperty(key)) { entry.sleeper = sleeper.table[key]; }
        players[key] = entry;
      });

      var override = {
        updatedAt: isoDate(new Date()),
        sources: ['espn', 'sleeper'],
        players: players
      };

      localStorage.setItem(DC.state.ADP_OVERRIDE_KEY, JSON.stringify(override));
      DC.state.reloadAdpOverride();

      return { ok: true, counts: { espn: espn.usable, sleeper: sleeper.usable } };
    });
  }

  DC.adpRefresh = { run: run };
})();
