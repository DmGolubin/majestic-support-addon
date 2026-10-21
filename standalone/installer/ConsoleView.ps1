# Presentation only. Native operations and their outcomes belong to the existing backend.
Set-StrictMode -Version 2
$script:ConsoleView = $null

# dots14 frames and timing from cli-spinners (Sindre Sorhus), as in the supplied preview.
<#
MIT License
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#>
$script:ConsoleSpinnerFrames = @('⠉⠉','⠈⠙','⠀⠹','⠀⢸','⠀⣰','⢀⣠','⣀⣀','⣄⡀','⣆⠀','⡇⠀','⠏⠀','⠋⠁')

function New-ConsoleLine([string]$Text = '', [string]$Tone = 'Text') {
    [pscustomobject]@{ Text = $Text; Tone = $Tone }
}

function Split-ConsoleLine([string]$Text, [int]$Width) {
    # Backend messages are text, never terminal commands. Preserve full diagnostics by wrapping.
    $clean = [regex]::Replace($Text, '\x1b\[[0-?]*[ -/]*[@-~]', '')
    $clean = [regex]::Replace($clean, '[\x00-\x08\x0b-\x1f\x7f]', '')
    foreach ($part in ($clean -split "`r?`n")) {
        $rest = $part.Trim()
        while ($rest.Length -gt $Width) {
            $cut = $rest.LastIndexOf(' ', $Width)
            if ($cut -lt 1) { $cut = $Width }
            $rest.Substring(0, $cut)
            $rest = $rest.Substring($cut).TrimStart()
        }
        $rest
    }
}

function Get-ConsoleFrame([string]$Title, [object[]]$Lines, [string]$Footer,
    [int]$Width = 82, [int]$Height = 29, [bool]$Busy = $false, [long]$Tick = 0, [int]$Page = 0) {
    $width = [Math]::Max(1, [Math]::Min(82, $Width))
    $height = [Math]::Max(1, $Height)
    $body = @()
    foreach ($line in $Lines) {
        foreach ($part in @(Split-ConsoleLine $line.Text $width)) { $body += New-ConsoleLine $part $line.Tone }
    }
    if ($Busy) {
        # Animate only while a real invocation is pending; never delay completion.
        $spinner = $script:ConsoleSpinnerFrames[[int]([Math]::Floor($Tick / 80.0) % $script:ConsoleSpinnerFrames.Count)]
        $body = @(New-ConsoleLine $spinner 'Accent'; New-ConsoleLine) + $body
    }
    $titleRows = @(Split-ConsoleLine $Title $width | ForEach-Object { New-ConsoleLine $_ 'Accent' })
    $footerRows = @(Split-ConsoleLine $Footer $width | ForEach-Object { New-ConsoleLine $_ 'Text' })
    if (-not $Footer) { $footerRows = @() }
    $brand = 'S U P P O R T   T E M P L A T E S'
    if ($width -lt $brand.Length) { $brand = 'SupportTemplates' }
    $header = @(New-ConsoleLine $brand 'White'; New-ConsoleLine) + $titleRows + @(New-ConsoleLine)
    $logo = @(
        '  .--------.  .--------------.',
        ' /  .------`  `----.    .----`',
        ' |  `------.       |    |',
        ' `------.  |       |    |',
        ' .------`  /       |    |',
        ' `--------`        `----`'
    )
    $smallLogo = @(' SSSSS  TTTTTTT', ' SS        TT', '  SSSS     TT', '     SS    TT', ' SSSSS     TT')
    $remaining = $height - $header.Count - $body.Count - $footerRows.Count - 1
    $mark = @()
    if ($width -ge 52 -and $remaining -ge 9) { $mark = $logo }
    elseif ($width -ge 24 -and $remaining -ge 7) { $mark = $smallLogo }
    if ($mark.Count) {
        $logoWidth = ($mark | Measure-Object -Property Length -Maximum).Maximum
        $gap = @(New-ConsoleLine)
        if ($mark.Count -eq $logo.Count) { $gap = @(New-ConsoleLine; New-ConsoleLine; New-ConsoleLine) }
        $header = @($mark | ForEach-Object { New-ConsoleLine ($_.PadRight($logoWidth)) 'Accent' }) + $gap + $header
    }
    # Spend height on the actual message before decoration. PgUp/PgDn expose any
    # remaining text while the action footer stays visible, including long diagnostics.
    if (($header.Count + $body.Count + $footerRows.Count + 1) -gt $height) { $header = $titleRows }
    $capacity = [Math]::Max(1, $height - $header.Count - $footerRows.Count - 1)
    $pages = 1
    if ($body.Count -gt $capacity) {
        $capacity = [Math]::Max(1, $capacity - 1)
        $pages = [int][Math]::Ceiling($body.Count / [double]$capacity)
    }
    $page = [Math]::Max(0, [Math]::Min($pages - 1, $Page))
    $rows = @($header)
    if ($body.Count) { $rows += @($body | Select-Object -Skip ($page * $capacity) -First $capacity) }
    if ($pages -gt 1) { $rows += New-ConsoleLine ("PgUp/PgDn  {0}/{1}" -f ($page + 1), $pages) 'Muted' }
    if ($footerRows.Count) { $rows += @(New-ConsoleLine) + $footerRows }
    # Extremely small terminals cannot fit even the controls. Never show a clipped
    # confirmation: input is gated until the viewport can display this minimum.
    $tooSmall = $width -lt 20 -or $rows.Count -gt $height
    if ($tooSmall) { $rows = @(New-ConsoleLine 'Увеличьте окно' 'Accent') }
    $centered = @($rows | ForEach-Object {
        $text = $_.Text
        if ($text.Length -gt $width) { $text = $text.Substring(0, $width) }
        New-ConsoleLine ((' ' * [Math]::Max(0, [int][Math]::Floor(($width - $text.Length) / 2))) + $text) $_.Tone
    })
    [pscustomobject]@{ Rows = $centered; Width = $width; Height = $height; Page = $page; Pages = $pages; TooSmall = $tooSmall }
}

