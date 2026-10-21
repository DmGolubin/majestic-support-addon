# Persistent console menu; native operations run in an isolated validated process.
[CmdletBinding()]
param(
    [ValidateSet('Key', 'Clients', 'Install')][string]$Action = 'Key',
    [ValidatePattern('^[0-9]{1,10}$')][string]$Keys = '10'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$script:ConsoleView = $null
$script:MenuStream = $null
$script:MenuPending = $null
$script:MenuByte = New-Object byte[] 1

function Read-MenuByte([int]$Timeout = -1) {
    if ($null -eq $script:MenuStream) { $script:MenuStream = [Console]::OpenStandardInput() }
    if ($null -eq $script:MenuPending) {
        if ($Timeout -lt 0) { return $script:MenuStream.ReadByte() }
        $script:MenuPending = $script:MenuStream.ReadAsync($script:MenuByte, 0, 1)
    }
    if ($Timeout -ge 0 -and -not $script:MenuPending.Wait($Timeout)) { return -2 }
    $count = $script:MenuPending.GetAwaiter().GetResult()
    $script:MenuPending = $null
    if ($count -eq 0) { return -1 }
    return [int]$script:MenuByte[0]
}

function Read-MenuInput {
    if ([Console]::IsInputRedirected) {
        $value = Read-MenuByte
        if ($value -lt 0) { throw 'Input closed' }
        # LF confirms a redirected line; CR is ignored so CRLF cannot confirm two
        # menus, including the uninstall launcher's separate helper processes.
        if ($value -eq 10) { return 'Enter' }
        if ($value -eq 27) {
            # Distinguish a bare Esc from ANSI navigation without waiting for EOF.
            # Keep any pending byte read for the next menu after cancellation.
            $next = Read-MenuByte 65
            if ($next -lt 0) { return 'Escape' }
            if ($next -notin @(91, 79)) { return 'Ignore' } # Alt + character
            $sequence = ''
            do {
                $next = Read-MenuByte
                if ($next -lt 0) { throw 'Input closed' }
                $sequence += [char]$next
            } while ($next -lt 64 -or $next -gt 126)
            switch ($sequence) {
                'A' { return 'UpArrow' }; 'B' { return 'DownArrow' }
                'C' { return 'RightArrow' }; 'D' { return 'LeftArrow' }
                '5~' { return 'PageUp' }; '6~' { return 'PageDown' }
            }
            return 'Ignore'
        }
        if ($value -ge 48 -and $value -le 57) { return [string][char]$value }
        return 'Ignore'
    }
    # Intercept every key, including modifiers and unsupported controls, silently.
    $key = [Console]::ReadKey($true)
    if ($key.Modifiers -ne 0) { return 'Ignore' }
    if ($key.Key -in @([ConsoleKey]::Enter, [ConsoleKey]::Escape, [ConsoleKey]::UpArrow,
        [ConsoleKey]::DownArrow, [ConsoleKey]::LeftArrow, [ConsoleKey]::RightArrow,
        [ConsoleKey]::PageUp, [ConsoleKey]::PageDown)) { return $key.Key.ToString() }
    if ($key.KeyChar -ge '0' -and $key.KeyChar -le '9') { return [string]$key.KeyChar }
    return 'Ignore'
}

function Set-MenuSelection([string]$Key) {
    if ($null -ne $script:ConsoleView -and $null -ne $script:ConsoleView.Screen) {
        $script:ConsoleView.Screen.SelectedKey = $Key
        $script:ConsoleView.FollowSelection = $true
        Update-ConsoleScreen
    } else {
        # Legacy -Action Key/Clients callers keep their existing action text.
        Write-Host ('  [{0}] < выбран >    [Enter] Подтвердить    [0 / Esc] Назад' -f $Key)
    }
}

function Read-MenuKey([string]$Allowed) {
    $choices = $Allowed.Replace('0', '')
    $selected = 0
    $cancel = $Allowed.IndexOf('0')
    if ($choices.Length -gt 0) { Set-MenuSelection ([string]$choices[$selected]) }
    while ($true) {
        if ($null -ne $script:ConsoleView -and $script:ConsoleView.Interactive) {
            Update-ConsoleScreen
            if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 65; continue }
        }
        $key = Read-MenuInput
        if ($key -in @('0', 'Escape') -and $cancel -ge 0) { return $cancel + 1 }
        if ($null -ne $script:ConsoleView -and $script:ConsoleView.Interactive) {
            if ($key -eq 'PageUp') { $script:ConsoleView.Page = [Math]::Max(0, $script:ConsoleView.Page - 1); continue }
            if ($key -eq 'PageDown') { $script:ConsoleView.Page = [Math]::Min($script:ConsoleView.Pages - 1, $script:ConsoleView.Page + 1); continue }
            if ($script:ConsoleView.TooSmall) { continue }
        }
        if ($key -eq 'Enter') {
            if ($choices.Length -eq 0) { return $cancel + 1 }
            return $Allowed.IndexOf($choices[$selected]) + 1
        }
        if ($choices.Length -eq 0) { continue }
        if ($key -in @('UpArrow','LeftArrow')) { $selected = ($selected + $choices.Length - 1) % $choices.Length }
        elseif ($key -in @('DownArrow','RightArrow')) { $selected = ($selected + 1) % $choices.Length }
        elseif ($key.Length -eq 1 -and $choices.IndexOf($key) -ge 0) { $selected = $choices.IndexOf($key) }
        else { continue }
        Set-MenuSelection ([string]$choices[$selected])
    }
}

