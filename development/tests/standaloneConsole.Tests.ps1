# Actual cmd.exe smoke tests. Only fake PowerShell backends in a fresh TEMP directory.
param([string]$Only = '*', [switch]$Benchmark)
if ($Benchmark) { $Only = '__benchmark__' }
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
function Run([string]$bat, [string]$keys = '', [string]$arguments = '', [int]$nativeExit = 0, [int]$updateExit = 0, [string]$clients = 'Stable,Canary', [int]$installExit = 0, [int]$detectExit = 0, [string]$launcherRoot = $package, [switch]$directHelper, [string]$inspectionKind = 'none', [int]$inspectExit = 0, [switch]$waitForClosePrompt, [object[]]$menuSteps = @()) {
    $trace = Join-Path $root ('trace-' + [guid]::NewGuid().ToString('N') + '.jsonl')
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $env:ComSpec
    $info.Arguments = '/d /s /c ""' + (Join-Path $launcherRoot $bat) + '" ' + $arguments + '"'
    if ($directHelper) {
        $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $info.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $payload 'ConsoleInput.ps1') + '" -Action Install'
    }
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_PAUSE'] = '1'
    if ($waitForClosePrompt) { $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_PAUSE'] = '0' }
    $info.EnvironmentVariables['SUPPORT_TEMPLATES_NO_ANIMATION'] = '1'
    $info.EnvironmentVariables['ST_TEST_CLIENTS'] = $clients
    $info.EnvironmentVariables['ST_TEST_INSPECTION'] = $inspectionKind
    $info.EnvironmentVariables['ST_TEST_INSPECT_EXIT'] = [string]$inspectExit
    $info.EnvironmentVariables['ST_TEST_INSTALL_EXIT'] = [string]$installExit
    $info.EnvironmentVariables['ST_TEST_DETECT_EXIT'] = [string]$detectExit
    $info.EnvironmentVariables['ST_TEST_TRACE'] = $trace
    $info.EnvironmentVariables['ST_TEST_NATIVE_EXIT'] = [string]$nativeExit
    $info.EnvironmentVariables['ST_TEST_UPDATE_EXIT'] = [string]$updateExit
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($info)
    $stderr = $process.StandardError.ReadToEndAsync()
    $prefix = ''
    $process.StandardInput.Write($keys)
    try {
        foreach ($step in $menuSteps) {
            $found = $false
            for ($lineNumber = 0; $lineNumber -lt 100; $lineNumber++) {
                $read = $process.StandardOutput.ReadLineAsync()
                if (-not $read.Wait(10000)) { throw ('Timed out waiting for menu: ' + $step.Prompt) }
                $line = $read.Result
                if ($null -eq $line) { break }
                $prefix += $line + "`n"
                if ($line.Contains($step.Prompt)) { $found = $true; break }
            }
            Assert $found ('Menu missing: ' + $prefix)
            $process.StandardInput.Write($step.Select)
            $process.StandardInput.Flush()
            Assert (-not $process.WaitForExit(200)) 'Selection completed before Enter'
            $actions = @((Get-Content -LiteralPath $trace) | ForEach-Object { ($_ | ConvertFrom-Json).action }) -join ','
            Assert ($actions -ceq $step.Actions) ('Selection ran an operation before Enter: ' + $actions)
            $process.StandardInput.Write($step.Resume)
            $process.StandardInput.Flush()
        }
    } catch {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
        throw
    }
    if ($waitForClosePrompt) {
        try {
            $found = $false
            for ($lineNumber = 0; $lineNumber -lt 100; $lineNumber++) {
                $read = $process.StandardOutput.ReadLineAsync()
                if (-not $read.Wait(10000)) { throw 'Timed out waiting for close prompt' }
                $line = $read.Result
                if ($null -eq $line) { break }
                $prefix += $line + "`n"
                if ($line -eq '[0 / Enter / Esc] Закрыть') { $found = $true; break }
            }
            Assert $found ('Close prompt missing: ' + $prefix)
            Assert (-not $process.WaitForExit(150)) 'Error screen closed before the user chose 0'
            $process.StandardInput.Write('xyz0')
        } catch {
            if (-not $process.HasExited) { $process.Kill() }
            throw
        }
    }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw "Timed out: $bat / $keys" }
    $result = [pscustomobject]@{ code = $process.ExitCode; output = $prefix + $stdout.Result + $stderr.Result; calls = @(); durationMs = $timer.Elapsed.TotalMilliseconds }
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
Copy-Item -LiteralPath (Join-Path $source 'ConsoleInput.ps1') -Destination $payload
Copy-Item -LiteralPath (Join-Path $source 'ConsoleView.ps1') -Destination $payload
Put (Join-Path $payload 'manifest.json') '{"version":"1.0.3"}'
Put (Join-Path $payload 'SupportTemplates.ps1') @'
param([string]$Action,[string]$Channel,[switch]$Utf8Output,[switch]$WhatIf,[string]$FixturePath)
@{kind='native';pid=$PID;action=$Action;channel=$Channel;whatIf=[bool]$WhatIf;fixture=$FixturePath} | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ST_TEST_TRACE
if ($Action -eq 'Detect') {
    if ($env:ST_TEST_CLIENTS -eq 'MALFORMED') { Write-Output '[broken' }
    else {
        $clientText = [string]$env:ST_TEST_CLIENTS
        $found = @($clientText.Split(',') | Where-Object { $_ } | ForEach-Object { @{ Channel = $_; Path = 'fixture only' } })
        ConvertTo-Json -InputObject $found -Compress
    }
    exit ([int]$env:ST_TEST_DETECT_EXIT)
}
Write-Output ('NATIVE ' + $Action)
exit ([int]$env:ST_TEST_NATIVE_EXIT)
'@
Put (Join-Path $payload 'PackageUpdate.ps1') @'
param([string]$Action,[string]$Channel,[switch]$Console,[switch]$CloseDiscord)
$script:FixtureConsole = [bool]$Console
$script:FixtureCloseDiscord = [bool]$CloseDiscord
function Invoke-PackageUpdate([string]$Operation,[string]$TargetChannel,[string]$Cache,[string]$Replacement = '') {
    @{kind='updater';pid=$PID;action=$Operation;channel=$TargetChannel;console=$script:FixtureConsole;closeDiscord=($script:FixtureCloseDiscord -and $Operation -in @('Install','Repair'));replacement=$Replacement} |
        ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ST_TEST_TRACE
    $failureCode = [int]$env:ST_TEST_UPDATE_EXIT
    if ($Operation -eq 'Inspect') {
        if ([int]$env:ST_TEST_INSPECT_EXIT) { throw 'Inspection fixture failed' }
        if ($env:ST_TEST_INSPECTION -eq 'malformed') { return '{broken' }
        return (@{channel=$TargetChannel;kind=$env:ST_TEST_INSPECTION;canReplace=($env:ST_TEST_INSPECTION -in @('vencord','betterdiscord'));reason='Fixture unsupported installation'} | ConvertTo-Json -Compress)
    }
    if ($Operation -eq 'Install') { $failureCode = [int]$env:ST_TEST_INSTALL_EXIT }
    if ($failureCode) { throw "Configured fixture failure: $failureCode" }
    if ($Operation -eq 'Install') { return @('SupportTemplates установлен.', 'Перезапустите Discord.') }
    return (@{schema=1;action=$Operation;selectedVersion='1.0.4';latestVersion='1.0.4';updateAvailable=$false} | ConvertTo-Json -Compress)
}
function Write-PackageConsoleResult($Status) {
    Write-Output 'Printed only: & echo INJECTED > unexpected.txt'
}
function Get-PackageConsoleError([Exception]$Failure) { return 'Fixture operation unavailable.' }
# Identical fake API also supports the old process entry for the optional offline benchmark.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $result = Invoke-PackageUpdate $Action $Channel ''
        if ($Console -and $Action -eq 'Update') { Write-PackageConsoleResult ($result | ConvertFrom-Json) }
    } catch { [Console]::Error.WriteLine((Get-PackageConsoleError $_.Exception)); exit 1 }
}
'@
foreach ($mod in @('vencord','betterdiscord')) {
    Check ("conversion $mod cancellation never installs or closes") {
        $r = Run 'install.bat' "1`n1`n00" -inspectionKind $mod
        Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect') $r.output
        Assert (@($r.calls | Where-Object { $_.kind -eq 'updater' -and $_.closeDiscord }).Count -eq 0) 'Cancellation closed client'
        Assert ($r.output.Contains('[1] Заменить на SupportTemplates') -and $r.output.Contains('файлы и настройки сохранятся')) $r.output
    }
    Check ("conversion $mod explicit replacement ignores invalid keys") {
        $r = Run 'install.bat' "1`n1`nxyz291`n" -inspectionKind $mod
        Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install') $r.output
        Assert ($r.calls[3].replacement -ceq $mod -and $r.calls[3].closeDiscord -and -not $r.calls[2].closeDiscord) 'Wrong conversion consent or closure'
    }
}
Check 'conversion cancellation EOF never installs' {
    $r = Run 'install.bat' "1`n1`n" -inspectionKind vencord
    Assert ($r.code -ne 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect') $r.output
}
Check 'unsupported inspection gives reason and returns without install' {
    $r = Run 'install.bat' "1`n1`n00" -inspectionKind unsupported
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect' -and $r.output.Contains('Причина: Установленный мод не поддерживает') -and -not $r.output.Contains('Fixture unsupported installation')) $r.output
}
Check 'failed inspection returns before install or closing' {
    $r = Run 'install.bat' "1`n1`n00" -inspectExit 9
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect' -and -not $r.calls[2].closeDiscord -and $r.output.Contains('Fixture operation unavailable.')) $r.output
}
Check 'malformed inspection cannot install' {
    $r = Run 'install.bat' "1`n1`n00" -inspectionKind malformed
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect') $r.output
}
Check 'owned SupportTemplates needs no replacement confirmation or flag' {
    $r = Run 'install.bat' "1`n1`n" -inspectionKind supporttemplates
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.calls[3].replacement -ceq '' -and -not $r.output.Contains('Заменить на SupportTemplates')) $r.output
}
Check 'explicit install: quoted args/WhatIf, exact exit, no updater/detection' {
    $r = Run 'install.bat' '' '-Channel Canary -WhatIf -FixturePath "space & bang! (fixture)"' 37
    Assert ($r.code -eq 37 -and $r.calls.Count -eq 1) $r.output
    Assert ($r.calls[0].kind -eq 'native' -and $r.calls[0].action -eq 'Install' -and $r.calls[0].channel -eq 'Canary' -and $r.calls[0].whatIf -and $r.calls[0].fixture -ceq 'space & bang! (fixture)') 'CLI arguments changed'
}
Check 'explicit uninstall: args and exact exit, no updater/detection' {
    $r = Run 'uninstall.bat' '' '-Channel PTB -WhatIf' 23
    Assert ($r.code -eq 23 -and $r.calls.Count -eq 1 -and $r.calls[0].action -eq 'Uninstall' -and $r.calls[0].channel -eq 'PTB' -and $r.calls[0].whatIf) $r.output
}
Check 'install home exit: startup Update Console, UTF8, no output execution' {
    $r = Run 'install.bat' '0'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 1 -and $r.calls[0].action -eq 'Update' -and $r.calls[0].console) $r.output
    Assert ($r.output.Contains('[Enter] Выбрать Discord') -and $r.output.Contains('[0 / Esc] Выход')) $r.output
    Assert ($r.output.Contains('Версия установщика: 1.0.3') -and $r.output.Contains('SupportTemplates / 1.0.4')) 'Installer and selected package versions must be shown on the correct screens'
    Assert (-not (Test-Path -LiteralPath (Join-Path $root 'unexpected.txt'))) 'Updater output executed as cmd'
}
Check 'startup update failure does not prevent explicit exit' {
    $r = Run 'install.bat' '0' '' 0 1
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 1) $r.output
}
Check 'only Canary: visible choice 1 invokes Install Console Canary and exits' {
    $r = Run 'install.bat' "1`n1`n" '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.calls[3].channel -eq 'Canary' -and $r.calls[3].console) $r.output
    Assert ($r.output.Contains('[1] Discord Canary') -and -not $r.output.Contains('[2] Discord')) $r.output
    Assert (@($r.calls.pid | Select-Object -Unique).Count -eq 1) 'Update, client selection/Detect and Install did not share one process'
    Assert (-not $r.calls[0].closeDiscord -and -not $r.calls[2].closeDiscord -and $r.calls[3].closeDiscord) 'Console installer omitted CloseDiscord'
}
Check 'network failure still allows install in the persistent process' {
    $r = Run 'install.bat' "1`n1`n" '' 0 7 'Canary'
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.output.Contains('Fixture operation unavailable.')) $r.output
    Assert (@($r.calls.pid | Select-Object -Unique).Count -eq 1 -and $r.calls[3].closeDiscord) 'Network failure lost persistent installer context'
}
Check 'cancel and reselect retains one process and calls Update only once' {
    $r = Run 'install.bat' "1`n01`n1`n" '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Detect,Inspect,Install') $r.output
    Assert (@($r.calls.pid | Select-Object -Unique).Count -eq 1) 'Picker restart spawned a fresh installer process'
}
foreach ($selection in @(@('1', 'Stable'), @('2', 'Canary'), @('3', 'PTB'))) {
    Check ('all clients: choice ' + $selection[0] + ' maps to ' + $selection[1]) {
        $r = Run 'install.bat' ("1`n" + $selection[0] + "`n") '' 0 0 'Stable,Canary,PTB'
        Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.calls[3].channel -eq $selection[1]) $r.output
        Assert ($r.output.Contains('[1] Discord') -and $r.output.Contains('[2] Discord Canary') -and $r.output.Contains('[3] Discord PTB')) $r.output
    }
}
Check 'single PTB: consecutive choice maps to fixed PTB channel code' {
    $r = Run 'install.bat' "1`n1`n" '' 0 0 'PTB'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 4 -and $r.calls[3].channel -eq 'PTB' -and $r.output.Contains('[1] Discord PTB')) $r.output
}
Check 'redirected invalid keys stay silent while ANSI arrows select and CRLF confirms once' {
    $r = Run 'install.bat' ("xyz" + [char]27 + '[1;2A' + "1`r`n" + [char]27 + '[B' + [char]27 + '[3~' + "1xyz`r`n") '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 4 -and $r.calls[3].channel -eq 'Canary') $r.output
    Assert (-not $r.output.Contains('xyz') -and -not $r.output.Contains('[1;2A') -and -not $r.output.Contains([string][char]7)) 'Input echoed or emitted BEL'
}
Check 'uninstalled channel number ignored instead of selecting Canary implicitly' {
    $r = Run 'install.bat' "1`n231`n" '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and $r.calls.Count -eq 4 -and $r.calls[3].channel -eq 'Canary') $r.output
}
Check 'no clients: back and exit do not install' {
    $r = Run 'install.bat' "1`n00" '' 0 0 ''
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect' -and $r.output.Contains('Discord не найден')) $r.output
}
Check 'cancel detected client picker returns to home without installing' {
    $r = Run 'install.bat' "1`n00"
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
}
Check 'install exception: returns failure code 1 and never prints success' {
    $r = Run 'install.bat' "1`n1`n" '' 0 0 'Canary' 19
    Assert ($r.code -eq 1 -and $r.calls.Count -eq 4 -and $r.output.Contains('Fixture operation unavailable.') -and -not $r.output.Contains('Готово.')) $r.output
}
Check 'failed Detect fails closed without installation' {
    $r = Run 'install.bat' "1`n1`n" '' 0 0 'Canary' 0 4
    Assert ($r.code -ne 0 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
}
Check 'malformed Detect JSON fails closed' {
    $r = Run 'install.bat' "1`n1`n" '' 0 0 'MALFORMED'
    Assert ($r.code -ne 0 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
}
Check 'Detect failure remains readable until explicit close, without installing' {
    $r = Run 'install.bat' "1`n" -detectExit 4 -waitForClosePrompt
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect' -and $r.output.Contains('Установка не начата.') -and $r.output.Contains('[0 / Enter / Esc] Закрыть')) $r.output
    Assert (-not $r.output.Contains('xyz') -and -not $r.output.Contains([string][char]7)) 'Close input echoed or rang'
}
Check 'malformed Detect remains readable until explicit close' {
    $r = Run 'install.bat' "1`n" -clients MALFORMED -waitForClosePrompt
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect' -and $r.output.Contains('[0 / Enter / Esc] Закрыть')) $r.output
}
Check 'Install failure remains readable until explicit close' {
    $r = Run 'install.bat' "1`n1`n" -installExit 9 -waitForClosePrompt
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.output.Contains('Fixture operation unavailable.') -and -not $r.output.Contains('Установка завершена')) $r.output
}
Check 'completed operation returns every ordinary output line without control sequences or fake progress' {
    $r = Run 'install.bat' "1`n1`n"
    Assert ($r.code -eq 0 -and $r.output.Contains('SupportTemplates установлен.') -and $r.output.Contains('Перезапустите Discord.')) $r.output
    Assert (-not $r.output.Contains([string][char]27) -and $r.output -notmatch '\d+%|\[F2\]|\[F3\]|Сценарии|Выбор логотипа') 'Nonproduction output'
}
Check 'unknown and duplicate detected clients fail closed' {
    foreach ($clients in @('Unknown','Canary,Canary')) {
        $r = Run 'install.bat' "1`n" -clients $clients
        Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
    }
}
Check 'closed home input: bounded nonzero failure' {
    $r = Run 'install.bat'
    Assert ($r.code -eq 1 -and $r.calls.Count -eq 1 -and $r.output.Contains('Не удалось прочитать выбор')) $r.output
}
Check 'direct helper EOF returns 255 before BAT normalizes it to 1' {
    $r = Run 'install.bat' -directHelper
    Assert ($r.code -eq 255 -and $r.calls.Count -eq 1 -and $r.output.Contains('Не удалось прочитать выбор')) $r.output
}
Check 'closed picker input: bounded nonzero failure' {
    $r = Run 'install.bat' "1`n"
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
}
Check 'open input: digits and arrows only select; each Enter unlocks exactly the next menu operation' {
    $r = Run 'install.bat' -clients 'Stable,Canary,PTB' -inspectionKind vencord -menuSteps @(
        @{Prompt='[Enter] Выбрать Discord';Select=('111' + [char]27 + '[B');Actions='Update';Resume="`n"}
        @{Prompt='[Enter] Установить';Select=('2' + [char]27 + '[B');Actions='Update,Detect';Resume="`n"}
        @{Prompt='[Enter] Подтвердить';Select=('111' + [char]27 + '[A');Actions='Update,Detect,Inspect';Resume="`n"}
    )
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.calls[3].channel -ceq 'PTB' -and $r.calls[3].replacement -ceq 'vencord') $r.output
}
Check 'bare Enter confirms the preselected first available client' {
    $r = Run 'install.bat' "`n`n" -clients PTB
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect,Install' -and $r.calls[3].channel -ceq 'PTB') $r.output
}
Check 'selection then EOF never advances the home, picker or replacement menu' {
    foreach ($case in @(
        @{Keys='123';Actions='Update'},
        @{Keys="1`n2";Actions='Update,Detect'},
        @{Keys="1`n1`n1";Actions='Update,Detect,Inspect'},
        @{Keys=("1`n1`n" + [char]27 + '[B');Actions='Update,Detect,Inspect'}
    )) {
        $r = Run 'install.bat' $case.Keys -inspectionKind vencord
        Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -ceq $case.Actions) $r.output
        Assert (@($r.calls | Where-Object { $_.kind -eq 'updater' -and $_.closeDiscord }).Count -eq 0) 'EOF closed client'
    }
}
Check 'Esc cancels pending selection with input still open and returns to home' {
    $r = Run 'install.bat' -menuSteps @(
        @{Prompt='[Enter] Выбрать Discord';Select='1';Actions='Update';Resume="`n"}
        @{Prompt='[Enter] Установить';Select='2';Actions='Update,Detect';Resume=([string][char]27)}
        @{Prompt='[Enter] Выбрать Discord';Select='1';Actions='Update,Detect';Resume='0'}
    )
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect') $r.output
}
Check 'Esc cancels replacement selection and exits home without closing a client' {
    $r = Run 'install.bat' "1`n1`n" -inspectionKind betterdiscord -menuSteps @(
        @{Prompt='[Enter] Подтвердить';Select='1';Actions='Update,Detect,Inspect';Resume=([string][char]27)}
        @{Prompt='[Enter] Выбрать Discord';Select='';Actions='Update,Detect,Inspect';Resume=([string][char]27)}
    )
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect') $r.output
}
Check 'CRLF cannot confirm two menus or trigger replacement' {
    $r = Run 'install.bat' "1`r`n1`r`n1" -inspectionKind vencord
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Update,Detect,Inspect') $r.output
    $r = Run 'uninstall.bat' "1`r`n1"
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Detect') $r.output
}
Check 'arrows wrap only among detected choices and modified ANSI controls are ignored' {
    $r = Run 'install.bat' ("`n" + [char]27 + '[A' + [char]27 + '[1;2B' + [char]27 + '[1;3D' + [char]27 + '[1;5C' + "`n") -clients 'Stable,Canary,PTB'
    Assert ($r.code -eq 0 -and $r.calls[3].channel -ceq 'PTB') $r.output
    Assert (-not $r.output.Contains('[1;2B') -and -not $r.output.Contains([string][char]7)) 'Unwanted control echoed'
}
Check 'uninstall: only Canary choice 1 then confirmation, native and exit' {
    $r = Run 'uninstall.bat' "1`n1`n" '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Detect,Uninstall' -and $r.calls[1].channel -eq 'Canary' -and $r.calls[1].kind -eq 'native') $r.output
}
Check 'uninstall: cancellation and picker exit never call updater or uninstall' {
    $r = Run 'uninstall.bat' "1`n00" '' 0 0 'Canary'
    Assert ($r.code -eq 0 -and @($r.calls | Where-Object { $_.action -ne 'Detect' }).Count -eq 0) $r.output
}
Check 'uninstall: PTB native error preserved and no false success' {
    $r = Run 'uninstall.bat' "3`n1`n" '' 29 0 'Stable,Canary,PTB'
    Assert ($r.code -eq 29 -and ($r.calls.action -join ',') -eq 'Detect,Uninstall' -and $r.calls[1].channel -eq 'PTB' -and -not $r.output.Contains('Готово.')) $r.output
}
Check 'uninstall: no clients only back exits' {
    $r = Run 'uninstall.bat' '0' '' 0 0 ''
    Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq 'Detect' -and $r.output.Contains('Discord не найден')) $r.output
}
Check 'uninstall: closed input fails without mutations' {
    $r = Run 'uninstall.bat'
    Assert ($r.code -eq 1 -and ($r.calls.action -join ',') -eq 'Detect') $r.output
}
Check 'missing rendering helper: actionable and nonzero' {
    $viewPath = Join-Path $payload 'ConsoleView.ps1'
    Move-Item -LiteralPath $viewPath -Destination (Join-Path $payload 'view.saved')
    try {
        $r = Run 'install.bat' '0'
        Assert ($r.code -eq 2 -and $r.calls.Count -eq 0 -and $r.output.Contains('Распакуйте архив целиком')) $r.output
    } finally { Move-Item -LiteralPath (Join-Path $payload 'view.saved') -Destination $viewPath }
}
Check 'missing payload: actionable and nonzero' {
    Move-Item -LiteralPath (Join-Path $payload 'SupportTemplates.ps1') -Destination (Join-Path $payload 'backend.saved')
    $r = Run 'install.bat' '0'
    Assert ($r.code -eq 2 -and $r.calls.Count -eq 0 -and $r.output.Contains('Распакуйте архив целиком')) $r.output
}
# Retain bounded TEMP evidence; no Discord executable, directory or network is used.
Write-Output "$passed console smoke tests passed. TEMP fixture: $root"
if ($Benchmark) {
    # 689b424 is the released 1.0.3 launcher; all package/native effects still use identical fake scripts.
    $old = Join-Path $root 'old 1.0.3 & package'
    [IO.Directory]::CreateDirectory($old) | Out-Null
    Copy-Item -LiteralPath $payload -Destination $old -Recurse
    $repository = Split-Path $PSScriptRoot -Parent
    foreach ($relative in @('install.bat', 'ConsoleInput.ps1')) {
        $oldText = & git -C $repository show ('689b424:standalone/installer/' + $relative)
        Assert ($LASTEXITCODE -eq 0) 'Cannot read 1.0.3 benchmark source'
        $destination = Join-Path $old 'install.bat'
        $encoding = $utf8
        if ($relative -eq 'ConsoleInput.ps1') {
            $destination = Join-Path $old 'SupportTemplates/ConsoleInput.ps1'
            $encoding = New-Object Text.UTF8Encoding($true)
        }
        [IO.File]::WriteAllText($destination, ($oldText -join "`r`n") + "`r`n", $encoding)
    }
    $samples = @()
    foreach ($round in 1..3) {
        $order = @('old', 'new')
        if ($round -eq 2) { $order = @('new', 'old') }
        foreach ($variant in $order) {
            $location = $package
            if ($variant -eq 'old') { $location = $old }
            $r = Run 'install.bat' "1`n1`n" '' 0 0 'Canary' 0 0 $location
            $expectedActions = 'Update,Detect,Inspect,Install'
            if ($variant -eq 'old') { $expectedActions = 'Update,Detect,Install' }
            Assert ($r.code -eq 0 -and ($r.calls.action -join ',') -eq $expectedActions) $r.output
            $samples += [pscustomobject]@{
                variant = $variant; round = $round; durationMs = [Math]::Round($r.durationMs, 2)
                tracedPids = @($r.calls.pid | Select-Object -Unique)
            }
        }
    }
    $oldMedian = @($samples | Where-Object variant -eq old | Sort-Object durationMs)[1].durationMs
    $newMedian = @($samples | Where-Object variant -eq new | Sort-Object durationMs)[1].durationMs
    $report = [pscustomobject]@{
        baseline = '1.0.3 / 689b424'; scenario = 'offline fake Update, select only Canary, fake Install'
        oldMedianMs = $oldMedian; newMedianMs = $newMedian
        speedup = [Math]::Round($oldMedian / $newMedian, 2); samples = $samples
    }
    Put (Join-Path $root 'benchmark.json') ($report | ConvertTo-Json -Depth 6)
    Write-Output ($report | ConvertTo-Json -Depth 6)
}
