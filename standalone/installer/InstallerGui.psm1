# Windows PowerShell 5.1. All mutations belong to SupportTemplates.ps1.
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function ConvertTo-InstallerArgument([string]$Value) {
    if ($Value -match '["\x00\r\n]') { throw 'Invalid installer argument.' }
    # ProcessStartInfo uses a Windows argv string, not a command shell.
    '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

function Set-InstallerControls($Model) {
    $ready = $null -eq $Model.Job
    $Model.Controls.Clients.IsEnabled = $ready
    $Model.Controls.Refresh.IsEnabled = $ready
    foreach ($name in @('Install', 'Status', 'Repair', 'Uninstall')) {
        $Model.Controls[$name].IsEnabled = $ready -and $null -ne $Model.Controls.Clients.SelectedItem
    }
}

function Get-InstallerFailure([string]$Text) {
    if ($Text -match 'Target Discord is running|Cannot establish target process path') {
        return 'Полностью закройте выбранный Discord, включая трей, и повторите действие.'
    }
    if ($Text -match 'Foreign|ownership|original Discord|archive|ASAR') {
        return 'Найдены чужие или изменённые файлы Discord. Не удаляйте их вручную: сначала восстановите клиент средствами установленной модификации. Подробности ниже.'
    }
    if ($Text -match 'integrity|hash|manifest|Payload|package') {
        return 'Не удалось проверить пакет. Распакуйте ZIP целиком в новую папку и повторите. Подробности ниже.'
    }
    if ($Text -match 'Another SupportTemplates') { return 'Другой установщик уже работает с этим клиентом. Дождитесь его завершения.' }
    return 'Действие не выполнено. Проверьте подробности ниже, доступ к файлам и выбранный клиент, затем повторите.'
}

function Start-InstallerOperation($Model, [ValidateSet('Detect', 'Install', 'Repair', 'Uninstall', 'Status')][string]$Action) {
    if ($null -ne $Model.Job) { return $false }
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        (Join-Path $Model.PackageRoot 'SupportTemplates.ps1'), '-Action', $Action, '-Utf8Output')
    $channel = $null
    if ($Action -ne 'Detect') {
        $selected = $Model.Controls.Clients.SelectedItem
        if ($null -eq $selected -or $selected.Channel -notin @('Stable', 'Canary')) { return $false }
        $channel = $selected.Channel
        $arguments += @('-Channel', $channel)
    }
    if ($Model.TestRoot) { $arguments += @('-TestRoot', $Model.TestRoot, '-LocalAppDataRoot', (Join-Path $Model.TestRoot 'localappdata')) }
    if ($Action -eq 'Detect') {
        $Model.Controls.Clients.ItemsSource = @()
        $Model.Controls.Clients.SelectedIndex = -1
        $Model.Controls.ClientPath.Text = ''
    }
    $labels = @{
        Detect='Ищем установленные клиенты'; Install='Проверяем пакет и устанавливаем обновление'
        Repair='Проверяем и восстанавливаем установку'; Uninstall='Восстанавливаем исходные файлы Discord'; Status='Проверяем состояние установки'
    }
    $Model.Controls.Details.Clear()
    $Model.Controls.LogDetails.IsExpanded = $false
    $Model.Controls.Activity.Text = $labels[$Action] + '…'
    $Model.Controls.Activity.Foreground = '#F2F2F5'
    $Model.Controls.Elapsed.Text = 'Ожидаем результат установщика; длительность зависит от диска.'
    $Model.Controls.Progress.Visibility = 'Visible'
    $Model.Controls.Progress.IsIndeterminate = $true
    try {
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $info.Arguments = (($arguments | ForEach-Object { ConvertTo-InstallerArgument $_ }) -join ' ')
        $info.WorkingDirectory = $Model.PackageRoot
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
        $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $info
        if (-not $process.Start()) { throw 'Could not start installer.' }
        # Drain both pipes immediately. No PowerShell callbacks run on worker
        # threads, and neither large stderr nor stdout can deadlock the child.
        $Model.Job = [pscustomobject]@{
            Process=$process; Output=$process.StandardOutput.ReadToEndAsync(); Error=$process.StandardError.ReadToEndAsync()
            Action=$Action; Channel=$channel; Started=[DateTime]::UtcNow; Label=$labels[$Action]
        }
        $Model.LastResult = $null
        Set-InstallerControls $Model
        return $true
    } catch {
        $Model.Controls.Progress.IsIndeterminate = $false
        $Model.Controls.Progress.Visibility = 'Collapsed'
        $Model.Controls.Activity.Text = 'Не удалось запустить установщик. Проверьте, что ZIP полностью распакован и Windows PowerShell доступен.'
        $Model.Controls.Details.Text = [string]$_
        $Model.Controls.Activity.Foreground = '#FF9DB6'
        $Model.Controls.LogDetails.IsExpanded = $true
        Set-InstallerControls $Model
        return $false
    }
}