function Show-DiscordClients {
    $native = Join-Path $PSScriptRoot 'SupportTemplates.ps1'
    # Script exit codes are written to the global automatic variable in PS5.1.
    # A local variable would mask a failed Detect and allow installation to proceed.
    $global:LASTEXITCODE = 0
    $raw = & $native -Action Detect
    if ($global:LASTEXITCODE -ne 0) { throw 'Client detection failed' }
    $parsed = ConvertFrom-Json -InputObject ($raw -join "`n")
    $clients = @($parsed)
    if ($clients.Count -eq 0) {
        Write-Host '  Discord не найден. Сначала установите Discord, Canary или PTB.'
        Write-Host ''
        Write-Host '  [0 / Esc] Назад'
        [void](Read-MenuKey '0')
        return 0
    }
    $codes = @{ Stable = 1; Canary = 2; PTB = 3 }
    $labels = @{ Stable = 'Discord'; Canary = 'Discord Canary'; PTB = 'Discord PTB' }
    $allowed = ''
    for ($i = 0; $i -lt $clients.Count; $i++) {
        $client = $clients[$i]
        if (-not $codes.ContainsKey($client.Channel)) { throw 'Unknown Discord channel' }
        $number = $i + 1
        $allowed += [string]$number
        Write-Host ('  [{0}] {1}' -f $number, $labels[$client.Channel])
    }
    Write-Host '  [0 / Esc] Назад'
    Write-Host ''
    $selected = Read-MenuKey ($allowed + '0')
    if ($selected -gt $clients.Count) { return 0 }
    return [int]$codes[$clients[$selected - 1].Channel]
}

function Get-InspectionReason([string]$Reason) {
    # Older native packages return these reasons in English.
    if ($Reason -match '[А-Яа-яЁё]' -and $Reason.Length -le 400 -and $Reason -notmatch '[\x00-\x1f\x7f]') { return $Reason }
    switch -Regex ($Reason) {
        'running|close the target' { return 'Discord ещё запущен.' }
        'not found|no supported' { return 'Выбранный клиент Discord не найден.' }
        'backup|ownership|state|journal|transaction' { return 'Не удалось проверить состояние прежней установки.' }
        default { return 'Установленный мод не поддерживает автоматическую замену.' }
    }
}

function Show-ConsoleResult([string]$Title, [object[]]$Lines) {
    $footer = ''
    if ($env:SUPPORT_TEMPLATES_NO_PAUSE -ne '1') { $footer = '[0 / Enter / Esc] Закрыть' }
    Show-ConsoleScreen $Title $Lines $footer
    if ($footer) { [void](Read-MenuKey '0') }
}

