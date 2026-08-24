# Bakes the user's real rankings (board-source/*.csv + board-manual.json) into js/data.js.
# PS 5.1. Fetches real 2026 bye weeks from ESPN — fails closed, never emits on a bad/incomplete fetch.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$srcDir = Join-Path $repoRoot "scripts\board-source"
$manualPath = Join-Path $repoRoot "scripts\board-manual.json"
$outFile = Join-Path $repoRoot "js\data.js"

$season = 2026
$curlUA = "curl/8.4.0" # site.api.espn.com 403s a browser-style UA via Invoke-WebRequest; a curl-style UA passes

function Fail($msg) {
    Write-Host "ERROR: $msg"
    exit 1
}

# PowerShell mirror of DC.state.normalizeAdpName in js/state.js - must match byte-for-byte
# (copied verbatim from scripts/update-adp.ps1:44-59)
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

# PowerShell mirror of DC.data.slug in js/data.js - must match byte-for-byte
function Get-Slug($name, $team) {
    $s = ($name + '-' + $team).ToLowerInvariant()
    $s = [regex]::Replace($s, '[^a-z0-9]+', '-')
    $s = [regex]::Replace($s, '^-+|-+$', '')
    return $s
}

# fallback band tiers, copied verbatim from js/data.js tierFor (used only if a whole position
# is absent from board-manual.json - not exercised by today's inputs)
$NARROW_TIER_BANDS = @(3, 3, 4, 5, 6) # QB/TE/K/DST
$WIDE_TIER_BANDS = @(4, 6, 8, 10, 12, 14) # RB/WR
function Get-BandTier($position, $posIndex) {
    $bands = $NARROW_TIER_BANDS
    if ($position -eq 'RB' -or $position -eq 'WR') {
        $bands = $WIDE_TIER_BANDS
    }
    $cum = 0
    for ($i = 0; $i -lt $bands.Count; $i++) {
        $cum += $bands[$i]
        if ($posIndex -le $cum) {
            return $i + 1
        }
    }
    return 7
}

# app's 32 team codes (the only valid join-key team tokens)
$appTeams = @("ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS")
$appTeamSet = @{}
foreach ($t in $appTeams) { $appTeamSet[$t] = $true }

# ESPN proTeamId -> app team code (copied verbatim from scripts/update-adp.ps1:29-34)
$espnTeamMap = @{
    1 = "ATL"; 2 = "BUF"; 3 = "CHI"; 4 = "CIN"; 5 = "CLE"; 6 = "DAL"; 7 = "DEN"; 8 = "DET";
    9 = "GB"; 10 = "TEN"; 11 = "IND"; 12 = "KC"; 13 = "LV"; 14 = "LAR"; 15 = "MIA"; 16 = "MIN";
    17 = "NE"; 18 = "NO"; 19 = "NYG"; 20 = "NYJ"; 21 = "PHI"; 22 = "ARI"; 23 = "PIT"; 24 = "LAC";
    25 = "SF"; 26 = "SEA"; 27 = "TB"; 28 = "WAS"; 29 = "CAR"; 30 = "JAX"; 33 = "BAL"; 34 = "HOU"
}
$appCodeToEspnId = @{}
foreach ($id in $espnTeamMap.Keys) { $appCodeToEspnId[$espnTeamMap[$id]] = $id }

