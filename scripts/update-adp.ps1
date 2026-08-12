# Fetches ESPN/Sleeper/Yahoo ADP, joins by normalized key, writes js/adp-data.js
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outFile = Join-Path $repoRoot "js\adp-data.js"
$dataJsPath = Join-Path $repoRoot "js\data.js"

$season = 2026
$scoring = "ppr"
$minUsablePerSource = 150
$liveTop10Ceiling = 15
$userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

$espnUrl = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info"
$espnFilter = '{"players":{"limit":500,"sortDraftRanks":{"sortPriority":1,"sortAsc":true,"value":"PPR"}}}'
$sleeperUrl = "https://api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF&order_by=adp_ppr"
$yahooBaseUrl = "https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2/game/nfl/players;position=ALL;start={0};count=100;sort=rank_season/draft_analysis?format=json_f"
$yahooPageStarts = @(0, 100, 200, 300)
$yahooPageDelayMs = 250

# app's 32 team codes (the only valid join-key team tokens)
$appTeams = @("ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS")
$appTeamSet = @{}
foreach ($t in $appTeams) { $appTeamSet[$t] = $true }

# uppercased source code -> app code; applied after uppercasing the raw source value
$teamFoldMap = @{ "JAC" = "JAX"; "WSH" = "WAS"; "LA" = "LAR"; "OAK" = "LV"; "SD" = "LAC" }

# ESPN proTeamId -> app team code (standard ESPN ids; 31/32 unused, not a gap)
$espnTeamMap = @{
    1 = "ATL"; 2 = "BUF"; 3 = "CHI"; 4 = "CIN"; 5 = "CLE"; 6 = "DAL"; 7 = "DEN"; 8 = "DET";
    9 = "GB"; 10 = "TEN"; 11 = "IND"; 12 = "KC"; 13 = "LV"; 14 = "LAR"; 15 = "MIA"; 16 = "MIN";
    17 = "NE"; 18 = "NO"; 19 = "NYG"; 20 = "NYJ"; 21 = "PHI"; 22 = "ARI"; 23 = "PIT"; 24 = "LAC";
    25 = "SF"; 26 = "SEA"; 27 = "TB"; 28 = "WAS"; 29 = "CAR"; 30 = "JAX"; 33 = "BAL"; 34 = "HOU"
}
$espnPositionMap = @{ 1 = "qb"; 2 = "rb"; 3 = "wr"; 4 = "te"; 5 = "k"; 16 = "dst" }
$sleeperPositionMap = @{ "QB" = "qb"; "RB" = "rb"; "WR" = "wr"; "TE" = "te"; "K" = "k"; "DEF" = "dst" }
$yahooPositionMap = @{ "QB" = "qb"; "RB" = "rb"; "WR" = "wr"; "TE" = "te"; "K" = "k"; "DEF" = "dst" }
$sourceOrder = @("espn", "yahoo", "sleeper")

function Fail($msg) {
    Write-Host "ERROR: $msg"
    exit 1
}

# PowerShell mirror of DC.state.normalizeAdpName in js/state.js - must match byte-for-byte
function Normalize-AdpName($s) {
    $n = ([string]$s).ToLowerInvariant()
    $n = $n.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $n.ToCharArray()) {
        $code = [int]$ch
        if ($code -lt 0x0300 -or $code -gt 0x036F) {
            [void]$sb.Append($ch)
        }
    }
    $n = $sb.ToString()
    $n = [regex]::Replace($n, '\s+(jr|sr|ii|iii|iv|v)\.?\s*$', '')
    $n = [regex]::Replace($n, '[^a-z0-9]+', '')
    return $n
}

# uppercase -> fold known variant -> validate against the app's 32-code set (gate 4)
function Fold-TeamCode($rawCode, $sourceName) {
    $upper = ([string]$rawCode).ToUpperInvariant()
    $folded = $upper
    if ($teamFoldMap.ContainsKey($upper)) {
        $folded = $teamFoldMap[$upper]
    }
    if (-not $appTeamSet.ContainsKey($folded)) {
        Fail("$sourceName has team code '$rawCode' (folded '$folded') not in the app's 32-code set")
    }
    return $folded
}

function Build-Key($name, $team, $pos) {
    if ($pos -eq "dst") {
        return ($team.ToLowerInvariant() + "|dst")
    }
    return ((Normalize-AdpName $name) + "|" + $pos)
}

