param([string]$Python = 'python', [switch]$SkipPython)
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
foreach ($engine in $manifest.engines) {
    $zip = Join-Path $downloads $engine.asset
    $url = "https://github.com/$($manifest.repository)/releases/download/$($manifest.tag)/$($engine.asset)"
    Download-File $url $zip
    Verify-Hash $zip $engine.archive_sha256
    $destination = Join-Path $PSScriptRoot "engines/$($engine.version)"
    Expand-Archive -LiteralPath $zip -DestinationPath $destination -Force
    Verify-Hash (Join-Path $destination 'bot.exe') $engine.sha256
}
Run-Checked 'node' @('doctor.mjs')
Write-Host 'Setup complete. Install the coded tile textures as described in README.md, then run start.cmd.'
