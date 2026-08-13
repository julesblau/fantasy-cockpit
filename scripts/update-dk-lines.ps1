# Scrapes DraftKings season-long Player Stats O/U lines via CDP, joins by normalized
# name, writes js/dk-data.js. Manual invocation only - never run implicitly.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outFile = Join-Path $repoRoot "js\dk-data.js"
$dataJsPath = Join-Path $repoRoot "js\data.js"
$manualLinesPath = Join-Path $repoRoot "scripts\dk-manual-lines.json"

$port = 9755
$profileDir = Join-Path $env:TEMP 'draft-cockpit-dk-profile'

# tab URL slug -> sidecar component key, in scrape + gate-report order
$tabs = @(
    @{ Slug = 'pass-yards'; Key = 'passYds' },
    @{ Slug = 'pass-tds'; Key = 'passTds' },
    @{ Slug = 'rush-yards'; Key = 'rushYds' },
    @{ Slug = 'rush-tds'; Key = 'rushTds' },
    @{ Slug = 'rec-yards'; Key = 'recYds' },
    @{ Slug = 'rec-tds'; Key = 'recTds' },
    @{ Slug = 'receptions'; Key = 'rec' }
)
$gateMins = @{
    'pass-yards' = 20; 'pass-tds' = 20
    'rush-yards' = 35; 'rush-tds' = 25
    'rec-yards' = 55; 'rec-tds' = 35
    'receptions' = 40
}
# fixed emit order - binding repo-wide (js consumers assume this key sequence)
$componentOrder = @('passYds', 'passTds', 'rushYds', 'rushTds', 'rec', 'recYds', 'recTds')

# DK raw name -> canonical (board) name, applied before Normalize-AdpName.
# DK renders some players by their formal first name; the board uses the nickname it's drafted under.
$ALIASES = @{
    'Cameron Skattebo' = 'Cam Skattebo'
    'Cameron Ward' = 'Cam Ward'
}

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

function Format-DkNumber($v) {
    return ([double]$v).ToString("0.##", [System.Globalization.CultureInfo]::InvariantCulture)
}

function Normalize-OddsDisplay($raw) {
    return ($raw -replace [char]0x2212, '-')
}

# mirrors run-tests.ps1's browser resolution block
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$browserPath = $null
if (Test-Path $chromePath) {
    $browserPath = $chromePath
}
elseif (Test-Path $edgePath) {
    $browserPath = $edgePath
}
if (-not $browserPath) {
    Fail("Neither Chrome nor Edge found.")
}

function Start-DkChrome($p, $profDir, $exePath) {
    $chromeArgs = @(
        '--window-size=1200,900',
        '--window-position=-2400,-2400',
        '--disable-backgrounding-occluded-windows',
        '--mute-audio',
        ("--remote-debugging-port=" + $p),
        ("--user-data-dir=" + $profDir),
        'about:blank'
    )
    return Start-Process -FilePath $exePath -ArgumentList $chromeArgs -PassThru -NoNewWindow
}

function Wait-CdpReady($p, $timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $t = Invoke-RestMethod ("http://localhost:" + $p + "/json") -TimeoutSec 2
            if ($t) { return $t }
        }
        catch {}
        Start-Sleep -Milliseconds 500
    }
    return $null
}

$blockPattern = 'NFL 2026/27 - (?<name>.+?) Regular Season (?<label>[A-Za-z ]+)\s*\r?\n\s*Over (?<overLine>\d+(?:\.\d+)?)\s*\r?\n\s*(?<overOdds>[+\u2212]?\d+|Even)\s*\r?\n\s*Under (?<underLine>\d+(?:\.\d+)?)\s*\r?\n\s*(?<underOdds>[+\u2212]?\d+|Even)'

$players = @{}
$playerRawNames = @{}
$tabCounts = @{}
$labelsByTab = @{}
$histogram = @{}
$weirdKeys = New-Object System.Collections.ArrayList