# franchise name (board-source/dst.csv Name column) -> app display name
$dstNameMap = @{
    "Seattle Seahawks" = "Seahawks D/ST"; "Los Angeles Rams" = "Rams D/ST"; "Los Angeles Chargers" = "Chargers D/ST";
    "Houston Texans" = "Texans D/ST"; "Philadelphia Eagles" = "Eagles D/ST"; "Denver Broncos" = "Broncos D/ST";
    "Jacksonville Jaguars" = "Jaguars D/ST"; "Chicago Bears" = "Bears D/ST"; "Baltimore Ravens" = "Ravens D/ST";
    "New England Patriots" = "Patriots D/ST"; "Pittsburgh Steelers" = "Steelers D/ST"; "Green Bay Packers" = "Packers D/ST";
    "Minnesota Vikings" = "Vikings D/ST"; "Kansas City Chiefs" = "Chiefs D/ST"; "Detroit Lions" = "Lions D/ST";
    "Atlanta Falcons" = "Falcons D/ST"; "Cleveland Browns" = "Browns D/ST"; "Buffalo Bills" = "Bills D/ST";
    "New York Giants" = "Giants D/ST"; "Tampa Bay Buccaneers" = "Buccaneers D/ST"; "Carolina Panthers" = "Panthers D/ST";
    "Las Vegas Raiders" = "Raiders D/ST"; "Dallas Cowboys" = "Cowboys D/ST"; "New Orleans Saints" = "Saints D/ST";
    "Tennessee Titans" = "Titans D/ST"; "San Francisco 49ers" = "49ers D/ST"; "New York Jets" = "Jets D/ST";
    "Indianapolis Colts" = "Colts D/ST"; "Miami Dolphins" = "Dolphins D/ST"; "Cincinnati Bengals" = "Bengals D/ST";
    "Washington Commanders" = "Commanders D/ST"; "Arizona Cardinals" = "Cardinals D/ST"
}

# K/DST interleave consensus source: adp.csv AVG column (Flock's multi-site average, incl. Yahoo/CBS/FFPC)

# ---- Step 1: parse REDRAFT (skill order) ------------------------------------------------------

$redraftCsv = Import-Csv (Join-Path $srcDir "REDRAFT-rankings.csv")
if ($redraftCsv.Count -lt 350) {
    Fail("REDRAFT-rankings.csv parsed only $($redraftCsv.Count) rows (minimum 350 required)")
}

$skillRaw = New-Object System.Collections.ArrayList
foreach ($r in $redraftCsv) {
    $blank = [string]::IsNullOrWhiteSpace($r.Team)
    $team = "FA"
    if (-not $blank) { $team = $r.Team.ToUpperInvariant() }
    $pos = $r.Position.Trim()
    [void]$skillRaw.Add([PSCustomObject]@{ Name = $r.Name; Team = $team; TeamBlank = $blank; Position = $pos; Tier = $null; Weighted = $null })
}

# ---- Step 2: name|pos dedup gate ---------------------------------------------------------------

$dedupGroups = @{}
for ($i = 0; $i -lt $skillRaw.Count; $i++) {
    $key = (Normalize-AdpName $skillRaw[$i].Name) + '|' + $skillRaw[$i].Position
    if (-not $dedupGroups.ContainsKey($key)) { $dedupGroups[$key] = New-Object System.Collections.ArrayList }
    [void]$dedupGroups[$key].Add($i)
}

$dropSet = @{}
$dedupDropped = New-Object System.Collections.ArrayList
foreach ($key in $dedupGroups.Keys) {
    $idxList = $dedupGroups[$key]
    if ($idxList.Count -eq 1) { continue }
    if ($idxList.Count -ge 3) {
        Fail("3+ skill rows collide on dedup key '$key' (" + $idxList.Count + " rows)")
    }
    $i0 = $idxList[0]; $i1 = $idxList[1]
    $row0 = $skillRaw[$i0]; $row1 = $skillRaw[$i1]
    $keepIdx = $i0
    $dropIdx = $i1
    if ($row0.TeamBlank -and -not $row1.TeamBlank) { $keepIdx = $i1; $dropIdx = $i0 }
    elseif ((-not $row0.TeamBlank) -and $row1.TeamBlank) { $keepIdx = $i0; $dropIdx = $i1 }
    Write-Host ("WARN: dedup collision on '" + $key + "': row=[" + $row0.Name + "|" + $row0.Team + "] vs row=[" + $row1.Name + "|" + $row1.Team + "] -- keeping " + $skillRaw[$keepIdx].Name + "|" + $skillRaw[$keepIdx].Team + ", dropping " + $skillRaw[$dropIdx].Name + "|" + $skillRaw[$dropIdx].Team)
    $dropSet[$dropIdx] = $true
    [void]$dedupDropped.Add($skillRaw[$dropIdx])
}

