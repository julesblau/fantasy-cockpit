# Scrapes DraftKings season-long Player Stats O/U lines via CDP, joins by normalized
# name, writes js/dk-data.js. Manual invocation only - never run implicitly.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outFile = Join-Path $repoRoot "js\dk-data.js"
$dataJsPath = Join-Path $repoRoot "js\data.js"

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

# DK raw name -> canonical name, applied before Normalize-AdpName; empty until a real drift is found
$ALIASES = @{}

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

# ---- RAW_PLAYERS collision + seed liveness check ------------------------------------------

try {
    $dataJsText = [IO.File]::ReadAllText($dataJsPath)
}
catch {
    Fail("failed to read $dataJsPath for collision check: $($_.Exception.Message)")
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
$namePattern = '\[\s*(?:"([^"]+)"|''([^'']+)'')\s*,'
$nameMatches = [regex]::Matches($rawBlock, $namePattern)
if ($nameMatches.Count -eq 0) {
    Fail("parsed zero seed player names from RAW_PLAYERS")
}

Write-Host ""
Write-Host "RAW_PLAYERS normalization collision check:"
$seenKeys = @{}
$collisions = 0
foreach ($m in $nameMatches) {
    $name = $m.Groups[1].Value
    if (-not $m.Groups[1].Success) { $name = $m.Groups[2].Value }
    $k = Normalize-AdpName $name
    if ($seenKeys.ContainsKey($k)) {
        Write-Host "WARN: RAW_PLAYERS names '$($seenKeys[$k])' and '$name' both normalize to key '$k'"
        $collisions++
    }
    else {
        $seenKeys[$k] = $name
    }
}
if ($collisions -eq 0) {
    Write-Host "  no collisions found ($($nameMatches.Count) names checked)"
}

$first60 = $nameMatches | Select-Object -First 60
$livenessHits = 0
$unmatchedNames = New-Object System.Collections.ArrayList
foreach ($m in $first60) {
    $name = $m.Groups[1].Value
    if (-not $m.Groups[1].Success) { $name = $m.Groups[2].Value }
    $k = Normalize-AdpName $name
    if ($players.ContainsKey($k)) {
        $livenessHits++
    }
    else {
        [void]$unmatchedNames.Add($name)
    }
}
if ($livenessHits -lt 40) {
    Write-Host "WARN: seed liveness $livenessHits/60 is below the tests.html gate of 40"
}

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
