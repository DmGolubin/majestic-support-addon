# Deterministic rendering and real async runspace tests with fake operations only.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'standalone/installer'
. (Join-Path $source 'ConsoleView.ps1')
$passed = 0
function Assert($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Check([string]$Name, [scriptblock]$Body) { & $Body; $script:passed++; Write-Output "PASS $Name" }

Check 'full ST monogram is centered with the accent and real actions' {
    $frame = Get-ConsoleFrame 'Установка' @(New-ConsoleLine 'Готов к установке пакет версии 2.3.4.' 'Muted') '[1] Установить    [0] Выход'
    $logo = @($frame.Rows | Where-Object { $_.Text.Contains('.--------.') })
    Assert ($logo.Count -eq 1 -and $logo[0].Tone -eq 'Accent') 'ST monogram missing'
    Assert ($frame.Rows.Text -contains (' ' * 26 + '  .--------.  .--------------.')) 'Logo block is not centered'
    Assert (($frame.Rows.Text -join "`n").Contains('S U P P O R T   T E M P L A T E S')) 'Brand missing'
    Assert (-not $frame.TooSmall -and $frame.Pages -eq 1 -and $frame.Rows.Count -le 29) 'Normal frame overflow'
}
Check 'compact viewport retains branding, message and complete controls' {
    $frame = Get-ConsoleFrame 'Установка' @(New-ConsoleLine 'Пакет проверен.') '[1] Установить    [0] Выход' 40 24
    Assert (($frame.Rows.Text -join "`n").Contains('SSSSS  TTTTTTT')) 'Small ST missing'
    Assert (-not $frame.TooSmall -and @($frame.Rows | Where-Object { $_.Text.Length -gt 40 }).Count -eq 0) 'Compact width overflow'
    Assert (($frame.Rows.Text -join "`n").Contains('[0] Выход')) 'Controls clipped'
}
Check 'short viewport pages all diagnostics while keeping the actions visible' {
    $lines = @(1..18 | ForEach-Object { New-ConsoleLine ('diagnostic-' + $_) 'Muted' })
    $first = Get-ConsoleFrame 'Ошибка' $lines '[0] Назад' 30 8
    Assert ($first.Pages -gt 1 -and -not $first.TooSmall) 'Expected accessible pages'
    $seen = @()
    for ($page = 0; $page -lt $first.Pages; $page++) {
        $frame = Get-ConsoleFrame 'Ошибка' $lines '[0] Назад' 30 8 $false 0 $page
        Assert ($frame.Rows.Count -le 8 -and ($frame.Rows.Text -join '').Contains('[0] Назад')) 'Paged controls missing'
        $seen += @($frame.Rows.Text | ForEach-Object { $_.Trim() } | Where-Object { $_ -like 'diagnostic-*' })
    }
    Assert (($seen -join ',') -ceq ($lines.Text -join ',')) 'Lost or duplicated diagnostic text'
    $tiny = Get-ConsoleFrame 'Замена' $lines '[1] Заменить [0] Назад' 12 4
    Assert ($tiny.TooSmall -and ($tiny.Rows.Text -join '') -notmatch '\[1\]') 'Clipped confirmation must not be actionable'
}
Check 'text wrapping retains long paths and strips terminal control characters' {
    $path = 'C:\fixture\a-very-long-directory-name\installer-diagnostics.log'
    $parts = @(Split-ConsoleLine $path 20)
    Assert (($parts -join '') -ceq $path) 'Long diagnostic path was truncated'
    $parts = @(Split-ConsoleLine ("safe" + [char]27 + '[2J' + [char]7 + ' text') 40)
    Assert (($parts -join '') -ceq 'safe text') 'Terminal sequence survived sanitization'
}
Check 'incremental redraw updates only changed rows and clears old content on reflow' {
    $script:ConsoleView = @{ LastRows = @{}; Viewport = '' }
    $script:paint = New-Object 'System.Collections.Generic.List[object]'
    function Write-ConsoleRow([int]$X, [int]$Y, [string]$Text, [string]$Tone) { $script:paint.Add(@{X=$X;Y=$Y;Text=$Text;Tone=$Tone}) }
    $frame = Get-ConsoleFrame 'Проверяем обновления' @(New-ConsoleLine 'Ожидание backend.') '' 82 29 $true 0
    Write-ConsoleFrame $frame 0 0 100
    Assert ($script:paint.Count -eq 29) 'First paint must cover viewport'
    $script:paint.Clear()
    Write-ConsoleFrame $frame 0 0 100
    Assert ($script:paint.Count -eq 0) 'Identical frame repainted'
    $next = Get-ConsoleFrame 'Проверяем обновления' @(New-ConsoleLine 'Ожидание backend.') '' 82 29 $true 100
    Write-ConsoleFrame $next 0 0 100
    Assert ($script:paint.Count -eq 1) 'Spinner must repaint just one row'
    $script:paint.Clear()
    Write-ConsoleFrame $next 2 3 100
    Assert ($script:paint.Count -eq 29) 'Viewport move did not invalidate rows'
    $script:paint.Clear()
    $done = Get-ConsoleFrame 'Готово' @() '[0] Закрыть' 82 29
    Write-ConsoleFrame $done 2 3 100
    Assert (@($script:paint | Where-Object { $_.Text.Trim() -eq '' }).Count -gt 0) 'Old spinner/message rows were not erased'
    Assert (@($script:paint | Where-Object { $_.Text.Length -ne 100 }).Count -eq 0) 'Incomplete row clearing'
}
Check 'spinner has no percentage or invented completion, including at frame boundaries' {
    foreach ($tick in @(0,99,100,550,599,600,999999)) {
        $frame = Get-ConsoleFrame 'Установка' @(New-ConsoleLine 'Реальная операция.') '' 82 29 $true $tick
        Assert (($frame.Rows.Text -join '') -notmatch '%|\[\+\]|Готово') 'Fabricated progress'
    }
}

# All paths below point at a fresh fixture; the production backend is never loaded.
$root = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-console-view-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'ConsoleInput.ps1') -Destination $root
$utf8 = New-Object Text.UTF8Encoding($true)
[IO.File]::WriteAllText((Join-Path $root 'PackageUpdate.ps1'), @'
param([string]$Channel,[switch]$Console,[switch]$CloseDiscord)
function Invoke-PackageUpdate($Operation, $TargetChannel, $Cache, $Replacement) {
    # Simulate work, not elapsed-time UI progress. No network or installation.
    [Threading.Thread]::Sleep(280)
    if ($Operation -eq 'Update') {
        [Console]::WriteLine('Версия установщика: 7.8.9.')
        return '{"action":"Update","selectedVersion":"7.8.9"}'
    }
    if ($Operation -eq 'Inspect') { return (@{channel=$TargetChannel;kind='none';canReplace=$false} | ConvertTo-Json -Compress) }
    $failure = New-Object InvalidOperationException('internal raw diagnostic')
    $failure.Data['PackageConsoleMessage'] = 'Установка Discord изменилась после проверки. Замена отменена.'
    throw $failure
}
function Write-PackageConsoleResult($Status) { 'Готов к установке пакет версии ' + $Status.selectedVersion + '.' }
function Get-PackageConsoleError([Exception]$Failure) { [string]$Failure.Data['PackageConsoleMessage'] }
'@, $utf8)
. (Join-Path $root 'ConsoleInput.ps1')
$script:pulses = 0; $script:screens = @()
function Show-ConsoleScreen([string]$Title, [object[]]$Lines, [string]$Footer, [switch]$Busy) {
    $script:screens += @{Title=$Title;Busy=[bool]$Busy}
}
function Update-ConsoleScreen { $script:pulses++ }
Check 'runspace waits animate and return all ordinary output without leaking Console writes' {
    $saved = [Console]::Out
    $result = Invoke-ConsoleOperation 'Update' '' $root 'Проверяем' 'Реальная операция'
    Assert ($result.Success -and $result.Value.selectedVersion -ceq '7.8.9') 'Lost structured result'
    Assert ($result.Lines.Count -eq 2 -and $result.Lines[0] -ceq 'Версия установщика: 7.8.9.' -and $result.Lines[1] -ceq 'Готов к установке пакет версии 7.8.9.') 'Lost ordinary output'
    Assert ($script:pulses -ge 2 -and $script:screens.Count -eq 1 -and $script:screens[0].Busy) 'Operation blocked the paint loop'
    Assert ([object]::ReferenceEquals([Console]::Out, $saved)) 'Console writer not restored'
}
Check 'isolated updater parameter binding preserves selected channel' {
    $result = Invoke-ConsoleOperation 'Inspect' 'PTB' $root 'Проверяем' 'Реальная операция'
    Assert ($result.Success -and $result.Value.channel -ceq 'PTB') 'Dot-sourced updater changed selection'
}
Check 'handled backend exceptions retain their exact user message and restore writers' {
    $savedOut = [Console]::Out; $savedError = [Console]::Error
    $result = Invoke-ConsoleOperation 'Install' 'Canary' $root 'Установка' 'Реальная операция' 'vencord'
    Assert (-not $result.Success -and $result.Lines.Count -eq 1 -and $result.Lines[0] -ceq 'Установка Discord изменилась после проверки. Замена отменена.') 'Translated backend error was lost'
    Assert ([object]::ReferenceEquals([Console]::Out, $savedOut) -and [object]::ReferenceEquals([Console]::Error, $savedError)) 'Writer restoration after error failed'
}
Write-Output "$passed console rendering/runspace tests passed. TEMP fixture: $root"