$skillDeduped = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $skillRaw.Count; $i++) {
    if (-not $dropSet.ContainsKey($i)) { [void]$skillDeduped.Add($skillRaw[$i]) }
}

$verifyKeys = @{}
foreach ($row in $skillDeduped) {
    $k = (Normalize-AdpName $row.Name) + '|' + $row.Position
    if ($verifyKeys.ContainsKey($k)) {
        Fail("residual duplicate skill key after dedup: $k")
    }
    $verifyKeys[$k] = $true
}

if ($skillDeduped.Count -lt 350) {
    Fail("only $($skillDeduped.Count) skill players survived dedup (minimum 350 required)")
}

# ---- Step 3: parse k.csv / dst.csv (positional order) ------------------------------------------

$kCsv = Import-Csv (Join-Path $srcDir "k.csv")
if ($kCsv.Count -lt 30) {
    Fail("k.csv parsed only $($kCsv.Count) rows (minimum 30 required)")
}
$kPlayers = New-Object System.Collections.ArrayList
foreach ($r in $kCsv) {
    $team = "FA"
    if (-not [string]::IsNullOrWhiteSpace($r.Team)) { $team = $r.Team.ToUpperInvariant() }
    [void]$kPlayers.Add([PSCustomObject]@{ Name = $r.Name; Team = $team; Position = "K"; Weighted = $null })
}

$dstCsv = Import-Csv (Join-Path $srcDir "dst.csv")
if ($dstCsv.Count -lt 30) {
    Fail("dst.csv parsed only $($dstCsv.Count) rows (minimum 30 required)")
}
$dstPlayers = New-Object System.Collections.ArrayList
foreach ($r in $dstCsv) {
    if (-not $dstNameMap.ContainsKey($r.Name)) {
        Fail("no D/ST display-name mapping for franchise '$($r.Name)'")
    }
    $team = $r.Team.ToUpperInvariant()
    [void]$dstPlayers.Add([PSCustomObject]@{ Name = $dstNameMap[$r.Name]; Team = $team; Position = "DST"; Weighted = $null })
}

# ---- Step 6 (moved earlier - fail fast on network before doing the rest): real 2026 byes -------

Write-Host "Probing ESPN bye endpoint (team 22 / ARI)..."
$probeUrl = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/22/schedule?season=$season&seasontype=2"
try {
    $probeResp = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 20 -UserAgent $curlUA
    $probeJson = $probeResp.Content | ConvertFrom-Json
}
catch {
    Fail("ESPN bye probe failed: $($_.Exception.Message)")
}
$probeHasBye = $false
foreach ($p in $probeJson.PSObject.Properties) {
    if ($p.Name -eq 'byeWeek') { $probeHasBye = $true }
}
if (-not $probeHasBye -or $null -eq $probeJson.byeWeek) {
    Fail("ESPN bye probe: no usable byeWeek field on team 22 response ($probeUrl)")
}
Write-Host "Probe OK: ARI byeWeek=$($probeJson.byeWeek) -- fetching all 32 teams"

$TEAM_BYE_WEEKS = @{}
foreach ($code in $appTeams) {
    $espnId = $appCodeToEspnId[$code]
    $url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/$espnId/schedule?season=$season&seasontype=2"
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 -UserAgent $curlUA
        $json = $resp.Content | ConvertFrom-Json
    }
    catch {
        Fail("ESPN bye fetch failed for $code (espnId=$espnId): $($_.Exception.Message)")
    }
    $bye = $json.byeWeek
    if ($null -eq $bye) {
        Fail("ESPN response for $code (espnId=$espnId) missing byeWeek")
    }
    $byeInt = 0
    if (-not [int]::TryParse([string]$bye, [ref]$byeInt)) {
        Fail("ESPN byeWeek for $code is not an int: $bye")
    }
    $TEAM_BYE_WEEKS[$code] = $byeInt
    Start-Sleep -Milliseconds 120
}