# parses one source's rows into key -> rounded-double table; fails closed on within-source dup keys (gate 3)
function Build-SourceTable($rows, $sourceName, $keyFn) {
    $table = @{}
    $dupKeys = New-Object System.Collections.ArrayList
    $usable = 0
    foreach ($row in $rows) {
        $parsed = & $keyFn $row
        if ($null -eq $parsed) {
            continue
        }
        $usable++
        $key = $parsed.Key
        $value = [Math]::Round([double]$parsed.Value, 2)
        if ($table.ContainsKey($key)) {
            if (-not $dupKeys.Contains($key)) {
                [void]$dupKeys.Add($key)
            }
        }
        else {
            $table[$key] = $value
        }
    }
    if ($usable -lt $minUsablePerSource) {
        Fail("$sourceName parsed only $usable usable players (minimum $minUsablePerSource required)")
    }
    if ($dupKeys.Count -gt 0) {
        foreach ($k in $dupKeys) {
            Write-Host "ERROR: duplicate join key within $sourceName : '$k'"
        }
        exit 1
    }
    return $table
}

# ---- ESPN ---------------------------------------------------------------------------------

Write-Host "Fetching espn..."
try {
    $espnHeaders = @{ "x-fantasy-filter" = $espnFilter }
    $espnResp = Invoke-WebRequest -Uri $espnUrl -Headers $espnHeaders -UseBasicParsing
    $espnJson = $espnResp.Content | ConvertFrom-Json
}
catch {
    Fail("espn fetch failed: $($_.Exception.Message)")
}
if (-not $espnJson -or -not $espnJson.players -or $espnJson.players.Count -eq 0) {
    Fail("espn returned an empty player list")
}

$espnKeyFn = {
    param($row)
    $pl = $row.player
    if (-not $espnPositionMap.ContainsKey([int]$pl.defaultPositionId)) {
        return $null
    }
    $pos = $espnPositionMap[[int]$pl.defaultPositionId]
    $adp = $pl.ownership.averageDraftPosition
    if (-not $adp -or [double]$adp -le 0) {
        return $null
    }
    $team = $null
    if ($pos -eq "dst") {
        $teamId = [int]$pl.proTeamId
        if (-not $espnTeamMap.ContainsKey($teamId)) {
            Fail("espn has unmapped proTeamId '$teamId'")
        }
        $team = Fold-TeamCode $espnTeamMap[$teamId] "espn"
    }
    $key = Build-Key $pl.fullName $team $pos
    return @{ Key = $key; Value = $adp }
}
$espnTable = Build-SourceTable $espnJson.players "espn" $espnKeyFn

# ---- Sleeper -------------------------------------------------------------------------------

Write-Host "Fetching sleeper..."
try {
    $sleeperHeaders = @{ "User-Agent" = $userAgent }
    $sleeperResp = Invoke-WebRequest -Uri $sleeperUrl -Headers $sleeperHeaders -UseBasicParsing
    $sleeperJson = $sleeperResp.Content | ConvertFrom-Json
}
catch {
    Fail("sleeper fetch failed: $($_.Exception.Message)")
}
if (-not $sleeperJson -or $sleeperJson.Count -eq 0) {
    Fail("sleeper returned an empty player list")
}

$sleeperKeyFn = {
    param($row)
    $pl = $row.player
    if (-not $pl -or -not $sleeperPositionMap.ContainsKey($pl.position)) {
        return $null
    }
    $pos = $sleeperPositionMap[$pl.position]
    if (-not $row.stats) {
        return $null
    }
    $adpRaw = $row.stats.adp_ppr
    if ($null -eq $adpRaw) {
        return $null
    }
    $adpVal = [double]$adpRaw
    if ($adpVal -lt 1 -or $adpVal -ge 400) {
        return $null
    }
    $rawTeam = $pl.team
    $team = $null
    if ($rawTeam) {
        $team = Fold-TeamCode $rawTeam "sleeper"
    }
    if ($pos -eq "dst") {
        if (-not $team) {
            Fail("sleeper DEF row missing team code")
        }
        $key = Build-Key $null $team $pos
    }
    else {
        $name = ([string]$pl.first_name) + " " + ([string]$pl.last_name)
        $key = Build-Key $name $team $pos
    }
    return @{ Key = $key; Value = $adpVal }
}
$sleeperTable = Build-SourceTable $sleeperJson "sleeper" $sleeperKeyFn

# ---- Yahoo (paginated) ----------------------------------------------------------------------

