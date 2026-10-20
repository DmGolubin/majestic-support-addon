# Actual cmd.exe smoke tests. Only fake PowerShell backends in a fresh TEMP directory.
param([string]$Only = '*')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'standalone/installer'
$root = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-console-tests-' + [guid]::NewGuid().ToString('N'))
$package = Join-Path $root 'package with spaces & symbols! (safe)'
$payload = Join-Path $package 'SupportTemplates'
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
function Assert($value, [string]$message) { if (-not $value) { throw $message } }
function Put([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $utf8) }
function Run([string]$bat, [string]$keys = '', [string]$arguments = '', [int]$nativeExit = 0, [int]$updateExit = 0, [bool]$animate = $false) {
    $trace = Join-Path $root ('trace-' + [guid]::NewGuid().ToString('N') + '.jsonl')
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $info.Arguments = '/d /s /c ""' + (Join-Path $package $bat) + '" ' + $arguments + '"'
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_PAUSE'] = '1'
    $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_ANIMATION'] = '1'
    if ($animate) { $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_ANIMATION'] = '0' }
    $info.EnvironmentVariables['ST_TEST_TRACE'] = $trace
    $info.EnvironmentVariables['ST_TEST_NATIVE_EXIT'] = [string]$nativeExit
    $info.EnvironmentVariables['ST_TEST_UPDATE_EXIT'] = [string]$updateExit
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($keys)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw "Timed out: $bat / $keys" }
    $result = [pscustomobject]@{ code = $process.ExitCode; output = $stdout.Result + $stderr.Result; calls = @() }
    $process.Dispose()
    if (Test-Path -LiteralPath $trace) { $result.calls = @(Get-Content -LiteralPath $trace | ForEach-Object { $_ | ConvertFrom-Json }) }
    return $result
}
function Check([string]$name, [scriptblock]$body) {
    if ($name -notlike $Only) { return }
    & $body; $script:passed++; Write-Output "PASS $name"
}
[IO.Directory]::CreateDirectory($payload) | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'install.bat') -Destination $package
Copy-Item -LiteralPath (Join-Path $source 'uninstall.bat') -Destination $package
Put (Join-Path $payload 'manifest.json') '{"version":"1.0.2"}'
Put (Join-Path $payload 'SupportTemplates.ps1') @'
param([string]$Action,[string]$Channel,[switch]$Utf8Output,[switch]$WhatIf,[string]$FixturePath)
@{kind='native';action=$Action;channel=$Channel;whatIf=[bool]$WhatIf;fixture=$FixturePath} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ST_TEST_TRACE
Write-Output ('NATIVE ' + $Action)
exit ([int]$env:ST_TEST_NATIVE_EXIT)
'@
Put (Join-Path $payload 'PackageUpdate.ps1') @'
param([string]$Action,[string]$Channel,[switch]$Console)
@{kind='updater';action=$Action;channel=$Channel;console=[bool]$Console} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ST_TEST_TRACE
Write-Output 'Printed only: & echo INJECTED > unexpected.txt'
exit ([int]$env:ST_TEST_UPDATE_EXIT)
'@
Check 'explicit install forwards quoted args/WhatIf; no updater; exact exit' {
    $r = Run 'install.bat' '' '-Channel Canary -WhatIf -FixturePath "space & bang! (fixture)"' 37
    Assert ($r.code -eq 37 -and $r.calls.Count -eq 1) $r.output
    Assert ($r.calls[0].kind -eq 'native' -and $r.calls[0].action -eq 'Install' -and $r.calls[0].channel -eq 'Canary' -and $r.calls[0].whatIf -and $r.calls[0].fixture -ceq 'space & bang! (fixture)') 'CLI arguments changed'
}
Check 'explicit uninstall forwards args and exact exit; no updater' {
    $r = Run 'uninstall.bat' '' '-Channel Stable -WhatIf' 23
    Assert ($r.code -eq 23 -and $r.calls.Count -eq 1 -and $r.calls[0].action -eq 'Uninstall' -and $r.calls[0].whatIf) $r.output
}
Check 'scripted menu exit; startup Check Console; Russian UTF8 and version' {
    $r = Run 'install.bat' '0'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 1 -and $r.calls[0].action -eq 'Check' -and $r.calls[0].console) $r.output
    Assert ($r.output.Contains('Выбрать Discord') -and $r.output.Contains('Package: 1.0.2')) $r.output
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'unexpected.txt'))) 'Updater output executed as cmd'
}
Check 'startup unavailable still permits clean exit' {
    $r = Run 'install.bat' '0' '' 0 1
    Assert ($r.code -eq 0 -and $r.output.Contains('Проверка недоступна')) $r.output
}
Check 'interactive install selects Canary and routes offline helper' {
    $r = Run 'install.bat' '220'
    Assert ($r.calls.Count -eq 2 -and $r.calls[1].kind -eq 'updater' -and $r.calls[1].action -eq 'Install' -and $r.calls[1].channel -eq 'Canary' -and $r.code -eq 0) $r.output
}
Check 'cancel channel performs no install' {
    $r = Run 'install.bat' '200'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 1) $r.output
}
Check 'download then install uses helper; Check/Update Console' {
    $r = Run 'install.bat' '3120210'
    Assert ($r.calls.Count -eq 4 -and $r.calls[1].action -eq 'Check' -and $r.calls[1].console -and $r.calls[2].action -eq 'Update' -and $r.calls[2].console -and $r.calls[3].action -eq 'Install' -and $r.calls[3].channel -eq 'Stable') $r.output
}
Check 'status/removal bundled, repair verified helper for selected Stable' {
    $r = Run 'install.bat' '415610'
    Assert ($r.calls.Count -eq 4 -and ($r.calls[1..3].action -join ',') -eq 'Status,Repair,Uninstall' -and ($r.calls[1..3].kind -join ',') -eq 'native,updater,native' -and @($r.calls[1..3] | Where-Object { $_.channel -ne 'Stable' }).Count -eq 0) $r.output
}
Check 'native failure is displayed and preserved at menu exit' {
    $r = Run 'install.bat' '410' '' 19
    Assert ($r.code -eq 19 -and $r.output.Contains('Код: 19.')) $r.output
}
Check 'standalone uninstall cancellation and confirmation' {
    $r = Run 'uninstall.bat' '10210'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 1 -and $r.calls[0].action -eq 'Uninstall' -and $r.calls[0].channel -eq 'Canary') $r.output
}
Check 'standalone uninstall exit never checks network' {
    $r = Run 'uninstall.bat' '0'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 0) $r.output
}
Check 'animation path exits without backend calls' {
    $r = Run 'uninstall.bat' '0' '' 0 0 $true
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 0 -and $r.output.Contains('T E M P L A T E S')) $r.output
}
Check 'closed input fails clearly instead of busy looping' {
    $r = Run 'uninstall.bat'
    Assert ($r.code -eq 1 -and $r.calls.Count -eq 0 -and $r.output.Contains('Не удалось прочитать выбор')) $r.output
}
Check 'missing payload is actionable and nonzero' {
    Move-Item -LiteralPath (Join-Path $payload 'SupportTemplates.ps1') -Destination (Join-Path $payload 'backend.saved')
    $r = Run 'install.bat' '0'
    Assert ($r.code -eq 2 -and $r.calls.Count -eq 0 -and $r.output.Contains('Распакуйте архив целиком')) $r.output
}
# Retain bounded TEMP evidence; this harness never touches installed clients.
Write-Output "$passed console smoke tests passed. TEMP fixture: $root"