if ($TEAM_BYE_WEEKS.Keys.Count -ne 32) {
    Fail("expected exactly 32 team byes, got $($TEAM_BYE_WEEKS.Keys.Count) -- NOT emitting")
}
foreach ($code in $TEAM_BYE_WEEKS.Keys) {
    $w = $TEAM_BYE_WEEKS[$code]
    if ($w -lt 1 -or $w -gt 18) {
        Fail("bye out of 1..18 range for $code : $w -- NOT emitting")
    }
}
Write-Host "Byes OK: 32/32 teams, all ints 1..18"

# ---- Step 4: K/DST interleave by ADP consensus --------------------------------------------------

$adpCsv = Import-Csv (Join-Path $srcDir "adp.csv")
if ($adpCsv.Count -lt 1000) {
    Fail("adp.csv parsed only $($adpCsv.Count) rows (sanity minimum 1000)")
}

$adpGroups = @{}
for ($i = 0; $i -lt $adpCsv.Count; $i++) {
    $row = $adpCsv[$i]
    $posPrefix = [regex]::Replace($row.POS, '[0-9]+$', '').ToLowerInvariant()
    if ($posPrefix -eq 'def') {
        if ([string]::IsNullOrWhiteSpace($row.Team)) { continue } # unkeyable DEF row, not a collision
        $key = $row.Team.ToLowerInvariant() + '|dst'
    }
    else {
        $key = (Normalize-AdpName $row.Player) + '|' + $posPrefix
    }
    if (-not $adpGroups.ContainsKey($key)) { $adpGroups[$key] = New-Object System.Collections.ArrayList }
    [void]$adpGroups[$key].Add($i)
}

$adpWeighted = @{}
$adpCollisions2 = 0
foreach ($key in $adpGroups.Keys) {
    $idxList = $adpGroups[$key]
    $chosenIdx = $idxList[0]
    if ($idxList.Count -eq 2) {
        $adpCollisions2++
        $r0 = $adpCsv[$idxList[0]]; $r1 = $adpCsv[$idxList[1]]
        $blank0 = [string]::IsNullOrWhiteSpace($r0.Team)
        $blank1 = [string]::IsNullOrWhiteSpace($r1.Team)
        Write-Host ("WARN: adp.csv duplicate key '" + $key + "': [" + $r0.Player + "|" + $r0.Team + "] vs [" + $r1.Player + "|" + $r1.Team + "]")
        if ($blank0 -and -not $blank1) { $chosenIdx = $idxList[1] }
        elseif ((-not $blank0) -and $blank1) { $chosenIdx = $idxList[0] }
        else { $chosenIdx = $idxList[0] }
    }
    elseif ($idxList.Count -ge 3) {
        Fail("3+ adp.csv rows collide on key '$key' (" + $idxList.Count + " rows)")
    }
    $row = $adpCsv[$chosenIdx]
    $raw = $row.AVG
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $adpWeighted[$key] = [double]::Parse($raw, [System.Globalization.CultureInfo]::InvariantCulture)
    }
}

function Get-WeightedSkillOrK($name, $posLower) {
    $key = (Normalize-AdpName $name) + '|' + $posLower
    if ($adpWeighted.ContainsKey($key)) { return $adpWeighted[$key] }
    return $null
}
function Get-WeightedDst($team) {
    $key = $team.ToLowerInvariant() + '|dst'
    if ($adpWeighted.ContainsKey($key)) { return $adpWeighted[$key] }
    return $null
}

