# Persistent console menu; native operations run in an isolated validated process.
[CmdletBinding()]
param(
    [ValidateSet('Key', 'Clients', 'Install')][string]$Action = 'Key',
    [ValidatePattern('^[0-9]{1,10}$')][string]$Keys = '10'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$script:ConsoleView = $null

function Read-MenuKey([string]$Allowed) {
    # ReadKey(intercept:true) consumes unwanted keys silently, unlike choice.exe.
    # Unbuffered byte reads preserve remaining redirected input for the next menu.
    if ([Console]::IsInputRedirected) {
        $inputStream = [Console]::OpenStandardInput()
        while ($true) {
            $value = $inputStream.ReadByte()
            if ($value -lt 0) { throw 'Input closed' }
            if ($value -eq 27) {
                # Ignore an ANSI escape sequence rather than accepting its digits.
                $next = $inputStream.ReadByte()
                if ($next -in @(91, 79)) {
                    do { $next = $inputStream.ReadByte() } while ($next -ge 0 -and ($next -lt 64 -or $next -gt 126))
                }
                continue
            }
            $index = $Allowed.IndexOf([char]$value)
            if ($index -ge 0) { return $index + 1 }
        }
    }
    while ($true) {
        if ($null -ne $script:ConsoleView -and $script:ConsoleView.Interactive) {
            Update-ConsoleScreen
            if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 65; continue }
        }
        $key = [Console]::ReadKey($true)
        if (($key.Modifiers -band ([ConsoleModifiers]::Alt -bor [ConsoleModifiers]::Control)) -ne 0) { continue }
        if ($null -ne $script:ConsoleView -and $script:ConsoleView.Interactive) {
            if ($key.Key -eq [ConsoleKey]::PageUp) { $script:ConsoleView.Page = [Math]::Max(0, $script:ConsoleView.Page - 1); continue }
            if ($key.Key -eq [ConsoleKey]::PageDown) { $script:ConsoleView.Page = [Math]::Min($script:ConsoleView.Pages - 1, $script:ConsoleView.Page + 1); continue }
            if ($script:ConsoleView.TooSmall) { continue }
        }
        $index = $Allowed.IndexOf($key.KeyChar)
        if ($index -ge 0) { return $index + 1 }
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
        Write-Host '  [0] Назад'
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
    Write-Host '  [0] Назад'
    Write-Host ''
    $selected = Read-MenuKey ($allowed + '0')
    if ($selected -gt $clients.Count) { return 0 }
    return [int]$codes[$clients[$selected - 1].Channel]
}

function Get-InspectionReason([string]$Reason) {
    # The native contract may return a technical reason on older packages.
    # Keep the menu Russian without guessing which mod owns unknown files.
    if ($Reason -match '[А-Яа-яЁё]' -and $Reason.Length -le 400 -and $Reason -notmatch '[\x00-\x1f\x7f]') { return $Reason }
    switch -Regex ($Reason) {
        'running|close the target' { return 'Сначала полностью закройте выбранный Discord, включая значок в трее.' }
        'not found|no supported' { return 'Выбранный клиент Discord не найден.' }
        'backup|ownership|state|journal|transaction' { return 'Состояние установки или резервной копии не позволяет безопасно заменить мод.' }
        default { return 'Не удалось подтвердить совместимость установленного мода для автоматической замены.' }
    }
}

function Show-ConsoleResult([string]$Title, [object[]]$Lines) {
    $footer = ''
    if ($env:SUPPORT_TEMPLATES_NO_PAUSE -ne '1') { $footer = '[0] Закрыть' }
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
        # Capture it while the renderer uses its saved writer. Backend functions
        # and the isolated native invocation remain unmodified.
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

function Start-ConsoleInstall {
    . (Join-Path $PSScriptRoot 'ConsoleView.ps1')
    Initialize-ConsoleView
    try {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA unavailable' }
        $cache = Join-Path $env:LOCALAPPDATA 'SupportTemplates/installer-updates'
        $startup = Invoke-ConsoleOperation 'Update' '' $cache 'Проверяем обновления' 'Проверка выпуска и подготовка проверенного пакета.'
        $startupLines = @($startup.Lines | ForEach-Object { New-ConsoleLine $_ 'Muted' })
        while ($true) {
            Show-ConsoleScreen 'Установка' $startupLines '[1] Установить    [0] Выход'
            if ((Read-MenuKey '10') -eq 2) { return 0 }
            $detected = Invoke-ConsoleOperation 'Detect' '' $cache 'Ищем Discord' 'Проверяем установленные клиенты.'
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
                $lines += New-ConsoleLine ("[{0}] {1}" -f $number, $labels[$clients[$i].Channel])
            }
            Show-ConsoleScreen 'Куда установить SupportTemplates?' $lines '[0] Назад'
            $selected = Read-MenuKey ($allowed + '0')
            if ($selected -gt $clients.Count) { continue }
            $channel = $clients[$selected - 1].Channel
            $label = $labels[$channel]
            $replacement = ''
            $checked = Invoke-ConsoleOperation 'Inspect' $channel $cache ('Проверяем ' + $label) 'Пакет, совместимость и текущая установка.'
            if (-not $checked.Success) {
                $lines = @(New-ConsoleLine 'Не удалось проверить выбранный Discord. Установка не начата.')
                $lines += @($checked.Lines | ForEach-Object { New-ConsoleLine $_ 'Muted' })
                Show-ConsoleScreen 'Не удалось продолжить' $lines '[0] Назад'
                [void](Read-MenuKey '0'); continue
            }
            $inspection = $checked.Value
            if ($inspection.kind -in @('vencord','betterdiscord') -and $inspection.canReplace) {
                $modName = @{vencord='Vencord';betterdiscord='BetterDiscord'}[$inspection.kind]
                $lines = @(
                    New-ConsoleLine ("В {0} обнаружен {1}." -f $label, $modName)
                    New-ConsoleLine 'Прежние плагины и темы не будут активны.' 'Muted'
                    New-ConsoleLine 'Их файлы и настройки сохранятся.' 'Muted'
                )
                Show-ConsoleScreen 'Замена установленного мода' $lines '[1] Заменить на SupportTemplates    [0] Назад'
                if ((Read-MenuKey '10') -eq 2) { continue }
                $replacement = $inspection.kind
            } elseif ($inspection.kind -notin @('none','supporttemplates') -or $inspection.canReplace) {
                $reason = ''
                if ($null -ne $inspection.PSObject.Properties['reason']) { $reason = [string]$inspection.reason }
                Show-ConsoleScreen 'Не удалось продолжить' @(
                    New-ConsoleLine 'Эту установку Discord нельзя безопасно заменить.'
                    New-ConsoleLine ('Причина: ' + (Get-InspectionReason $reason)) 'Muted'
                ) '[0] Назад'
                [void](Read-MenuKey '0'); continue
            }
            $installed = Invoke-ConsoleOperation 'Install' $channel $cache ('Установка / ' + $label) 'Устанавливаем и проверяем SupportTemplates.' $replacement
            $title = 'Установка завершена'; $exitCode = 0
            if (-not $installed.Success) { $title = 'Не удалось завершить установку'; $exitCode = 1 }
            $lines = @(New-ConsoleLine $label 'Muted') + @($installed.Lines | ForEach-Object { New-ConsoleLine $_ })
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
