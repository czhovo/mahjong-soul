$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'switch-tiles.ps1') -Raw -Encoding UTF8
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$stopFunction = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Stop-MahjongSoul' }, $true)
if (-not $stopFunction) { throw 'Missing shutdown function' }
# Extract only the function. Never run the resource copy, countdown or launch.
Invoke-Expression $stopFunction.Extent.Text

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ("$Actual" -ne "$Expected") { throw "$Message (actual=$Actual, expected=$Expected)" }
}
function Reset-Case([string]$Mode, [int[]]$Ids) {
    $script:caseMode = $Mode; $script:alive = @($Ids)
    $script:stops = @(); $script:disposed = 0
}
function Get-Process {
    param($Name, $Id, $ErrorAction)
    foreach ($number in $script:alive) {
        if ($PSBoundParameters.ContainsKey('Id') -and $number -ne $Id) { continue }
        $item = [pscustomobject]@{ Id = $number; ProcessName = 'Jantama_MahjongSoul' }
        $item | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposed++ }
        $item
    }
}
function Stop-Process {
    param($InputObject, [switch]$Force, $ErrorAction)
    $script:stops += $InputObject.Id
    if ($script:caseMode -eq 'stuck') { return }
    if ($script:caseMode -eq 'retry' -and $script:stops.Count -lt 2) { return }
    $script:alive = @($script:alive | Where-Object { $_ -ne $InputObject.Id })
    if ($script:caseMode -eq 'exit-race') { throw 'Process exited between enumeration and termination' }
}

Reset-Case 'multiple' @(101,102)
Stop-MahjongSoul
Assert-Equal ($script:stops -join ',') '101,102' 'All instances must be terminated'
Assert-Equal $script:disposed 2 'Enumerated handles must be released'
Write-Output 'PASS: multiple instances shut down before resource replacement'

Reset-Case 'retry' @(201)
Stop-MahjongSoul -TimeoutMilliseconds 3000
Assert-Equal $script:stops.Count 2 'A surviving process must receive another stop'
Write-Output 'PASS: surviving process is retried and disappearance is verified'

Reset-Case 'exit-race' @(301)
Stop-MahjongSoul
Assert-Equal $script:alive.Count 0 'Concurrent process exit is successful shutdown'
Write-Output 'PASS: process exit during termination is accepted'

Reset-Case 'stuck' @(401)
$failed = $false
try { Stop-MahjongSoul -TimeoutMilliseconds 20 } catch { $failed = $true }
Assert-Equal $failed $true 'A genuinely surviving process must prevent switching'
Assert-Equal $script:alive.Count 1 'Timeout must not pretend shutdown succeeded'
Write-Output 'PASS: actual timeout prevents resource replacement and relaunch'