foreach ($row in $skillDeduped) {
    $row.Weighted = Get-WeightedSkillOrK $row.Name ($row.Position.ToLowerInvariant())
}
foreach ($row in $kPlayers) {
    $row.Weighted = Get-WeightedSkillOrK $row.Name 'k'
}
foreach ($row in $dstPlayers) {
    $row.Weighted = Get-WeightedDst $row.Team
}

# ---- Step 5: tiers -------------------------------------------------------------------------------

$manualText = [IO.File]::ReadAllText($manualPath)
$manualJson = ConvertFrom-Json $manualText

$manualByPos = @{}
foreach ($posProp in $manualJson.tiers.PSObject.Properties) {
    $table = @{}
    foreach ($nameProp in $posProp.Value.PSObject.Properties) {
        $table[(Normalize-AdpName $nameProp.Name)] = $nameProp.Value
    }
    $manualByPos[$posProp.Name] = $table
}

$letterOrdinal = @{}
$nextOrdinal = @{}
$tierSourceByPos = @{}
foreach ($pos in @('QB', 'RB', 'WR', 'TE')) {
    $letterOrdinal[$pos] = @{}
    $nextOrdinal[$pos] = 1
    if ($manualByPos.ContainsKey($pos) -and $manualByPos[$pos].Count -gt 0) {
        $tierSourceByPos[$pos] = 'manual'
    }
    else {
        $tierSourceByPos[$pos] = 'band-fallback'
        Write-Host "WARN: position $pos absent from board-manual.json -- falling back to band tiers"
    }
}

$posIndexCounters = @{}
foreach ($row in $skillDeduped) {
    $pos = $row.Position
    $posIndexCounters[$pos] = ($posIndexCounters[$pos]) + 1
    if ($tierSourceByPos[$pos] -eq 'manual') {
        $norm = Normalize-AdpName $row.Name
        if (-not $manualByPos[$pos].ContainsKey($norm)) {
            Fail("skill player '$($row.Name)' ($pos) resolves no tier letter in board-manual.json")
        }
        $letter = $manualByPos[$pos][$norm]
        if (-not $letterOrdinal[$pos].ContainsKey($letter)) {
            $letterOrdinal[$pos][$letter] = $nextOrdinal[$pos]
            $nextOrdinal[$pos] = $nextOrdinal[$pos] + 1
        }
        $row.Tier = $letterOrdinal[$pos][$letter]
    }
    else {
        $row.Tier = Get-BandTier $pos $posIndexCounters[$pos]
    }
}

# ---- Step 7: assemble final board (K/DST interleave, skill relative order untouched) ------------

$n = $skillDeduped.Count
$insertBuckets = New-Object 'System.Object[]' ($n + 1)
for ($i = 0; $i -le $n; $i++) { $insertBuckets[$i] = New-Object System.Collections.ArrayList }

$combined = New-Object System.Collections.ArrayList
$fo = 0
foreach ($k in $kPlayers) {
    $sortKey = [double]::MaxValue
    if ($null -ne $k.Weighted) { $sortKey = $k.Weighted }
    [void]$combined.Add([PSCustomObject]@{ Name = $k.Name; Team = $k.Team; Position = 'K'; Weighted = $k.Weighted; FileOrder = $fo; SortKey = $sortKey })
    $fo++
}
foreach ($d in $dstPlayers) {
    $sortKey = [double]::MaxValue
    if ($null -ne $d.Weighted) { $sortKey = $d.Weighted }
    [void]$combined.Add([PSCustomObject]@{ Name = $d.Name; Team = $d.Team; Position = 'DST'; Weighted = $d.Weighted; FileOrder = $fo; SortKey = $sortKey })
    $fo++
}

$sortedCombined = $combined | Sort-Object -Property SortKey, FileOrder

# slot = count of skill players with a lower (better) consensus value -- not "first skill player
# exceeding it" in board order, which lets one aggressively user-ranked player dam up all K/DST behind it
foreach ($item in $sortedCombined) {
    $bucket = $n
    if ($null -ne $item.Weighted) {
        $count = 0
        foreach ($sp in $skillDeduped) {
            if ($null -ne $sp.Weighted -and $sp.Weighted -lt $item.Weighted) {
                $count++
            }
        }
        $bucket = $count
    }
    [void]$insertBuckets[$bucket].Add($item)
}

