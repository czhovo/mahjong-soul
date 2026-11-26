param([string]$Compiler = 'clang++')
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'runtime/wgc'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
& $Compiler '-std=c++17' '-O2' '-shared' '-static' '-s' '-Wl,--no-insert-timestamp' (Join-Path $PSScriptRoot 'wgc-capture.cpp') '-o' (Join-Path $destination 'wgc-capture.dll') '-ld3d11' '-ldxgi' '-ldwmapi' '-lruntimeobject'
if ($LASTEXITCODE -ne 0) { throw "WGC build failed ($LASTEXITCODE)" }
Write-Output 'WGC capture backend: Ready'