$chromeProc = $null
$cws = $null
try {
    $chromeProc = Start-DkChrome $port $profileDir $browserPath
    $cdpTabs = Wait-CdpReady $port 15
    if (-not $cdpTabs) {
        Write-Host "Port $port not reachable, retrying with 9756..."
        try { Stop-Process -Id $chromeProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        $port = 9756
        $chromeProc = Start-DkChrome $port $profileDir $browserPath
        $cdpTabs = Wait-CdpReady $port 15
        if (-not $cdpTabs) {
            Fail("CDP not reachable on ports 9755 or 9756")
        }
    }

    $wsUrl = ($cdpTabs | Where-Object { $_.type -eq 'page' } | Select-Object -First 1).webSocketDebuggerUrl
    if (-not $wsUrl) {
        Fail("no page target found in CDP /json response")
    }
    $cws = New-Object System.Net.WebSockets.ClientWebSocket
    $cws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()

    $buf = New-Object byte[] (262144)
    $script:pendingTask = $null
    $script:ms = $null
    $msgId = 0

    function Send-Cdp([int]$id, [string]$method, $params) {
        $msg = @{ id = $id; method = $method }
        if ($params) { $msg.params = $params }
        $jsonText = $msg | ConvertTo-Json -Depth 10 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($jsonText)
        $cws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
    }

    # accumulate RAW BYTES across chunks in a MemoryStream; ONE UTF8.GetString at EndOfMessage.
    # per-chunk UTF8.GetString corrupts multi-byte chars split across the buffer boundary (e.g. U+2212).
    function Pump([int]$pollMs) {
        if ($null -eq $script:pendingTask) {
            $script:ms = New-Object System.IO.MemoryStream
            $script:pendingTask = $cws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None)
        }
        while ($true) {
            if (-not $script:pendingTask.Wait($pollMs)) { return $null }
            $res = $script:pendingTask.Result
            $script:ms.Write($buf, 0, $res.Count)
            if ($res.EndOfMessage) {
                $text = [Text.Encoding]::UTF8.GetString($script:ms.ToArray())
                $script:pendingTask = $null
                try { return ($text | ConvertFrom-Json) } catch { return $null }
            }
            $script:pendingTask = $cws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None)
        }
    }

    function WaitFor([int]$id, [int]$timeoutSec) {
        $deadline = (Get-Date).AddSeconds($timeoutSec)
        while ((Get-Date) -lt $deadline) {
            $m = Pump 500
            if ($m -and $m.id -eq $id) { return $m }
        }
        throw ('timeout waiting for id ' + $id)
    }

    $msgId++; Send-Cdp $msgId 'Network.enable' @{}
    [void](WaitFor $msgId 10)

    $scrollJs = "window.__dcScrollTimer = setInterval(function () { window.scrollBy(0, 1200); }, 250);"
    $clearScrollJs = "if (window.__dcScrollTimer) { clearInterval(window.__dcScrollTimer); window.__dcScrollTimer = null; }"
    $lengthJs = "document.body.innerText.length"
    $extractJs = "document.body.innerText"

    foreach ($tabDef in $tabs) {
        $slug = $tabDef.Slug
        $compKey = $tabDef.Key
        $url = "https://sportsbook.draftkings.com/leagues/football/nfl?category=futures&subcategory=player-stats-o-u&nav_1=$slug"
        Write-Host "Navigating to tab '$slug'..."

        $msgId++; Send-Cdp $msgId 'Page.navigate' @{ url = $url }
        [void](WaitFor $msgId 20)

        $settleDeadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $settleDeadline) { [void](Pump 500) }

        $msgId++; Send-Cdp $msgId 'Runtime.evaluate' @{ expression = $scrollJs; returnByValue = $false }
        [void](WaitFor $msgId 15)

        $prevLen = -1
        $stabDeadline = (Get-Date).AddSeconds(150)
        while ($true) {
            if ((Get-Date) -ge $stabDeadline) {
                Write-Host "WARN: tab '$slug' innerText length did not stabilize within cap; proceeding anyway"
                break
            }
            $msgId++; Send-Cdp $msgId 'Runtime.evaluate' @{ expression = $lengthJs; returnByValue = $true }
            $lenResp = WaitFor $msgId 10
            $curLen = [int]$lenResp.result.result.value
            if ($curLen -eq $prevLen -and $prevLen -ge 0) {
                break
            }
            $prevLen = $curLen
            $waitDeadline = (Get-Date).AddSeconds(3)
            while ((Get-Date) -lt $waitDeadline) { [void](Pump 500) }
        }

        $msgId++; Send-Cdp $msgId 'Runtime.evaluate' @{ expression = $clearScrollJs; returnByValue = $false }
        [void](WaitFor $msgId 10)

        $msgId++; Send-Cdp $msgId 'Runtime.evaluate' @{ expression = $extractJs; returnByValue = $true; awaitPromise = $true }
        $extractResp = WaitFor $msgId 40
        if ($extractResp.result.exceptionDetails) {
            Fail("Runtime.evaluate threw while extracting tab '$slug': $($extractResp.result.exceptionDetails.text)")
        }
        $bodyText = $extractResp.result.result.value
        if (-not $bodyText) {
            Fail("empty innerText extracted for tab '$slug'")
        }

        $matches = [regex]::Matches($bodyText, $blockPattern)
        $tabCounts[$slug] = $matches.Count
        Write-Host "  parsed $($matches.Count) rows"

        if (-not $labelsByTab.ContainsKey($slug)) { $labelsByTab[$slug] = @{} }

        foreach ($m in $matches) {
            $rawName = $m.Groups['name'].Value.Trim()
            $label = $m.Groups['label'].Value.Trim()
            $overLine = [double]$m.Groups['overLine'].Value
            $overOddsDisp = Normalize-OddsDisplay $m.Groups['overOdds'].Value
            $underOddsDisp = Normalize-OddsDisplay $m.Groups['underOdds'].Value

            $labelsByTab[$slug][$label] = $true

            if (-not $histogram.ContainsKey($overOddsDisp)) { $histogram[$overOddsDisp] = 0 }
            $histogram[$overOddsDisp]++
            if (-not $histogram.ContainsKey($underOddsDisp)) { $histogram[$underOddsDisp] = 0 }
            $histogram[$underOddsDisp]++

            $aliased = $rawName
            if ($ALIASES.ContainsKey($rawName)) { $aliased = $ALIASES[$rawName] }
            $key = Normalize-AdpName $aliased

            if ([string]::IsNullOrEmpty($key) -or $key.Length -lt 3) {
                Write-Host "WARN: DK name '$rawName' (tab $slug) normalized to suspicious key '$key'"
                [void]$weirdKeys.Add($rawName)
            }

            if (-not $players.ContainsKey($key)) { $players[$key] = @{} }
            $players[$key][$compKey] = $overLine
            if (-not $playerRawNames.ContainsKey($key)) { $playerRawNames[$key] = $rawName }
        }
    }
}
catch {
    Fail("scrape failed: $($_.Exception.Message)")
}
finally {
    if ($cws) { try { $cws.Dispose() } catch {} }
    if ($chromeProc) { try { Stop-Process -Id $chromeProc.Id -Force -ErrorAction SilentlyContinue } catch {} }
}

