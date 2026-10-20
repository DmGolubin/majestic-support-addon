# Actual exported result handler, no window, subprocess, filesystem mutation or Discord.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Import-Module (Join-Path $PSScriptRoot '../standalone/installer/InstallerGui.psm1') -Force

function Assert($condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Result([string]$text) {
    $output = New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'
    $output.SetResult($text)
    $errorTask = New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'
    $errorTask.SetResult('')
    $process = [pscustomobject]@{ HasExited=$true; ExitCode=0; Disposed=$false }
    $process | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
    $controls = @{}
    foreach ($name in @('Activity', 'Elapsed', 'Details')) {
        $controls[$name] = [pscustomobject]@{Text=''; Foreground=''}
    }
    $controls.LogDetails = [pscustomobject]@{IsExpanded=$false}
    $controls.Progress = [pscustomobject]@{IsIndeterminate=$true; Visibility='Visible'}
    $controls.Clients = [pscustomobject]@{IsEnabled=$false; SelectedItem=[pscustomobject]@{Channel='Canary'}}
    foreach ($name in @('Install', 'Status', 'Repair', 'Uninstall', 'Refresh')) {
        $controls[$name] = [pscustomobject]@{IsEnabled=$false}
    }
    $model = [pscustomobject]@{Controls=$controls; LastResult=$null; Job=[pscustomobject]@{
        Process=$process; Output=$output.Task; Error=$errorTask.Task
        Action='Status'; Channel='Canary'; Started=[DateTime]::UtcNow
    }}
    Update-InstallerOperation $model
    Assert ($null -eq $model.Job -and $process.Disposed) 'Handler did not release its completed process'
    Assert ($controls.Status.IsEnabled -and -not $controls.Progress.IsIndeterminate) 'Handler did not restore idle controls'
    Assert ($controls.Details.Text -ceq $text) 'Handler discarded backend details'
    return $model
}

$installed = 'Installed: SupportTemplates Lite 1.0.1-canary.37, canary'
$passed = 0
foreach ($text in @(
    "$installed`nPending renderer update: retry UpdateRenderer to finish.",
    "Pending full-install renderer cleanup; repeat Install with the target closed.`n$installed",
    'Pending transaction: resources. Run repair or uninstall with the target closed to recover.'
)) {
    $result = Result $text
    Assert ($result.Controls.Activity.Foreground -ceq '#F0C879') 'Pending status must use warning color, even after Installed'
    Assert $result.Controls.LogDetails.IsExpanded 'Pending backend instructions must be visible'
    Assert ($result.Controls.Activity.Text -ne (Result $installed).Controls.Activity.Text) 'Pending status was summarized as healthy'
    $passed++
}
foreach ($text in @($installed, 'Not installed: canary at resources')) {
    $result = Result $text
    Assert ($result.Controls.Activity.Foreground -ceq '#8DD9AB') 'Ordinary status unexpectedly warned'
    Assert (-not $result.Controls.LogDetails.IsExpanded) 'Ordinary details should remain collapsed'
    $passed++
}
Write-Output "$passed GUI status handler cases passed. No disk/client mutation."