$final = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt $n; $i++) {
    foreach ($item in $insertBuckets[$i]) { [void]$final.Add($item) }
    [void]$final.Add($skillDeduped[$i])
}
foreach ($item in $insertBuckets[$n]) { [void]$final.Add($item) }

# ---- Step 8: gates -------------------------------------------------------------------------------

$finalPosCounts = @{}
foreach ($p in $final) { $finalPosCounts[$p.Position] = ($finalPosCounts[$p.Position]) + 1 }

foreach ($pos in @('QB', 'RB', 'WR', 'TE')) {
    if (-not $finalPosCounts.ContainsKey($pos) -or $finalPosCounts[$pos] -lt 1) {
        Fail("skill position $pos entirely absent from final board")
    }
}
if (-not $finalPosCounts.ContainsKey('K') -or $finalPosCounts['K'] -lt 30) {
    Fail("final board has fewer than 30 K entries")
}
if (-not $finalPosCounts.ContainsKey('DST') -or $finalPosCounts['DST'] -lt 30) {
    Fail("final board has fewer than 30 DST entries")
}

$seedFinal = New-Object System.Collections.ArrayList
$seenIds = @{}
for ($i = 0; $i -lt $final.Count; $i++) {
    $p = $final[$i]
    $team = $p.Team
    if ($team -ne 'FA' -and -not $appTeamSet.ContainsKey($team)) {
        Fail("player '$($p.Name)' has team '$team' outside the 32-set/FA")
    }
    $byeWeek = 0
    if ($team -ne 'FA') {
        if (-not $TEAM_BYE_WEEKS.ContainsKey($team)) {
            Fail("player '$($p.Name)' team '$team' missing from TEAM_BYE_WEEKS")
        }
        $byeWeek = $TEAM_BYE_WEEKS[$team]
    }
    $tier = $null
    if ($p.Position -ne 'K' -and $p.Position -ne 'DST') {
        $tier = $p.Tier
    }
    $id = Get-Slug $p.Name $team
    if ($seenIds.ContainsKey($id)) {
        Fail("duplicate slug id '$id' at rank $($i + 1)")
    }
    $seenIds[$id] = $true
    [void]$seedFinal.Add([PSCustomObject]@{
            Id       = $id
            Rank     = $i + 1
            Name     = $p.Name
            Team     = $team
            Position = $p.Position
            ByeWeek  = $byeWeek
            Tier     = $tier
        })
}

Write-Host ""
Write-Host "Final board: $($seedFinal.Count) players"
Write-Host "Per-position counts:"
foreach ($pos in @('QB', 'RB', 'WR', 'TE', 'K', 'DST')) {
    Write-Host "  $pos : $($finalPosCounts[$pos])"
}
Write-Host ""
Write-Host "Skill dedup drops: $($dedupDropped.Count)"
foreach ($d in $dedupDropped) {
    Write-Host "  dropped: $($d.Name) ($($d.Position))"
}
Write-Host ""
Write-Host "adp.csv 2-way key collisions resolved: $adpCollisions2"
Write-Host ""
Write-Host "Tier source per position:"
foreach ($pos in @('QB', 'RB', 'WR', 'TE')) {
    Write-Host "  $pos : $($tierSourceByPos[$pos]) ($($nextOrdinal[$pos] - 1) tiers)"
}
Write-Host ""
Write-Host "K/DST insertion (final rank : name : team : weighted):"
for ($i = 0; $i -lt $seedFinal.Count; $i++) {
    $p = $seedFinal[$i]
    if ($p.Position -eq 'K' -or $p.Position -eq 'DST') {
        $wDisplay = "no-value"
        $matchFromCombined = $combined | Where-Object { $_.Name -eq $p.Name -and $_.Team -eq $p.Team -and $_.Position -eq $p.Position } | Select-Object -First 1
        if ($matchFromCombined -and $null -ne $matchFromCombined.Weighted) {
            $wDisplay = [Math]::Round($matchFromCombined.Weighted, 2)
        }
        Write-Host "  rank $($p.Rank) : $($p.Name) : $($p.Team) : weighted=$wDisplay"
    }
}
Write-Host ""
Write-Host "Bye source: https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/{espnId}/schedule?season=$season`&seasontype=2 (byeWeek field, curl-style UA, 32 calls)"