# ---- RAW_PLAYERS board parse (name/team/position, board order) ----------------------------
# board rank = array index+1, mirrors SEED_PLAYERS.map in js/data.js. Feeds the manual-merge
# typo guard below and the gap worksheet after the gates.

try {
    $dataJsText = [IO.File]::ReadAllText($dataJsPath)
}
catch {
    Fail("failed to read $dataJsPath for RAW_PLAYERS parse: $($_.Exception.Message)")
}
$rawStart = $dataJsText.IndexOf("var RAW_PLAYERS = [")
if ($rawStart -lt 0) {
    Fail("could not find 'var RAW_PLAYERS = [' in js/data.js")
}
$rawEnd = $dataJsText.IndexOf("];", $rawStart)
if ($rawEnd -lt 0) {
    Fail("could not find closing '];' for RAW_PLAYERS in js/data.js")
}
$rawBlock = $dataJsText.Substring($rawStart, $rawEnd - $rawStart)
$rowPattern = '\[\s*(?:"([^"]+)"|''([^'']+)'')\s*,\s*''([A-Za-z]+)''\s*,\s*''([A-Za-z]+)''\s*\]'
$rowMatches = [regex]::Matches($rawBlock, $rowPattern)
if ($rowMatches.Count -eq 0) {
    Fail("parsed zero seed player rows from RAW_PLAYERS")
}