function Invoke-ConsoleOperation([ValidateSet('Update','Detect','Inspect','Install')][string]$Operation,
    [string]$Channel, [string]$Cache, [string]$Title, [string]$Detail, [string]$Replacement = '') {
    Show-ConsoleScreen $Title @(New-ConsoleLine $Detail 'Muted') -Busy
    $worker = [PowerShell]::Create()
    $pending = $null
    $stdout = [Console]::Out; $stderr = [Console]::Error
    $capture = New-Object IO.StringWriter
    $writer = [IO.TextWriter]::Synchronized($capture)
    try {
        # Console.WriteLine is process-global (the updater emits its real version).
        # Capture it while the renderer uses its saved writer.
        [Console]::SetOut($writer); [Console]::SetError($writer)
        [void]$worker.AddScript({
            param($Root, $Operation, $TargetChannel, $Cache, $Replacement)
            $ErrorActionPreference = 'Stop'
            Set-StrictMode -Version 2
            $loaded = $false
            try {
                if ($Operation -eq 'Detect') {
                    $global:LASTEXITCODE = 0
                    $raw = & (Join-Path $Root 'SupportTemplates.ps1') -Action Detect
                    if ($global:LASTEXITCODE -ne 0) { throw 'Client detection failed' }
                    $value = ConvertFrom-Json -InputObject ($raw -join "`n")
                    $clients = @($value)
                    $seen = @{}
                    foreach ($client in $clients) {
                        if ($null -eq $client -or $client.Channel -cnotin @('Stable','Canary','PTB') -or $seen.ContainsKey($client.Channel)) { throw 'Invalid detected client' }
                        $seen[$client.Channel] = $true
                    }
                    return [pscustomobject]@{ Success = $true; Value = $clients; Lines = @() }
                }
                . (Join-Path $Root 'PackageUpdate.ps1') -Console -CloseDiscord
                $loaded = $true
                $raw = @(Invoke-PackageUpdate $Operation $TargetChannel $Cache $Replacement)
                $value = $null; $lines = @()
                if ($Operation -eq 'Update') {
                    $value = ConvertFrom-Json -InputObject ($raw -join "`n")
                    $lines = @(Write-PackageConsoleResult $value)
                } elseif ($Operation -eq 'Inspect') {
                    $value = ConvertFrom-Json -InputObject ($raw -join "`n")
                    if ($value -isnot [pscustomobject] -or $value.channel -cne $TargetChannel -or $value.kind -cnotin @('none','supporttemplates','vencord','betterdiscord','unsupported') -or $value.canReplace -isnot [bool]) { throw 'Invalid native inspection result' }
                } else { $lines = $raw }
                [pscustomobject]@{ Success = $true; Value = $value; Lines = $lines }
            } catch {
                $message = 'Не удалось найти Discord. Установка не начата.'
                if ($Operation -ne 'Detect') {
                    $message = 'Не удалось подготовить пакет. Распакуйте архив целиком.'
                    if ($loaded) { $message = Get-PackageConsoleError $_.Exception }
                }
                [pscustomobject]@{ Success = $false; Value = $null; Lines = @($message) }
            }
        }.ToString()).AddArgument($PSScriptRoot).AddArgument($Operation).AddArgument($Channel).AddArgument($Cache).AddArgument($Replacement)
        $pending = $worker.BeginInvoke()
        while (-not $pending.AsyncWaitHandle.WaitOne(65)) {
            Update-ConsoleScreen
            # Only menus read input. Preserve type-ahead while real work is pending.
        }
        $results = @($worker.EndInvoke($pending))
        # HadErrors also includes errors caught and translated by the backend.
        # EndInvoke throws for an unhandled error; otherwise require its one envelope.
        if ($results.Count -ne 1 -or $results[0].Success -isnot [bool]) { throw 'Console operation failed' }
        $result = $results[0]
        if ($Operation -eq 'Update' -and $capture.ToString().Trim()) {
            $result.Lines = @($capture.ToString().Trim()) + @($result.Lines)
        }
        return $result
    } finally {
        # Never cancel a transaction just to finish painting. Await backend cleanup.
        try {
            if ($null -ne $pending) {
                if (-not $pending.IsCompleted) { [void]$worker.EndInvoke($pending) }
                $pending.AsyncWaitHandle.Close()
            }
        } finally {
            try { $worker.Dispose() } finally {
                [Console]::SetOut($stdout); [Console]::SetError($stderr)
                $writer.Dispose()
            }
        }
    }
}

function Get-ConsolePackageVersion {
    # Display metadata only. The updater still validates the complete package before use.
    try {
        $path = Join-Path $PSScriptRoot 'manifest.json'
        if ((Get-Item -LiteralPath $path).Length -gt 65536) { return '' }
        $manifest = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($manifest.version -cmatch '^\d+\.\d+\.\d+$') { return [string]$manifest.version }
    } catch { }
    return ''
}

