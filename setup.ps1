param([string]$Python = 'python', [switch]$SkipPython,
      [ValidateSet('auto','x64','arm64')][string]$Architecture = 'auto',
      [ValidateSet(3,4)][int]$Players = 4)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -LiteralPath $PSScriptRoot
function Run-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}
$nodeMajor = [int]((& node -p 'parseInt(process.versions.node)') | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 22) { throw 'Install Node.js 22 or later first.' }
if (-not $SkipPython) {
    Run-Checked $Python @('-c', 'import sys; assert sys.version_info[:2] == (3,12) and sys.maxsize > 2**32')
    if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) { Run-Checked $Python @('-m','venv','.venv') }
    Run-Checked '.venv/Scripts/python.exe' @('-m','pip','install','--disable-pip-version-check','-r','requirements.txt')
} elseif (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    throw '-SkipPython requires an existing .venv/Scripts/python.exe'
}
$manifest = Get-Content -LiteralPath 'release-manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Architecture -eq 'auto') {
    $nativeArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine')
    if (-not $nativeArchitecture) { $nativeArchitecture = "$env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_ARCHITECTURE" }
    $Architecture = if ($nativeArchitecture -match 'ARM64') { 'arm64' } else { 'x64' }
}
$downloads = Join-Path $PSScriptRoot 'private/downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
function Download-File([string]$Url, [string]$Path) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
}
function Verify-Hash([string]$Path, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "SHA-256 mismatch: $Path" }
}
$ahkZip = Join-Path $downloads 'AutoHotkey.zip'
Download-File $manifest.autohotkey.url $ahkZip
Verify-Hash $ahkZip $manifest.autohotkey.sha256
Expand-Archive -LiteralPath $ahkZip -DestinationPath 'runtime/ahk-v2' -Force
New-Item -Force -ItemType Directory 'sanma/runtime/ahk-v2' | Out-Null
Copy-Item -LiteralPath 'runtime/ahk-v2/AutoHotkey64.exe' -Destination 'sanma/runtime/ahk-v2/AutoHotkey64.exe' -Force
$engines = @($manifest.engines | Where-Object { $_.architecture -eq $Architecture })
if ($engines.Count -ne 6) { throw "Six engines required for $Architecture" }
foreach ($engine in $engines) {
    $binary = Join-Path $PSScriptRoot $engine.source
    if (!(Test-Path -LiteralPath $binary)) { throw "Missing packaged engine: $binary" }
    Verify-Hash $binary $engine.sha256
    $destination = Join-Path $PSScriptRoot $engine.path
    New-Item -Force -ItemType Directory (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $binary -Destination $destination -Force
    Verify-Hash $destination $engine.sha256
}
$env:MAJSOUL_CONTROLLER_GAME = if ($Players -eq 3) { 'sanma' } else { 'yonma' }
$captureSource = Join-Path $PSScriptRoot $manifest.capture.source
Verify-Hash $captureSource $manifest.capture.sha256
$captureTarget = Join-Path $PSScriptRoot $manifest.capture.path
New-Item -ItemType Directory -Force -Path (Split-Path $captureTarget) | Out-Null
Copy-Item -LiteralPath $captureSource -Destination $captureTarget -Force
Verify-Hash $captureTarget $manifest.capture.sha256
Write-Host "Setup complete ($Architecture engines). Run node resident.mjs -g, or node resident.mjs -3 -f."