function Update-InstallerOperation($Model) {
    $job = $Model.Job
    if ($null -eq $job) { return }
    $seconds = [int]([DateTime]::UtcNow - $job.Started).TotalSeconds
    $Model.Controls.Elapsed.Text = "Прошло $seconds с. Не закрывайте окно до завершения."
    if (-not $job.Process.HasExited -or -not $job.Output.IsCompleted -or -not $job.Error.IsCompleted) { return }
    try {
        $output = $job.Output.GetAwaiter().GetResult()
        $errorText = $job.Error.GetAwaiter().GetResult()
        $code = $job.Process.ExitCode
        $text = ($output + [Environment]::NewLine + $errorText).Trim()
        $Model.LastResult = [pscustomobject]@{ Action=$job.Action; Channel=$job.Channel; ExitCode=$code; Text=$text }
        if ($code -ne 0) { throw (Get-InstallerFailure $text) }
        if ($job.Action -eq 'Detect') {
            $clients = $output | ConvertFrom-Json
            # PS 5.1's empty JSON array may enumerate as no pipeline output.
            $clients = @($clients | Where-Object { $null -ne $_ })
            foreach ($client in $clients) {
                if ($client.Channel -notin @('Stable','Canary') -or -not $client.Label -or -not $client.Path) { throw 'Некорректный список клиентов. Повторите поиск.' }
            }
            $Model.Controls.Clients.ItemsSource = $clients
            $Model.Controls.Clients.SelectedIndex = -1
            $Model.Controls.ClientPath.Text = ''
            $Model.Controls.Activity.Text = 'Выберите Discord, затем нужное действие.'
            if ($clients.Count -eq 0) { $Model.Controls.Activity.Text = 'Discord не найден. Установите обычный Discord или Canary, затем нажмите «Найти снова».' }
            $Model.Controls.Details.Text = ''
        } else {
            $messages = @{
                Install='Установка завершена. Теперь можно запустить выбранный Discord.'
                Repair='Восстановление завершено. Теперь можно запустить выбранный Discord.'
                Uninstall='Удаление завершено. Настройки сохранены; Discord можно запустить.'
                Status='Проверка завершена.'
            }
            $Model.Controls.Activity.Text = $messages[$job.Action]
            $Model.Controls.Activity.Foreground = '#8DD9AB'
            if ($job.Action -eq 'Status' -and $text -match 'Pending') {
                $Model.Controls.Activity.Text = 'Обнаружена незавершённая операция. Закройте Discord и выберите «Восстановить». Затем повторите проверку статуса.'
                $Model.Controls.Activity.Foreground = '#F0C879'
                $Model.Controls.LogDetails.IsExpanded = $true
            }
            elseif ($job.Action -eq 'Status' -and $text -match '^Not installed:') { $Model.Controls.Activity.Text = 'SupportTemplates Lite не установлен в выбранном Discord.' }
            elseif ($job.Action -eq 'Status' -and $text -match '^Installed:') { $Model.Controls.Activity.Text = 'SupportTemplates Lite установлен. Проверка файлов завершена.' }
            $Model.Controls.Details.Text = $text.Substring([Math]::Max(0, $text.Length - 48000))
        }
    } catch {
        $Model.Controls.Activity.Text = [string]$_.Exception.Message
        $Model.Controls.Activity.Foreground = '#FF9DB6'
        $Model.Controls.LogDetails.IsExpanded = $true
        if ($null -ne $Model.LastResult) { $Model.Controls.Details.Text = $Model.LastResult.Text.Substring([Math]::Max(0, $Model.LastResult.Text.Length - 48000)) }
        else { $Model.Controls.Details.Text = [string]$_ }
    } finally {
        $job.Process.Dispose()
        $Model.Job = $null
        $Model.Controls.Progress.IsIndeterminate = $false
        $Model.Controls.Progress.Visibility = 'Collapsed'
        $Model.Controls.Elapsed.Text = "Завершено за $seconds с."
        Set-InstallerControls $Model
    }
}

