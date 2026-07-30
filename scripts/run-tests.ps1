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
$sectionsMatch = [regex]::Match($tagText, 'data-sections="([^"]*)"')

if (-not $passMatch.Success -or -not $failMatch.Success -or -not $sectionsMatch.Success) {
    Write-Host "ERROR: test summary missing data-pass/data-fail/data-sections (crash before completion)."
    exit 1
}

$passCount = [int]$passMatch.Groups[1].Value
$failCount = [int]$failMatch.Groups[1].Value

if (($passCount + $failCount) -eq 0) {
    Write-Host "ERROR: no tests ran (0 passed, 0 failed) - likely a crash between sections."
    exit 1
}

# Per-section liveness: statically scan the tests.html SOURCE (not the runtime DOM) for every
# section(...) call. A crash partway through a section's script tag - whether it happens before
# or after that section's own section(...) call runs - leaves that section's name out of the
# runtime data-sections list even though the source still declares it. Comparing source-declared
# names against runtime-live names catches both cases; comparing only against runtime data would
# miss the "crashed before section() even ran" case entirely.
$sourceText = Get-Content $testsHtmlPath -Raw
$sectionPattern = 'section\(\s*[''"]([^''"]+)[''"]\s*\)'
$sectionDeclMatches = [regex]::Matches($sourceText, $sectionPattern)

$expectedSections = New-Object System.Collections.ArrayList
foreach ($m in $sectionDeclMatches) {
    $name = $m.Groups[1].Value
    if (-not $expectedSections.Contains($name)) {
        [void]$expectedSections.Add($name)
    }
}

$liveSectionsRaw = $sectionsMatch.Groups[1].Value
if ($liveSectionsRaw -eq '') {
    $liveSections = @()
}
else {
    $liveSections = $liveSectionsRaw -split '\|'
}

$missingSections = New-Object System.Collections.ArrayList
foreach ($name in $expectedSections) {
    if ($liveSections -notcontains $name) {
        [void]$missingSections.Add($name)
    }
}

if ($missingSections.Count -gt 0) {
    foreach ($name in $missingSections) {
        Write-Host "ERROR: section '$name' registered no tests - crashed before registration?"
    }
    exit 1
}

Write-Host "TESTS: $passCount passed, $failCount failed"

if ($failCount -eq 0) {
    exit 0
}
else {
    exit 1
}