$boardPlayers = New-Object System.Collections.ArrayList
$seenKeys = @{}
$seenPositions = @{}
$collisions = 0
$rank = 0
foreach ($m in $rowMatches) {
    $rank++
    $name = $m.Groups[1].Value
    if (-not $m.Groups[1].Success) { $name = $m.Groups[2].Value }
    $team = $m.Groups[3].Value
    $pos = $m.Groups[4].Value
    $k = Normalize-AdpName $name
    if ($seenKeys.ContainsKey($k)) {
        Write-Host "WARN: RAW_PLAYERS names '$($seenKeys[$k])' and '$name' both normalize to key '$k'"
        $collisions++
    }
    else {
        $seenKeys[$k] = $name
        $seenPositions[$k] = $pos
    }
    [void]$boardPlayers.Add(@{ Rank = $rank; Name = $name; Team = $team; Position = $pos; Key = $k })
}
Write-Host ""
Write-Host "RAW_PLAYERS normalization collision check:"
if ($collisions -eq 0) {
    Write-Host "  no collisions found ($($rowMatches.Count) names checked)"
}

# ---- Manual sportsbook lines merge (fail-closed) -------------------------------------------
# PS 5.1 landmine (empirically reproduced): ConvertFrom-Json yields PSCustomObject; .Keys on it
# silently returns $null and foreach($k in $null) silently no-ops -- the merge would report 0
# fills with no error. Iterate BOTH levels via .PSObject.Properties, and self-check the count
# to convert that silent failure into a fail-closed error.

