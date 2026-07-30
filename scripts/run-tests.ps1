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

$match = [regex]::Match($domText, 'data-pass="(\d+)" data-fail="(\d+)"')

if (-not $match.Success) {
    Write-Host "ERROR: test summary not found in DOM output (JS likely crashed before completion)."
    exit 1
}

$passCount = [int]$match.Groups[1].Value
$failCount = [int]$match.Groups[2].Value

Write-Host "TESTS: $passCount passed, $failCount failed"

if ($failCount -eq 0) {
    exit 0
}
else {
    exit 1
}
