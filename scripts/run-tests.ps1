# Headless-Chrome test runner: dumps tests.html DOM, parses #test-summary, exit 0 iff 0 failures.
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
    Write-Host "ERROR: Neither Chrome nor Edge found."
    exit 1
}

$testsHtmlPath = (Resolve-Path (Join-Path $PSScriptRoot "..\tests.html")).Path
$testsHtmlUrl = "file:///" + ($testsHtmlPath -replace "\\", "/")

# Chrome is a GUI-subsystem exe; `&`-operator stdout capture is unreliable for it here,
# so redirect through real files via Start-Process instead.
$outFile = [System.IO.Path]::GetTempFileName()
$errFile = [System.IO.Path]::GetTempFileName()
try {
    $proc = Start-Process -FilePath $browserPath `
        -ArgumentList @("--headless=new", "--disable-gpu", "--no-first-run", "--dump-dom", $testsHtmlUrl) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    $domText = Get-Content $outFile -Raw
}
finally {
    Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue
}

if (-not $domText) {
    $domText = ""
}

# Fail-closed crash detection: the initial #test-summary markup intentionally omits
# data-pass/data-fail/data-complete, so any of these being missing means the render script
# (which sets all three together, only once it actually finishes) never ran - a page/script
# crash before completion, not a legitimate 0-failure result.
$tagMatch = [regex]::Match($domText, '<div[^>]*id="test-summary"[^>]*>')

if (-not $tagMatch.Success) {
    Write-Host "ERROR: #test-summary element not found in DOM output (crash before completion)."
    exit 1
}

$tagText = $tagMatch.Value

$completeMatch = [regex]::Match($tagText, 'data-complete="1"')
if (-not $completeMatch.Success) {
    Write-Host "ERROR: test summary has no data-complete marker (crash before completion)."
    exit 1
}

$passMatch = [regex]::Match($tagText, 'data-pass="(\d+)"')
$failMatch = [regex]::Match($tagText, 'data-fail="(\d+)"')

if (-not $passMatch.Success -or -not $failMatch.Success) {
    Write-Host "ERROR: test summary missing data-pass/data-fail (crash before completion)."
    exit 1
}

$passCount = [int]$passMatch.Groups[1].Value
$failCount = [int]$failMatch.Groups[1].Value

if (($passCount + $failCount) -eq 0) {
    Write-Host "ERROR: no tests ran (0 passed, 0 failed) - likely a crash between sections."
    exit 1
}

Write-Host "TESTS: $passCount passed, $failCount failed"

if ($failCount -eq 0) {
    exit 0
}
else {
    exit 1
}
