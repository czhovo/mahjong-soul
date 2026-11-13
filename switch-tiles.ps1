[CmdletBinding(SupportsShouldProcess)]
param([string]$Manifest = (Join-Path $PSScriptRoot 'private/active-tiles.json'))
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
function Read-Hash([string]$Path) { $sha=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace("-","") } finally { $sha.Dispose() } }
function Stop-MahjongSoul {
    param([int]$TimeoutMilliseconds = 30000)
    $shutdown = [Diagnostics.Stopwatch]::StartNew()
    $nextStop = 0
    while ($true) {
        $games = @(Get-Process -Name Jantama_MahjongSoul -ErrorAction SilentlyContinue)
        if ($games.Count -eq 0) { return }
        $retry = $shutdown.Elapsed.TotalMilliseconds -ge $nextStop
        foreach ($game in $games) {
            try {
                if ($retry) {
                    try { Stop-Process -InputObject $game -Force -ErrorAction Stop }
                    catch {
                        # Exiting between enumeration and termination is success.
                        if (Get-Process -Id $game.Id -ErrorAction SilentlyContinue) { throw }
                    }
                }
            } finally { $game.Dispose() }
        }
        if ($retry) { $nextStop = $shutdown.Elapsed.TotalMilliseconds + 1000 }
        # Re-query actual remaining processes; do not fail on one cached
        # Process object's WaitForExit result or leave other instances alive.
        if ($shutdown.Elapsed.TotalMilliseconds -ge $TimeoutMilliseconds) {
            if (Get-Process -Name Jantama_MahjongSoul -ErrorAction SilentlyContinue) {
                throw '雀魂进程重试关闭后仍未退出，未切换牌面、未重新启动。'
            }
            return
        }
        Start-Sleep -Milliseconds 100
    }
}
$current = Read-Hash $manifest.source
if ($current -eq $manifest.original_sha256) {
    $file = $manifest.replacement; $expected = $manifest.replacement_sha256; $name = '编码牌面'
} elseif ($current -eq $manifest.replacement_sha256) {
    $file = $manifest.backup; $expected = $manifest.original_sha256; $name = '标准牌面'
} else { throw '当前资源与已知的两种牌面都不匹配，未修改。' }
if ((Read-Hash $file) -ne $expected) { throw '切换源文件校验失败，未修改。' }
if ($PSCmdlet.ShouldProcess($manifest.source, "切换为$name")) {
    $wasRunning = @(Get-Process -Name Jantama_MahjongSoul -ErrorAction SilentlyContinue).Count -gt 0
    if ($wasRunning) {
        $gameDirectory = Split-Path (Split-Path (Split-Path (Split-Path $manifest.source)))
        $executable = Join-Path $gameDirectory 'Jantama_MahjongSoul.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "找不到雀魂启动文件：$executable，未关闭游戏、未修改牌面。" }
        $countdown = [Diagnostics.Stopwatch]::StartNew()
        $lastSecond = -1
        $readConsoleKeys = -not [Console]::IsInputRedirected
        do {
            $seconds = [Math]::Max(0, 10 - [int][Math]::Floor($countdown.Elapsed.TotalSeconds))
            if ($readConsoleKeys) {
                try {
                    while ([Console]::KeyAvailable) {
                        if ([Console]::ReadKey($true).Key -eq [ConsoleKey]::Enter) {
                            $seconds = 0
                            break
                        }
                    }
                } catch [InvalidOperationException] {
                    $readConsoleKeys = $false
                }
            }
            if ($seconds -ne $lastSecond) {
                Write-Host ("`r等待{0}秒  " -f $seconds) -NoNewline
                $lastSecond = $seconds
            }
            if ($seconds -gt 0) { Start-Sleep -Milliseconds 50 }
        } while ($seconds -gt 0)
        Write-Host ''
        Stop-MahjongSoul
    }
    Copy-Item -LiteralPath $file -Destination $manifest.source -Force
    if ((Read-Hash $manifest.source) -ne $expected) { throw '写入后校验失败。' }
    Write-Output "已切换为$name"
    if ($wasRunning) {
        if (-not (Get-Process -Name Jantama_MahjongSoul -ErrorAction SilentlyContinue)) {
            Start-Process -FilePath 'steam://rungameid/1329410'
        }
    }
}