Write-Host "Fetching yahoo..."
$yahooRows = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $yahooPageStarts.Count; $i++) {
    $start = $yahooPageStarts[$i]
    $url = [string]::Format($yahooBaseUrl, $start)
    try {
        $yahooHeaders = @{ "User-Agent" = $userAgent }
        $pageResp = Invoke-WebRequest -Uri $url -Headers $yahooHeaders -UseBasicParsing
        $pageJson = $pageResp.Content | ConvertFrom-Json
    }
    catch {
        Fail("yahoo fetch failed at start=$start : $($_.Exception.Message)")
    }
    $pagePlayers = $pageJson.fantasy_content.game.players
    if ($pagePlayers) {
        foreach ($p in $pagePlayers) {
            [void]$yahooRows.Add($p)
        }
    }
    if ($i -lt ($yahooPageStarts.Count - 1)) {
        Start-Sleep -Milliseconds $yahooPageDelayMs
    }
}
if ($yahooRows.Count -eq 0) {
    Fail("yahoo returned an empty player list")
}

$yahooKeyFn = {
    param($row)
    $pl = $row.player
    if (-not $pl -or -not $pl.display_position) {
        return $null
    }
    $firstTok = ($pl.display_position -split ",")[0]
    if (-not $yahooPositionMap.ContainsKey($firstTok)) {
        return $null
    }
    $pos = $yahooPositionMap[$firstTok]
    if (-not $pl.draft_analysis) {
        return $null
    }
    $apStr = $pl.draft_analysis.average_pick
    if ([string]::IsNullOrEmpty($apStr) -or $apStr -eq "-") {
        return $null
    }
    $apVal = 0.0
    $ok = [double]::TryParse($apStr, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$apVal)
    if (-not $ok -or $apVal -lt 1) {
        return $null
    }
    $rawTeam = $pl.editorial_team_abbr
    $team = $null
    if ($rawTeam) {
        $team = Fold-TeamCode $rawTeam "yahoo"
    }
    if ($pos -eq "dst") {
        if (-not $team) {
            Fail("yahoo DEF row missing team code")
        }
        $key = Build-Key $null $team $pos
    }
    else {
        $key = Build-Key $pl.name.full $team $pos
    }
    return @{ Key = $key; Value = $apVal }
}
$yahooTable = Build-SourceTable $yahooRows "yahoo" $yahooKeyFn

# ---- Join ----------------------------------------------------------------------------------

$joined = @{}
function Add-SourceToJoin($table, $srcName) {
    foreach ($k in $table.Keys) {
        if (-not $joined.ContainsKey($k)) {
            $joined[$k] = @{}
        }
        $joined[$k][$srcName] = $table[$k]
    }
}
Add-SourceToJoin $espnTable "espn"
Add-SourceToJoin $yahooTable "yahoo"
Add-SourceToJoin $sleeperTable "sleeper"

# liveness gate: the 10 lowest-consensus (best) entries must plausibly be early-round players (gate 5)
$consensusRows = New-Object System.Collections.ArrayList
foreach ($k in $joined.Keys) {
    $entry = $joined[$k]
    $sum = 0.0
    $cnt = 0
    foreach ($src in $sourceOrder) {
        if ($entry.ContainsKey($src)) {
            $sum += $entry[$src]
            $cnt++
        }
    }
    [void]$consensusRows.Add([double]($sum / $cnt))
}
$sortedConsensus = $consensusRows | Sort-Object
$top10 = $sortedConsensus | Select-Object -First 10
$maxTop10 = ($top10 | Measure-Object -Maximum).Maximum
if ($maxTop10 -gt $liveTop10Ceiling) {
    Fail("liveness check failed: top-10 consensus max is $maxTop10 (expected <= $liveTop10Ceiling)")
}

# ---- Write js/adp-data.js -------------------------------------------------------------------

$allKeys = [string[]]@($joined.Keys)
[array]::Sort($allKeys, [System.StringComparer]::Ordinal)

