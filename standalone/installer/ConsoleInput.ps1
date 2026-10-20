# Persistent console menu; native operations run in an isolated validated process.
[CmdletBinding()]
param(
    [ValidateSet('Key', 'Clients', 'Install')][string]$Action = 'Key',
    [ValidatePattern('^[0-9]{1,10}$')][string]$Keys = '10'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

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
        $key = [Console]::ReadKey($true)
        if (($key.Modifiers -band ([ConsoleModifiers]::Alt -bor [ConsoleModifiers]::Control)) -ne 0) { continue }
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

function Write-InstallFrame {
    if (-not [Console]::IsOutputRedirected) {
        try { [Console]::Clear() } catch { }
    }
    Write-Host '  +------------------------------------------------------+'
    Write-Host '  |                  SUPPORT TEMPLATES                   |'
    Write-Host '  +------------------------------------------------------+'
    Write-Host ''
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

function Start-ConsoleInstall {
    # One PowerShell session for checking, keys and client selection. Only the
    # actual native installer uses a child process, preserving its isolated scope.
    . (Join-Path $PSScriptRoot 'PackageUpdate.ps1') -Console -CloseDiscord
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA unavailable' }
    $cache = Join-Path $env:LOCALAPPDATA 'SupportTemplates/installer-updates'
    Write-Host '  Проверяем обновления...'
    try {
        $status = Invoke-PackageUpdate 'Update' '' $cache | ConvertFrom-Json
        Write-PackageConsoleResult $status | ForEach-Object { Write-Host $_ }
    } catch {
        Write-Host (Get-PackageConsoleError $_.Exception)
    }
    Write-Host ''
    while ($true) {
        Write-Host '  [1] Установить'
        Write-Host '  [0] Выход'
        Write-Host ''
        if ((Read-MenuKey '10') -eq 2) { return 0 }
        Write-InstallFrame
        Write-Host '  Куда установить SupportTemplates?'
        Write-Host '  Выбранный Discord будет закрыт перед установкой.'
        Write-Host ''
        $selected = Show-DiscordClients
        if ($selected -eq 0) { Write-InstallFrame; continue }
        $channel = @{ 1 = 'Stable'; 2 = 'Canary'; 3 = 'PTB' }[$selected]
        if (-not $channel) { throw 'Invalid selected client' }
        $label = @{ Stable = 'Discord'; Canary = 'Discord Canary'; PTB = 'Discord PTB' }[$channel]
        Write-InstallFrame
        $replacement = ''
        try {
            $inspection = Invoke-PackageUpdate 'Inspect' $channel $cache | ConvertFrom-Json
            if ($inspection -isnot [pscustomobject] -or $inspection.channel -cne $channel -or $inspection.kind -cnotin @('none','supporttemplates','vencord','betterdiscord','unsupported') -or $inspection.canReplace -isnot [bool]) { throw 'Invalid native inspection result' }
        } catch {
            Write-Host '  Не удалось проверить выбранный Discord. Установка не начата.'
            Write-Host (Get-PackageConsoleError $_.Exception)
            Write-Host '  [0] Назад'
            [void](Read-MenuKey '0')
            Write-InstallFrame
            continue
        }
        if ($inspection.kind -in @('vencord','betterdiscord') -and $inspection.canReplace) {
            $modName = @{vencord='Vencord';betterdiscord='BetterDiscord'}[$inspection.kind]
            Write-Host ("  В {0} обнаружен {1}." -f $label, $modName)
            Write-Host '  Прежние плагины и темы не будут активны. Их файлы и настройки сохранятся.'
            Write-Host ''
            Write-Host '  [1] Заменить на SupportTemplates'
            Write-Host '  [0] Назад'
            if ((Read-MenuKey '10') -eq 2) { Write-InstallFrame; continue }
            $replacement = $inspection.kind
        } elseif ($inspection.kind -notin @('none','supporttemplates') -or $inspection.canReplace) {
            Write-Host '  Эту установку Discord нельзя безопасно заменить.'
            $reason = ''
            if ($null -ne $inspection.PSObject.Properties['reason']) { $reason = [string]$inspection.reason }
            Write-Host ('  Причина: ' + (Get-InspectionReason $reason))
            Write-Host '  [0] Назад'
            [void](Read-MenuKey '0')
            Write-InstallFrame
            continue
        }
        Write-InstallFrame
        Write-Host ("  Установка в {0}..." -f $label)
        Write-Host ''
        $result = 0
        try {
            Invoke-PackageUpdate 'Install' $channel $cache $replacement | ForEach-Object { Write-Host $_ }
        } catch {
            Write-Host (Get-PackageConsoleError $_.Exception)
            $result = 1
        }
        Write-Host ''
        if ($env:SUPPORT_TEMPLATES_NO_PAUSE -ne '1') {
            Write-Host '  [0] Закрыть'
            [void](Read-MenuKey '0')
        }
        return $result
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Action -eq 'Install') { exit (Start-ConsoleInstall) }
        if ($Action -eq 'Key') { exit (Read-MenuKey $Keys) }
        exit (Show-DiscordClients)
    } catch {
        [Console]::Error.WriteLine('  Не удалось прочитать выбор или найти Discord.')
        exit 255
    }
}
