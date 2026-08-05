(function () {
  'use strict';
  window.DC = window.DC || {};

  /** @typedef {{id:string, rank:number, name:string, team:string, position:string, byeWeek:number, tier:(number|null)}} Player */

  var VALID_POSITIONS = { QB: true, RB: true, WR: true, TE: true, DST: true, K: true };
  var VALID_STATUSES = { AVAILABLE: true, TARGETS: true, AVOID: true, DRAFTED: true, MINE: true };
  var MAX_WARNINGS = 10;
  var POSITION_TOKEN_RE = /^(QB|RB|WR|TE|K|DST|DEF|D\/ST)\d*$/i;
  var LEADING_RANK_RE = /^\d+[.)]?$/;
  var HEADER_NAME_MAP = {
    RK: 'rank', RANK: 'rank',
    PLAYER: 'name', 'PLAYER NAME': 'name', NAME: 'name',
    TEAM: 'team',
    POS: 'position', POSITION: 'position',
    BYE: 'bye', 'BYE WEEK': 'bye',
    TIERS: 'tier', TIER: 'tier'
  };

  // ---- format detection ----------------------------------------------------

  /** @returns {"backup"|"rankings"} never throws */
  function detectFormat(text) {
    try {
      var trimmed = (typeof text === 'string' ? text : String(text || '')).trim();
      if (trimmed.charAt(0) !== '{') {
        return 'rankings';
      }
      var parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return 'rankings';
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          typeof parsed.schemaVersion === 'number' && Array.isArray(parsed.players)) {
        return 'backup';
      }
      return 'rankings';
    } catch (e) {
      return 'rankings';
    }
  }

  // ---- backup parsing --------------------------------------------------------

  /**
   * Mirrors DC.state's structural validator (state.js isValidState) so a
   * corrupt/foreign backup file never reaches localStorage via DC.state.save.
   * Field-agnostic: only checks the fields below exist with the right shape,
   * so v4 extras (per-player tier, top-level league) pass through untouched.
   */
  function isValidBackupState(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
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

  /** @returns {{ok:true, state:Object}|{ok:false, error:string}} never throws */
  function parseBackup(text) {
    try {
      var trimmed = (text || '').trim();
      var parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return { ok: false, error: "That file isn't valid JSON — couldn't load it as a backup." };
      }
      if (!isValidBackupState(parsed)) {
        return { ok: false, error: 'That backup file is missing required data or has an unexpected shape — could not load it.' };
      }
      return { ok: true, state: parsed };
    } catch (e) {
      return { ok: false, error: 'Could not read that backup file.' };
    }
  }

  // ---- rankings parsing: tokenizers ------------------------------------------

  function dequote(field) {
    var f = (field || '').trim();
    if (f.length >= 2 && f.charAt(0) === '"' && f.charAt(f.length - 1) === '"') {
      f = f.slice(1, -1).replace(/""/g, '"');
    }
    return f;
  }

  // handles double-quoted fields containing commas
  var CSV_SPLIT_RE = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;

  function splitCsvLine(line) {
    return line.split(CSV_SPLIT_RE).map(dequote);
  }

  function splitTabLine(line) {
    return line.split('\t').map(dequote);
  }

  function splitWhitespaceLine(line) {
    var cleaned = line.replace(/[()]/g, ' ');
    return cleaned.split(/\s+/).filter(function (tok) { return tok !== ''; });
  }

  // ---- rankings parsing: headerless line -> {name, team, positionRaw, byeRaw} ----

  function classifyHeaderless(tokens) {
    var toks = tokens.slice();
    if (toks.length && LEADING_RANK_RE.test(toks[0])) {
      toks.shift();
    }
    toks = toks.filter(function (tok) { return tok !== '(' && tok !== ')' && tok !== '-'; });

    var team = null;
    var position = null;
    var byeOverride = null;
    var nameTokens = [];

    toks.forEach(function (tok) {
      var cleaned = tok.replace(/^[()]+|[()]+$/g, '');
      if (cleaned === '') {
        return;
      }
      var upper = cleaned.toUpperCase();

      if (team === null && Object.prototype.hasOwnProperty.call(DC.data.TEAM_BYE_WEEKS, upper)) {
        team = upper;
        return;
      }
      if (position === null && POSITION_TOKEN_RE.test(cleaned)) {
        position = cleaned.toUpperCase();
        return;
      }
      if (/^\d{1,2}$/.test(cleaned)) {
        var n = parseInt(cleaned, 10);
        if (n >= 1 && n <= 18 && (team !== null || position !== null)) {
          byeOverride = n;
          return;
        }
      }
      nameTokens.push(cleaned);
    });

    return {
      name: nameTokens.join(' ').trim(),
      team: team || '',
      positionRaw: position || '',
      byeRaw: byeOverride !== null ? String(byeOverride) : ''
    };
  }

  function extractByColumns(tokens, columnMap) {
    function col(role) {
      var idx = columnMap[role];
      return idx !== undefined && tokens[idx] !== undefined ? tokens[idx] : '';
    }
    return {
      name: col('name'),
      team: col('team'),
      positionRaw: col('position'),
      byeRaw: col('bye'),
      tierRaw: col('tier')
    };
  }

  // canonicalize before the gate — headerless D/ST tokens and column DEF cells
  // must resolve to DST here, or a widened gate still can't match them
  var POSITION_CANON_MAP = { DEF: 'DST', 'D/ST': 'DST' };

  function normalizePosition(raw) {
    var stripped = (raw || '').replace(/\d+$/, '').toUpperCase();
    return POSITION_CANON_MAP[stripped] || stripped;
  }

  // base-10 int >= 1 only; "", "0", floats ("2.5"), and other junk -> null
  function parseTierCell(raw) {
    var s = (raw || '').trim();
    if (!/^\d+$/.test(s)) {
      return null;
    }
    var n = parseInt(s, 10);
    return n >= 1 ? n : null;
  }

  function addWarning(ctx, msg) {
    ctx.warningsRaw.push(msg);
  }

  function capWarnings(warningsRaw) {
    if (warningsRaw.length <= MAX_WARNINGS) {
      return warningsRaw.slice();
    }
    var capped = warningsRaw.slice(0, MAX_WARNINGS);
    capped.push('...and ' + (warningsRaw.length - MAX_WARNINGS) + ' more');
    return capped;
  }

  /**
   * @param {{name:string, team:string, positionRaw:string, byeRaw:string, tierRaw:string}} raw
   * @param {{players:Player[], skipped:number, warningsRaw:string[], seenIds:Object<string,boolean>}} ctx
   */
  function finalizeCandidate(raw, ctx) {
    var name = (raw.name || '').trim();
    var positionRaw = (raw.positionRaw || '').trim();
    var teamRaw = (raw.team || '').trim();
    var byeRaw = (raw.byeRaw || '').trim();

    if (positionRaw === '') {
      // name-only lines carry no position at all — can't be classified, so warn
      ctx.skipped++;
      addWarning(ctx, 'Skipped "' + (name || '(blank line)') + '": no position found.');
      return;
    }

    var position = normalizePosition(positionRaw);
    if (!VALID_POSITIONS[position]) {
      // skip counter now means genuinely-unrecognized position tokens only
      ctx.skipped++;
      return;
    }

    if (name === '') {
      ctx.skipped++;
      addWarning(ctx, 'Skipped a line with no player name.');
      return;
    }

    var team = teamRaw === '' ? 'FA' : teamRaw.toUpperCase();
    // byeWeek 0 (no known bye) renders as "-" in the UI — see Task 5
    var byeWeek = DC.data.TEAM_BYE_WEEKS[team] !== undefined ? DC.data.TEAM_BYE_WEEKS[team] : 0;
    var byeNum = parseInt(byeRaw, 10);
    if (byeRaw !== '' && !isNaN(byeNum) && byeNum >= 1 && byeNum <= 18) {
      byeWeek = byeNum;
    }

    // headerless lines carry no tierRaw at all -> parseTierCell('') -> null; no heuristic here
    var tier = parseTierCell(raw.tierRaw);

    var id = DC.data.slug(name, team);
    if (ctx.seenIds[id]) {
      addWarning(ctx, 'Skipped duplicate player "' + name + '" (' + team + ').');
      return;
    }
    ctx.seenIds[id] = true;
    ctx.players.push({
      id: id,
      rank: ctx.players.length + 1,
      name: name,
      team: team,
      position: position,
      byeWeek: byeWeek,
      // as parsed from the file, un-normalized — IMPORT_PLAYERS reducer owns tier monotonicity, not this parser
      tier: tier,
      adp: null // imports have no ADP source yet
    });
  }

  function notEnoughPlayersError(foundCount) {
    return {
      ok: false,
      error: "Couldn't find at least 5 players in this file (found " + foundCount + "). Check the format and try again."
    };
  }

  function doParseRankings(text) {
    var rawLines = (text || '').split(/\r\n|\r|\n/);
    var lines = rawLines.filter(function (l) { return l.trim() !== ''; });

    if (lines.length < 5) {
      return notEnoughPlayersError(lines.length);
    }

    var hasTabDelim = lines.some(function (l) { return (l.split('\t').length - 1) >= 2; });
    var delimiter;
    if (hasTabDelim) {
      delimiter = 'tab';
    } else {
      var firstLineCommaCount = lines[0].split(',').length - 1;
      delimiter = firstLineCommaCount >= 2 ? 'comma' : 'whitespace';
    }

    function tokenize(line) {
      if (delimiter === 'tab') {
        return splitTabLine(line);
      }
      if (delimiter === 'comma') {
        return splitCsvLine(line);
      }
      return splitWhitespaceLine(line);
    }

    var firstTokens = tokenize(lines[0]);
    var columnMap = {};
    firstTokens.forEach(function (tok, idx) {
      var key = (tok || '').trim().toUpperCase();
      var role = HEADER_NAME_MAP[key];
      if (role && columnMap[role] === undefined) {
        columnMap[role] = idx;
      }
    });
    // a single keyword match is not enough to call it a header — a real player
    // name or list line can coincidentally contain one keyword (e.g. "Player").
    // Real header lines also never contain an actual team code or position
    // value (they contain the column NAMES "TEAM"/"POS", not values like "KC"/"RB").
    var looksLikeDataRow = firstTokens.some(function (tok) {
      var cleaned = (tok || '').trim();
      if (cleaned === '') {
        return false;
      }
      var upper = cleaned.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(DC.data.TEAM_BYE_WEEKS, upper)) {
        return true;
      }
      return POSITION_TOKEN_RE.test(cleaned);
    });
    var hasHeader = Object.keys(columnMap).length >= 2 && !looksLikeDataRow;
    var dataLines = hasHeader ? lines.slice(1) : lines;

    var ctx = { players: [], skipped: 0, warningsRaw: [], seenIds: {} };

    dataLines.forEach(function (line) {
      var tokens = tokenize(line);
      var raw = hasHeader ? extractByColumns(tokens, columnMap) : classifyHeaderless(tokens);
      finalizeCandidate(raw, ctx);
    });

    if (ctx.players.length < 5) {
      return notEnoughPlayersError(ctx.players.length);
    }

    return {
      ok: true,
      players: ctx.players,
      skipped: ctx.skipped,
      warnings: capWarnings(ctx.warningsRaw)
    };
  }

  /** @returns {{ok:true, players:Player[], skipped:number, warnings:string[]}|{ok:false, error:string}} never throws */
  function parseRankings(text) {
    try {
      return doParseRankings(text);
    } catch (e) {
      return { ok: false, error: 'Could not read that file — please check the format and try again.' };
    }
  }

  DC.importer = { parseRankings: parseRankings, parseBackup: parseBackup, detectFormat: detectFormat };
})();