# ---- Emit js/data.js -----------------------------------------------------------------------------

function JsStr($s) {
    $escaped = $s -replace '\\', '\\\\'
    $escaped = $escaped -replace '"', '\"'
    return '"' + $escaped + '"'
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("// GENERATED FILE - do not edit by hand. Regenerate with scripts\build-board.ps1.")
[void]$lines.Add("(function () {")
[void]$lines.Add("  'use strict';")
[void]$lines.Add("  window.DC = window.DC || {};")
[void]$lines.Add("")
[void]$lines.Add("  /** @typedef {{id:string, rank:number, name:string, team:string, position:string, byeWeek:number}} Player */")
[void]$lines.Add("")
[void]$lines.Add("  function slug(name, team) {")
[void]$lines.Add("    return (name + '-' + team).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');")
[void]$lines.Add("  }")
[void]$lines.Add("")
[void]$lines.Add("  /** @type {Object<string, number>} real $season bye weeks via ESPN (scripts\build-board.ps1) */")
[void]$lines.Add("  var TEAM_BYE_WEEKS = {")
$sortedTeams = $TEAM_BYE_WEEKS.Keys | Sort-Object
for ($i = 0; $i -lt $sortedTeams.Count; $i++) {
    $code = $sortedTeams[$i]
    $comma = ","
    if ($i -eq ($sortedTeams.Count - 1)) { $comma = "" }
    [void]$lines.Add("    " + $code + ": " + $TEAM_BYE_WEEKS[$code] + $comma)
}
[void]$lines.Add("  };")
[void]$lines.Add("")
[void]$lines.Add("  // real user rankings bake: 353 skill (REDRAFT-rankings.csv, one dedup drop) + K/DST")
[void]$lines.Add("  // interleaved by Flock's multi-site average ADP (adp.csv AVG) -- see scripts\build-board.ps1")
[void]$lines.Add("  var SEED_PLAYERS = [")
for ($i = 0; $i -lt $seedFinal.Count; $i++) {
    $p = $seedFinal[$i]
    $tierLiteral = "null"
    if ($null -ne $p.Tier) { $tierLiteral = [string]$p.Tier }
    $comma = ","
    if ($i -eq ($seedFinal.Count - 1)) { $comma = "" }
    $line = "    { id: " + (JsStr $p.Id) + ", rank: " + $p.Rank + ", name: " + (JsStr $p.Name) + ", team: " + (JsStr $p.Team) + ", position: " + (JsStr $p.Position) + ", byeWeek: " + $p.ByeWeek + ", tier: " + $tierLiteral + ", adp: null }" + $comma
    [void]$lines.Add($line)
}
[void]$lines.Add("  ];")
[void]$lines.Add("")
[void]$lines.Add("  DC.data = { TEAM_BYE_WEEKS: TEAM_BYE_WEEKS, SEED_PLAYERS: SEED_PLAYERS, slug: slug };")
[void]$lines.Add("})();")

$content = ($lines -join "`r`n") + "`r`n"
try {
    [IO.File]::WriteAllText($outFile, $content, (New-Object System.Text.UTF8Encoding($false)))
}
catch {
    Fail("failed to write $outFile : $($_.Exception.Message)")
}

Write-Host ""
Write-Host "Wrote $outFile ($($seedFinal.Count) players)"
exit 0