function Start-ConsoleInstall {
    . (Join-Path $PSScriptRoot 'ConsoleView.ps1')
    Initialize-ConsoleView
    try {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA unavailable' }
        $cache = Join-Path $env:LOCALAPPDATA 'SupportTemplates/installer-updates'
        $version = Get-ConsolePackageVersion
        $detail = 'Подготовка пакета.'
        if ($version) { $detail = 'Версия установщика: ' + $version }
        $startup = Invoke-ConsoleOperation 'Update' '' $cache 'Проверяем обновления' $detail
        if ($startup.Success) { $version = [string]$startup.Value.selectedVersion }
        $title = 'SupportTemplates'
        if ($version) { $title += ' / ' + $version }
        $startupAlign = 'Center'
        if (-not $startup.Success) { $startupAlign = 'Left' }
        $startupLines = @($startup.Lines | ForEach-Object { New-ConsoleLine $_ 'Muted' $startupAlign })
        while ($true) {
            Show-ConsoleScreen $title $startupLines '[Enter] Выбрать Discord    [0 / Esc] Выход'
            if ((Read-MenuKey '10') -eq 2) { return 0 }
            $detected = Invoke-ConsoleOperation 'Detect' '' $cache 'Ищем Discord' ''
            if (-not $detected.Success) {
                Show-ConsoleResult 'Не удалось продолжить' @($detected.Lines | ForEach-Object { New-ConsoleLine $_ })
                return 1
            }
            $clients = @($detected.Value)
            $labels = @{ Stable = 'Discord'; Canary = 'Discord Canary'; PTB = 'Discord PTB' }
            $lines = @(); $allowed = ''
            if ($clients.Count -eq 0) { $lines += New-ConsoleLine 'Discord не найден. Сначала установите Discord, Canary или PTB.' 'Muted' }
            else { $lines += New-ConsoleLine 'Выбранный Discord будет закрыт перед установкой.' 'Muted'; $lines += New-ConsoleLine }
            for ($i = 0; $i -lt $clients.Count; $i++) {
                $number = [string]($i + 1); $allowed += $number
                $lines += New-ConsoleLine ("[{0}] {1}" -f $number, $labels[$clients[$i].Channel]) 'Text' 'Left' $number
            }
            $footer = '[0 / Esc] Назад'
            if ($allowed) { $footer = '[↑ / ↓ / 1-' + $clients.Count + '] Выбрать    [Enter] Установить    [0 / Esc] Назад' }
            Show-ConsoleScreen 'Куда установить SupportTemplates?' $lines $footer
            $selected = Read-MenuKey ($allowed + '0')
            if ($selected -gt $clients.Count) { continue }
            $channel = $clients[$selected - 1].Channel
            $label = $labels[$channel]
            $replacement = ''
            $checked = Invoke-ConsoleOperation 'Inspect' $channel $cache ('Проверяем ' + $label) ''
            if (-not $checked.Success) {
                $lines = @($checked.Lines | ForEach-Object { New-ConsoleLine $_ 'Muted' 'Left' })
                Show-ConsoleScreen 'Не удалось продолжить' $lines '[0 / Esc] Назад'
                [void](Read-MenuKey '0'); continue
            }
            $inspection = $checked.Value
            if ($inspection.kind -in @('vencord','betterdiscord') -and $inspection.canReplace) {
                $modName = @{vencord='Vencord';betterdiscord='BetterDiscord'}[$inspection.kind]
                $lines = @(
                    New-ConsoleLine ("В {0} обнаружен {1}." -f $label, $modName)
                    New-ConsoleLine 'Прежние плагины и темы не будут активны.' 'Muted'
                    New-ConsoleLine 'Их файлы и настройки сохранятся.' 'Muted'
                    New-ConsoleLine
                    New-ConsoleLine '[1] Заменить на SupportTemplates' 'Text' 'Left' '1'
                )
                Show-ConsoleScreen 'Замена установленного мода' $lines '[↑ / ↓ / 1] Выбрать    [Enter] Подтвердить    [0 / Esc] Назад'
                if ((Read-MenuKey '10') -eq 2) { continue }
                $replacement = $inspection.kind
            } elseif ($inspection.kind -notin @('none','supporttemplates') -or $inspection.canReplace) {
                $reason = ''
                if ($null -ne $inspection.PSObject.Properties['reason']) { $reason = [string]$inspection.reason }
                Show-ConsoleScreen 'Не удалось продолжить' @(
                    New-ConsoleLine 'Эту установку Discord нельзя безопасно заменить.'
                    New-ConsoleLine ('Причина: ' + (Get-InspectionReason $reason)) 'Muted'
                ) '[0 / Esc] Назад'
                [void](Read-MenuKey '0'); continue
            }
            $installed = Invoke-ConsoleOperation 'Install' $channel $cache ('Установка / ' + $label) '' $replacement
            $title = 'Установка завершена'; $exitCode = 0
            $align = 'Center'
            if (-not $installed.Success) { $title = 'Ошибка установки'; $exitCode = 1; $align = 'Left' }
            $lines = @(New-ConsoleLine $label 'Muted') + @($installed.Lines | ForEach-Object { New-ConsoleLine $_ 'Text' $align })
            Show-ConsoleResult $title $lines
            return $exitCode
        }
    } finally { Restore-ConsoleView }
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Action -ne 'Install') { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) }
        if ($Action -eq 'Install') { exit (Start-ConsoleInstall) }
        if ($Action -eq 'Key') { exit (Read-MenuKey $Keys) }
        exit (Show-DiscordClients)
    } catch {
        [Console]::Error.WriteLine('  Не удалось прочитать выбор или найти Discord.')
        exit 255
    }
}