function Format-AdpNumber($v) {
    return $v.ToString("0.##", [System.Globalization.CultureInfo]::InvariantCulture)
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("// GENERATED FILE - do not edit by hand. Regenerate with scripts\update-adp.ps1.")
[void]$lines.Add("(function () {")
[void]$lines.Add("  'use strict';")
[void]$lines.Add("  window.DC = window.DC || {};")
[void]$lines.Add("  DC.adpData = {")
[void]$lines.Add("    updatedAt: '" + (Get-Date -Format "yyyy-MM-dd") + "',")
[void]$lines.Add("    season: " + $season + ",")
[void]$lines.Add("    scoring: '" + $scoring + "',")
[void]$lines.Add("    players: {")

for ($i = 0; $i -lt $allKeys.Count; $i++) {
    $k = $allKeys[$i]
    $entry = $joined[$k]
    $parts = New-Object System.Collections.ArrayList
    foreach ($src in $sourceOrder) {
        if ($entry.ContainsKey($src)) {
            [void]$parts.Add($src + ": " + (Format-AdpNumber $entry[$src]))
        }
    }
    $comma = ","
    if ($i -eq ($allKeys.Count - 1)) {
        $comma = ""
    }
    [void]$lines.Add("      '" + $k + "': { " + ($parts -join ", ") + " }" + $comma)
}

[void]$lines.Add("    }")
[void]$lines.Add("  };")
[void]$lines.Add("})();")

$content = ($lines -join "`r`n") + "`r`n"
try {
    [IO.File]::WriteAllText($outFile, $content, (New-Object System.Text.UTF8Encoding($false)))
}
catch {
    Fail("failed to write $outFile : $($_.Exception.Message)")
}

# ---- Seed coverage report (js/data.js RAW_PLAYERS) ------------------------------------------

try {
    $dataJsText = [IO.File]::ReadAllText($dataJsPath)
}
catch {
    Fail("failed to read $dataJsPath for coverage report: $($_.Exception.Message)")
}
$rawStart = $dataJsText.IndexOf("var RAW_PLAYERS = [")
if ($rawStart -lt 0) {
    Fail("could not find 'var RAW_PLAYERS = [' in js/data.js for coverage report")
}
$rawEnd = $dataJsText.IndexOf("];", $rawStart)
if ($rawEnd -lt 0) {
    Fail("could not find closing '];' for RAW_PLAYERS in js/data.js")
}
$rawBlock = $dataJsText.Substring($rawStart, $rawEnd - $rawStart)
$rowPattern = '\[\s*(?:"([^"]+)"|''([^'']+)'')\s*,\s*''([A-Za-z]+)''\s*,\s*''([A-Za-z]+)''\s*\]'
$rowMatches = [regex]::Matches($rawBlock, $rowPattern)
if ($rowMatches.Count -eq 0) {
    Fail("parsed zero seed players from RAW_PLAYERS for coverage report")
}

$seedTuples = New-Object System.Collections.ArrayList
foreach ($m in $rowMatches) {
    $name = $m.Groups[1].Value
    if (-not $m.Groups[1].Success) {
        $name = $m.Groups[2].Value
    }
    $team = $m.Groups[3].Value
    $pos = $m.Groups[4].Value
    [void]$seedTuples.Add(@{ Name = $name; Team = $team; Position = $pos })
}

$top100Total = [Math]::Min(100, $seedTuples.Count)
$top100Hits = 0
$totalHits = 0
$dstTotal = 0
$dstHits = 0
$top100Misses = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $seedTuples.Count; $i++) {
    $tuple = $seedTuples[$i]
    $pos = $tuple.Position.ToLowerInvariant()
    if ($pos -eq "dst") {
        $key = $tuple.Team.ToLowerInvariant() + "|dst"
    }
    else {
        $key = (Normalize-AdpName $tuple.Name) + "|" + $pos
    }
    $hit = $joined.ContainsKey($key)
    if ($hit) {
        $totalHits++
    }
    if ($pos -eq "dst") {
        $dstTotal++
        if ($hit) {
            $dstHits++
        }
    }
    if ($i -lt 100) {
        if ($hit) {
            $top100Hits++
        }
        else {
            [void]$top100Misses.Add($tuple.Name)
        }
    }
}

Write-Host ""
Write-Host "espn: $($espnTable.Count) usable players"
Write-Host "yahoo: $($yahooTable.Count) usable players"
Write-Host "sleeper: $($sleeperTable.Count) usable players"
Write-Host "joined: $($joined.Count) entries"
Write-Host ""
Write-Host "Seed coverage report:"
$top100Pct = [Math]::Round(100.0 * $top100Hits / $top100Total, 1)
$totalPct = [Math]::Round(100.0 * $totalHits / $seedTuples.Count, 1)
Write-Host "  top-100 hit-rate: $top100Hits/$top100Total ($top100Pct%)"
Write-Host "  TOTAL hit-rate: $totalHits/$($seedTuples.Count) ($totalPct%)"
Write-Host "  DST coverage: $dstHits/$dstTotal"
Write-Host "  top-100 misses:"
if ($top100Misses.Count -eq 0) {
    Write-Host "    (none)"
}
else {
    foreach ($miss in $top100Misses) {
        Write-Host "    - $miss"
    }
}

Write-Host ""
Write-Host "Wrote $outFile"
exit 0