function New-InstallerGui([string]$PackageRoot, [string]$TestRoot = '') {
    Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
    $root = [IO.Path]::GetFullPath($PackageRoot)
    if ($TestRoot) {
        $fixture = [IO.Path]::GetFullPath($TestRoot).TrimEnd('\')
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Split-Path $fixture -Parent) -ine $temp -or (Split-Path $fixture -Leaf) -cnotmatch '^SupportTemplates-installer-tests-[a-f0-9]{32}$' -or
            $root -ine (Join-Path $fixture 'package') -or
            [IO.File]::ReadAllText((Join-Path $fixture '.support-templates-fixture')) -cne 'SupportTemplates installer TEMP fixture') {
            throw 'Invalid GUI TEMP fixture.'
        }
    }
    foreach ($name in @('SupportTemplates.ps1', 'RendererUpdate.ps1', 'manifest.json', 'InstallerGui.xaml')) {
        if (-not [IO.File]::Exists((Join-Path $root $name))) { throw 'Распакуйте ZIP целиком в обычную папку: не найден файл ' + $name }
    }
    $manifest = [IO.File]::ReadAllText((Join-Path $root 'manifest.json')) | ConvertFrom-Json
    if ($manifest.product -cne 'SupportTemplates' -or $manifest.schema -ne 1 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') {
        throw 'Не удалось прочитать версию пакета. Распакуйте полный ZIP заново.'
    }
    $reader = New-Object Xml.XmlNodeReader ([xml][IO.File]::ReadAllText((Join-Path $root 'InstallerGui.xaml')))
    try { $window = [Windows.Markup.XamlReader]::Load($reader) } finally { $reader.Close() }
    $controls = @{}
    foreach ($name in @('Clients','Refresh','Install','Repair','Uninstall','Status','Activity','Elapsed','Progress','Details','LogDetails','PackageVersion','ClientPath')) {
        $controls[$name] = $window.FindName($name)
    }
    $model = [pscustomobject]@{ PackageRoot=$root; TestRoot=$TestRoot; Window=$window; Controls=$controls; Job=$null; LastResult=$null; Timer=$null }
    $controls.PackageVersion.Text = 'Версия пакета: ' + $manifest.version
    $controls.Refresh.Add_Click({ Start-InstallerOperation $model Detect | Out-Null }.GetNewClosure())
    $controls.Clients.Add_SelectionChanged({
        $selected = $model.Controls.Clients.SelectedItem
        $model.Controls.ClientPath.Text = if ($null -eq $selected) { '' } else { $selected.Path }
        Set-InstallerControls $model
    }.GetNewClosure())
    foreach ($action in @('Install','Repair','Uninstall','Status')) {
        $chosen = $action
        $controls[$action].Add_Click({ Start-InstallerOperation $model $chosen | Out-Null }.GetNewClosure())
    }
    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(120)
    $timer.Add_Tick({ Update-InstallerOperation $model }.GetNewClosure())
    $model.Timer = $timer
    $window.Add_Closing({
        param($sender, $eventArgs)
        if ($null -ne $model.Job) {
            $eventArgs.Cancel = $true
            $model.Controls.Activity.Text = 'Дождитесь завершения операции. Прерывание может оставить установку незавершённой.'
        }
    }.GetNewClosure())
    $window.Add_Closed({ $model.Timer.Stop() }.GetNewClosure())
    $window.Add_Loaded({
        $fade = New-Object Windows.Media.Animation.DoubleAnimation(0, 1, [TimeSpan]::FromMilliseconds(220))
        $model.Window.BeginAnimation([Windows.UIElement]::OpacityProperty, $fade)
        $model.Timer.Start()
        Start-InstallerOperation $model Detect | Out-Null
    }.GetNewClosure())
    Set-InstallerControls $model
    return $model
}

Export-ModuleMember -Function New-InstallerGui, Start-InstallerOperation, Update-InstallerOperation, Set-InstallerControls