function Initialize-ConsoleView {
    $script:ConsoleView = @{
        Interactive = (-not [Console]::IsOutputRedirected -and -not [Console]::IsInputRedirected)
        Writer = $null; Encoding = [Console]::OutputEncoding; Foreground = [Console]::ForegroundColor
        Background = [Console]::BackgroundColor; Title = $null; Cursor = $true
        Handle = [IntPtr]::Zero; Mode = [uint32]0; Vt = $false; LastRows = @{}; Viewport = ''
        Screen = $null; Page = 0; Pages = 1; TooSmall = $false; Clock = [Diagnostics.Stopwatch]::StartNew()
    }
    $view = $script:ConsoleView
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $view.Writer = [Console]::Out
    if (-not $view.Interactive) { return }
    try {
        $view.Title = [Console]::Title; $view.Cursor = [Console]::CursorVisible
        [Console]::Title = 'SupportTemplates - Установка'
        [Console]::CursorVisible = $false
        [Console]::BackgroundColor = [ConsoleColor]::Black
        if (-not ('SupportTemplatesConsoleMode' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SupportTemplatesConsoleMode {
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
        }
        $view.Handle = [SupportTemplatesConsoleMode]::GetStdHandle(-11)
        $mode = [uint32]0
        if ([SupportTemplatesConsoleMode]::GetConsoleMode($view.Handle, [ref]$mode)) {
            $view.Mode = $mode
            $view.Vt = [SupportTemplatesConsoleMode]::SetConsoleMode($view.Handle, ($mode -bor 4))
        }
    } catch { $view.Vt = $false }
}

function Write-ConsoleRow([int]$X, [int]$Y, [string]$Text, [string]$Tone) {
    $view = $script:ConsoleView
    [Console]::SetCursorPosition($X, $Y)
    if ($view.Vt) {
        $rgb = switch ($Tone) {
            'Accent' { '255;0;85' }; 'Muted' { '144;151;160' }; 'White' { '235;237;240' }
            default { '204;209;216' }
        }
        $view.Writer.Write(([string][char]27 + '[48;2;11;11;11m' + [string][char]27 + '[38;2;' + $rgb + 'm'))
    } else {
        [Console]::ForegroundColor = switch ($Tone) {
            'Accent' { [ConsoleColor]::Red }; 'Muted' { [ConsoleColor]::DarkGray }
            'White' { [ConsoleColor]::White }; default { [ConsoleColor]::Gray }
        }
    }
    $view.Writer.Write($Text)
}

function Write-ConsoleFrame($Frame, [int]$Left, [int]$Top, [int]$DrawWidth) {
    $view = $script:ConsoleView
    $viewport = "$Left/$Top/$DrawWidth/$($Frame.Height)"
    if ($view.Viewport -ne $viewport) { $view.LastRows = @{}; $view.Viewport = $viewport }
    $marginX = [Math]::Max(0, [int][Math]::Floor(($DrawWidth - $Frame.Width) / 2))
    $marginY = [Math]::Max(0, [int][Math]::Floor(($Frame.Height - $Frame.Rows.Count) / 2))
    for ($i = 0; $i -lt $Frame.Height; $i++) {
        $text = ''; $tone = 'Text'; $row = $i - $marginY
        if ($row -ge 0 -and $row -lt $Frame.Rows.Count) { $text = (' ' * $marginX) + $Frame.Rows[$row].Text; $tone = $Frame.Rows[$row].Tone }
        $signature = $tone + ':' + $text
        if ($view.LastRows[$i] -eq $signature) { continue }
        Write-ConsoleRow $Left ($Top + $i) ($text.PadRight($DrawWidth)) $tone
        $view.LastRows[$i] = $signature
    }
}

function Update-ConsoleScreen {
    $view = $script:ConsoleView
    if ($null -eq $view -or -not $view.Interactive -or $null -eq $view.Screen) { return }
    try {
        $screen = $view.Screen
        $width = [Math]::Max(1, [Console]::WindowWidth - 1)
        $height = [Math]::Max(1, [Console]::WindowHeight - 1)
        $frame = Get-ConsoleFrame $screen.Title $screen.Lines $screen.Footer $width $height $screen.Busy $view.Clock.ElapsedMilliseconds $view.Page
        $view.Page = $frame.Page; $view.Pages = $frame.Pages; $view.TooSmall = $frame.TooSmall
        Write-ConsoleFrame $frame ([Console]::WindowLeft) ([Console]::WindowTop) $width
    } catch {
        # Resize races invalidate coordinates for one frame; repaint on the next poll.
        $view.LastRows = @{}
        $view.TooSmall = $true
    }
}

function Show-ConsoleScreen([string]$Title, [object[]]$Lines = @(), [string]$Footer = '', [switch]$Busy) {
    $view = $script:ConsoleView
    $view.Screen = @{ Title = $Title; Lines = $Lines; Footer = $Footer; Busy = [bool]$Busy }
    $view.Page = 0
    if ($view.Interactive) { Update-ConsoleScreen; return }
    # Redirected output is an ordinary transcript: no cursor codes, animation or repeated frames.
    if ($Title.StartsWith('SupportTemplates / ')) { $view.Writer.WriteLine($Title) }
    else { $view.Writer.WriteLine('SupportTemplates / ' + $Title) }
    foreach ($line in $Lines) { foreach ($part in @(Split-ConsoleLine $line.Text 100)) { $view.Writer.WriteLine($part) } }
    if ($Footer) { $view.Writer.WriteLine($Footer) }
}

function Restore-ConsoleView {
    $view = $script:ConsoleView
    if ($null -eq $view) { return }
    try {
        if ($view.Interactive) {
            if ($view.Vt) {
                $view.Writer.Write(([string][char]27 + '[0m'))
                $null = [SupportTemplatesConsoleMode]::SetConsoleMode($view.Handle, $view.Mode)
            }
            [Console]::ForegroundColor = $view.Foreground
            [Console]::BackgroundColor = $view.Background
            [Console]::CursorVisible = $view.Cursor
            if ($null -ne $view.Title) { [Console]::Title = $view.Title }
            [Console]::SetCursorPosition([Console]::WindowLeft, [Math]::Min([Console]::BufferHeight - 1, [Console]::WindowTop + [Console]::WindowHeight - 1))
        }
    } catch { } finally {
        [Console]::OutputEncoding = $view.Encoding
        $script:ConsoleView = $null
    }
}
