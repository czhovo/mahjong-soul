param([long]$WindowId, [string]$Executable)
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFileName($Executable) -ine 'Jantama_MahjongSoul.exe') { throw 'Unexpected game executable' }
$gameProcesses = @(Get-Process -Name Jantama_MahjongSoul -ErrorAction SilentlyContinue)
$targetGame = @($gameProcesses | Where-Object { $_.MainWindowHandle.ToInt64() -eq $WindowId })
if ($targetGame.Count -ne 1) { throw 'Original game window changed; refusing to restart a different process' }
$game = $targetGame[0]
if ($game.Path -ine $Executable) { throw 'Game executable path changed' }
Stop-Process -Id $game.Id -Force
if (!$game.WaitForExit(10000)) { throw 'Old game process did not exit' }
$startedGame = Start-Process -FilePath $Executable -WorkingDirectory ([IO.Path]::GetDirectoryName($Executable)) -PassThru
@{ oldPid=$game.Id; newPid=$startedGame.Id; executable=$Executable } | ConvertTo-Json -Compress