if (-not (Test-Path $manualLinesPath)) {
    Write-Host ""
    Write-Host "No scripts\dk-manual-lines.json found; skipping manual overlay merge."
}
else {
    try {
        $manualText = [IO.File]::ReadAllText($manualLinesPath)
        $manual = $manualText | ConvertFrom-Json
    }
    catch {
        Fail("failed to read/parse $manualLinesPath : $($_.Exception.Message)")
    }
    if (-not $manual.lines) {
        Fail("$manualLinesPath missing 'lines' object")
    }

    $manualPlayerProps = @($manual.lines.PSObject.Properties)
    $expectedPlayerCount = $manualPlayerProps.Count
    $manualPlayerCount = 0
    $manualFillCount = 0

    foreach ($prop in $manualPlayerProps) {
        $rawManualName = $prop.Name
        $compsObj = $prop.Value

        $aliased = $rawManualName
        if ($ALIASES.ContainsKey($rawManualName)) { $aliased = $ALIASES[$rawManualName] }
        $key = Normalize-AdpName $aliased

        if (-not $seenKeys.ContainsKey($key)) {
            Write-Host "WARN: manual line for '$rawManualName' (key '$key') matches no RAW_PLAYERS name; merging anyway"
        }

        if (-not $players.ContainsKey($key)) {
            $players[$key] = @{}
            if (-not $playerRawNames.ContainsKey($key)) { $playerRawNames[$key] = $rawManualName }
        }

        foreach ($comp in @($compsObj.PSObject.Properties)) {
            $compName = $comp.Name
            $compValRaw = $comp.Value

            if ($componentOrder -notcontains $compName) {
                Fail("manual line for '$rawManualName' has unknown component '$compName' (expected one of: $($componentOrder -join ', '))")
            }

            $numVal = $null
            if ($compValRaw -is [double] -or $compValRaw -is [int] -or $compValRaw -is [long] -or $compValRaw -is [decimal]) {
                $numVal = [double]$compValRaw
            }
            else {
                $parsed = [double]0
                if ([double]::TryParse([string]$compValRaw, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
                    $numVal = $parsed
                }
            }
            if ($null -eq $numVal -or [double]::IsNaN($numVal) -or [double]::IsInfinity($numVal) -or $numVal -lt 0) {
                Fail("manual line for '$rawManualName' component '$compName' is not a finite non-negative number: '$compValRaw'")
            }

            if (-not $players[$key].ContainsKey($compName)) {
                $players[$key][$compName] = $numVal
                $manualFillCount++
            }
        }
        $manualPlayerCount++
    }

    if ($manualPlayerCount -ne $expectedPlayerCount) {
        Fail("manual merge processed $manualPlayerCount players but expected $expectedPlayerCount -- PSObject.Properties enumeration mismatch")
    }

    Write-Host ""
    Write-Host "manual fills applied: $manualFillCount components across $manualPlayerCount players (manual file dated $($manual.updated))"
    if ($manual.updated) {
        try {
            $updatedDate = [DateTime]::ParseExact([string]$manual.updated, "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
            $ageDays = (Get-Date).Date.Subtract($updatedDate).TotalDays
            if ($ageDays -gt 14) {
                Write-Host "WARN: manual lines file is $([int]$ageDays) days old (dated $($manual.updated)) - consider refreshing"
            }
        }
        catch {
            Write-Host "WARN: manual lines 'updated' field '$($manual.updated)' is not a parseable yyyy-MM-dd date"
        }
    }
}

# ---- Gates (fail closed) --------------------------------------------------------------------

Write-Host ""
Write-Host "Per-tab parsed counts:"
foreach ($tabDef in $tabs) {
    Write-Host "  $($tabDef.Slug): $($tabCounts[$tabDef.Slug])"
}

$gateFailures = New-Object System.Collections.ArrayList
foreach ($tabDef in $tabs) {
    $slug = $tabDef.Slug
    $count = [int]$tabCounts[$slug]
    $min = $gateMins[$slug]
    if ($count -lt $min) {
        [void]$gateFailures.Add("$slug : $count (minimum $min)")
    }
}
if ($gateFailures.Count -gt 0) {
    Write-Host ""
    foreach ($f in $gateFailures) {
        Write-Host "ERROR: gate failed for $f"
    }
    Fail("one or more tab gates failed; js/dk-data.js NOT written")
}

# ---- Label wording + juice histogram (console only, not stored) ----------------------------

Write-Host ""
Write-Host "Stat label text seen per tab:"
foreach ($tabDef in $tabs) {
    $slug = $tabDef.Slug
    $labels = @($labelsByTab[$slug].Keys)
    Write-Host "  $slug -> $($labels -join ', ')"
}

Write-Host ""
Write-Host "Juice histogram (Over+Under American odds, all tabs):"
foreach ($hk in ($histogram.Keys | Sort-Object)) {
    Write-Host "  $hk : $($histogram[$hk])"
}

# ---- Alias-sweep diagnostics: full DK<->board diff for manual nickname/formal-name review ---

$skillPositions = @{ 'QB' = $true; 'RB' = $true; 'WR' = $true; 'TE' = $true }

$dkOnlyKeys = New-Object System.Collections.ArrayList
foreach ($k in $players.Keys) {
    if (-not $seenKeys.ContainsKey($k)) {
        [void]$dkOnlyKeys.Add($playerRawNames[$k])
    }
}
$boardOnlySkillNames = New-Object System.Collections.ArrayList
foreach ($k in $seenKeys.Keys) {
    if ($skillPositions.ContainsKey($seenPositions[$k]) -and -not $players.ContainsKey($k)) {
        [void]$boardOnlySkillNames.Add($seenKeys[$k] + ' (' + $seenPositions[$k] + ')')
    }
}
Write-Host ""
Write-Host "Alias sweep - DK-scraped names with NO board key match ($($dkOnlyKeys.Count)):"
foreach ($n in ($dkOnlyKeys | Sort-Object)) {
    Write-Host "  - $n"
}
Write-Host ""
Write-Host "Alias sweep - board QB/RB/WR/TE names with NO DK key match ($($boardOnlySkillNames.Count)):"
foreach ($n in ($boardOnlySkillNames | Sort-Object)) {
    Write-Host "  - $n"
}

$first60 = $boardPlayers | Select-Object -First 60
$livenessHits = 0
$unmatchedNames = New-Object System.Collections.ArrayList
foreach ($bp in $first60) {
    if ($players.ContainsKey($bp.Key)) {
        $livenessHits++
    }
    else {
        [void]$unmatchedNames.Add($bp.Name)
    }
}
if ($livenessHits -lt 40) {
    Write-Host "WARN: seed liveness $livenessHits/60 is below the tests.html gate of 40"
}

# ---- Gap worksheet (post-merge; rank order; QB/RB/WR/TE only) -----------------------------

$REQUIRED_COMPONENTS = @{
    'QB' = @('passYds', 'passTds', 'rushYds', 'rushTds')
    'RB' = @('rushYds', 'rushTds', 'rec', 'recYds', 'recTds')
    'WR' = @('rec', 'recYds', 'recTds')
    'TE' = @('rec', 'recYds', 'recTds')
}
$COMP_LABELS = @{
    'passYds' = 'pass yds'; 'passTds' = 'pass TDs'
    'rushYds' = 'rush yds'; 'rushTds' = 'rush TDs'
    'rec' = 'receptions'; 'recYds' = 'rec yds'; 'recTds' = 'rec TDs'
}

Write-Host ""
Write-Host "Gap worksheet (missing required DK lines, rank order; first 150 board ranks shown):"
$totalGaps = 0
$shownGaps = 0
foreach ($bp in $boardPlayers) {
    $required = $REQUIRED_COMPONENTS[$bp.Position]
    if (-not $required) { continue }

    $missingLabels = New-Object System.Collections.ArrayList
    if (-not $players.ContainsKey($bp.Key)) {
        [void]$missingLabels.Add('ALL LINES')
    }
    else {
        $entry = $players[$bp.Key]
        foreach ($comp in $required) {
            if (-not $entry.ContainsKey($comp)) {
                [void]$missingLabels.Add($COMP_LABELS[$comp])
            }
        }
    }

    if ($missingLabels.Count -gt 0) {
        $totalGaps++
        if ($bp.Rank -le 150) {
            Write-Host "  #$($bp.Rank) $($bp.Name) ($($bp.Position), $($bp.Team)): $($missingLabels -join ', ')"
            $shownGaps++
        }
    }
}
Write-Host ""
Write-Host "Total gaps: $totalGaps QB/RB/WR/TE players missing at least one required line ($shownGaps shown within rank 150)"

# ---- Write js/dk-data.js ---------------------------------------------------------------------

$sortedKeys = [string[]]@($players.Keys)
[array]::Sort($sortedKeys, [System.StringComparer]::Ordinal)

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("// generated by scripts/update-dk-lines.ps1 -- do not hand-edit")
[void]$lines.Add("window.DC = window.DC || {};")
[void]$lines.Add("DC.dkData = {")
[void]$lines.Add("  updatedAt: '" + (Get-Date -Format "yyyy-MM-dd") + "',")
[void]$lines.Add("  source: 'draftkings',")
[void]$lines.Add("  players: {")

for ($i = 0; $i -lt $sortedKeys.Count; $i++) {
    $k = $sortedKeys[$i]
    $entry = $players[$k]
    $parts = New-Object System.Collections.ArrayList
    foreach ($comp in $componentOrder) {
        if ($entry.ContainsKey($comp)) {
            [void]$parts.Add($comp + ": " + (Format-DkNumber $entry[$comp]))
        }
    }
    $comma = ","
    if ($i -eq ($sortedKeys.Count - 1)) { $comma = "" }
    [void]$lines.Add("    '" + $k + "': { " + ($parts -join ", ") + " }" + $comma)
}

[void]$lines.Add("  }")
[void]$lines.Add("};")

$content = ($lines -join "`r`n") + "`r`n"
try {
    [IO.File]::WriteAllText($outFile, $content, (New-Object Text.UTF8Encoding($false)))
}
catch {
    Fail("failed to write $outFile : $($_.Exception.Message)")
}

# ---- Closing report ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Total distinct players: $($players.Count)"
Write-Host "Seed liveness (first 60 RAW_PLAYERS): $livenessHits/60"
if ($unmatchedNames.Count -gt 0) {
    Write-Host "  unmatched:"
    foreach ($n in $unmatchedNames) {
        Write-Host "    - $n"
    }
}
if ($weirdKeys.Count -gt 0) {
    Write-Host "Suspicious DK name -> key results:"
    foreach ($n in $weirdKeys) {
        Write-Host "  - $n"
    }
}
Write-Host ""
Write-Host "Wrote $outFile"
Write-Host ""
Write-Host "Refresh ritual: run scripts\run-tests.ps1, bump CACHE_NAME in sw.js, then deploy."
exit 0
