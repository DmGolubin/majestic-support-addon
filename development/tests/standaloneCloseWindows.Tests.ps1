# Real Windows process lifecycle, isolated executables under TEMP. Never touches Discord.
[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if (-not $Installer) { $Installer = Join-Path $PSScriptRoot '../standalone/installer/SupportTemplates.ps1' }
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$null, [ref]$null)
$names = @('Require','Full','Under','Get-TargetProcesses','Read-LiveProcessPath','Check-TargetStopped','Confirm-ClosePath','Confirm-CloseProcess','Close-TargetDiscord')
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $names) { . ([scriptblock]::Create($definition.Extent.Text)) }
}
$script:Fixture = $false
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-close-' + [guid]::NewGuid().ToString('N'))
$script:DiscordRoot = Join-Path $probeRoot 'client'
$script:ExeName = 'STCloseProbe' + [guid]::NewGuid().ToString('N')
$app = Join-Path $script:DiscordRoot 'app-1.0.9'
$otherApp = Join-Path $probeRoot 'other'
$exe = Join-Path $app ($script:ExeName + '.exe')
$otherExe = Join-Path $otherApp ($script:ExeName + '.exe')
$owned = @()
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Safe-File($Path) { Assert ((Under $Path $probeRoot) -and [IO.File]::Exists($Path)) 'Unexpected process path' }
function Check-CloseHostOwnership($Path) { Assert ($Path -eq $exe) 'Unexpected host' }
try {
    [IO.Directory]::CreateDirectory($app) | Out-Null
    [IO.Directory]::CreateDirectory($otherApp) | Out-Null
    Add-Type -TypeDefinition 'public class STCloseProbe { public static void Main() { System.Threading.Thread.Sleep(60000); } }' -OutputAssembly $exe -OutputType ConsoleApplication
    Copy-Item -LiteralPath $exe -Destination $otherExe
    1..3 | ForEach-Object { $owned += Start-Process -FilePath $exe -WindowStyle Hidden -PassThru }
    $external = Start-Process -FilePath $otherExe -WindowStyle Hidden -PassThru
    $owned += $external
    Assert (Close-TargetDiscord) 'Real close failed'
    foreach ($p in $owned[0..2]) { Assert ($p.WaitForExit(3000)) 'Selected process survived' }
    Assert (-not $external.HasExited) 'Unrelated process was closed'
    Write-Output 'PASS real selected processes close; unrelated installation stays running'

    # Hold a real Process snapshot across termination, as enumeration can do.
    $script:ExitedSnapshot = Get-Process -Id $external.Id
    $null = $script:ExitedSnapshot.Handle
    $external.Kill()
    $external.WaitForExit()
    function Get-TargetProcesses { return @($script:ExitedSnapshot) }
    Check-TargetStopped
    Assert (Close-TargetDiscord) 'Exited Windows process snapshot blocked installation'
    Write-Output 'PASS exited Windows process snapshot permits installation'
} finally {
    foreach ($p in $owned) {
        try { if (-not $p.HasExited) { $p.Kill(); $p.WaitForExit() } } finally { $p.Dispose() }
    }
    $resolved = [IO.Path]::GetFullPath($probeRoot)
    if ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -match '^SupportTemplates-close-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
