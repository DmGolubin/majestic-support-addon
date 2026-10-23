# Trusted, installed helper. No network, elevation, process termination, or scheduled tasks.
# PowerShell 5.1: wait for the originating host AND all processes of its channel.
[CmdletBinding()]
param([string]$RequestPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Assert-Update([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Safe-UpdatePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    Assert-Update ($cursor -match '^[A-Za-z]:\\' -and $cursor.Substring(2) -notmatch ':') 'Local update path required'
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            Assert-Update (((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Redirected update path'
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Under-Update([string]$Path, [string]$Root) {
    [IO.Path]::GetFullPath($Path).StartsWith([IO.Path]::GetFullPath($Root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Compare-UpdateVersion([string]$Left, [string]$Right) {
    $pattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$'
    $a = [regex]::Match($Left, $pattern); $b = [regex]::Match($Right, $pattern)
    Assert-Update ($a.Success -and $b.Success) 'Invalid installed version'
    for ($i = 1; $i -le 3; $i++) {
        $x = $a.Groups[$i].Value; $y = $b.Groups[$i].Value
        if ($x.Length -ne $y.Length) { return [Math]::Sign($x.Length - $y.Length) }
        $order = [string]::CompareOrdinal($x, $y)
        if ($order -ne 0) { return [Math]::Sign($order) }
    }
    $x = $a.Groups[4].Value; $y = $b.Groups[4].Value
    if (-not $x -or -not $y) {
        if ($x -ceq $y) { return 0 }
        if (-not $x) { return 1 }; return -1
    }
    $xs = $x.Split('.'); $ys = $y.Split('.')
    for ($i = 0; $i -lt [Math]::Max($xs.Count, $ys.Count); $i++) {
        if ($i -eq $xs.Count) { return -1 }; if ($i -eq $ys.Count) { return 1 }
        $x = $xs[$i]; $y = $ys[$i]
        if ($x -ceq $y) { continue }
        $xn = $x -match '^\d+$'; $yn = $y -match '^\d+$'
        if ($xn -and $yn -and $x.Length -ne $y.Length) { return [Math]::Sign($x.Length - $y.Length) }
        if ($xn -ne $yn) { if ($xn) { return -1 }; return 1 }
        return [Math]::Sign([string]::CompareOrdinal($x, $y))
    }
    return 0
}
function Update-Hash([string]$Path) {
    Safe-UpdatePath $Path
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-InstalledUpdateState([string]$LocalRoot, [string]$Channel) {
    $hostName = 'DiscordCanary'; if ($Channel -eq 'stable') { $hostName = 'Discord' }
    if ($Channel -eq 'ptb') { $hostName = 'DiscordPTB' }
    $hostRoot = Join-Path $LocalRoot $hostName
    Safe-UpdatePath $hostRoot
    $highest = $null
    foreach ($directory in Get-ChildItem -LiteralPath $hostRoot -Directory) {
        if ($directory.Name -notmatch '^app-\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { continue }
        $resources = Join-Path $directory.FullName 'resources'
        $file = Join-Path $resources 'support-templates.install.json'
        Safe-UpdatePath $file
        if (-not [IO.File]::Exists($file)) { continue }
        $state = [IO.File]::ReadAllText($file) | ConvertFrom-Json
        Assert-Update ($state.schema -eq 1 -and $state.product -ceq 'SupportTemplates' -and $state.channel -ceq $Channel -and $state.resources -ieq $resources) 'Invalid installed ownership record'
        Assert-Update ((Update-Hash (Join-Path $resources 'app.asar')) -ceq $state.loaderHash -and (Update-Hash (Join-Path $resources 'support-templates.json')) -ceq $state.configHash) 'Installed ownership hashes changed'
        $manifest = Join-Path $LocalRoot ('SupportTemplates/channels/' + $Channel + '/versions/' + $state.version + '/manifest.json')
        Compare-UpdateVersion $state.version $state.version | Out-Null
        Assert-Update ((Update-Hash $manifest) -ceq $state.manifestHash) 'Installed manifest changed'
        if ($null -eq $highest -or (Compare-UpdateVersion $state.version $highest.version) -gt 0) { $highest = $state }
    }
    return $highest
}
function Write-UpdateReceipt($Request, [string]$Cache) {
    # Publish the same durable owner record as the engine. An abrupt helper exit
    # must leave a provably dead owner that storage.cjs can recover, not a directory.
    $lock = Join-Path $Cache '.lock'
    Safe-UpdatePath $lock
    if (Test-Path -LiteralPath $lock) { return }
    $nonce = [guid]::NewGuid().ToString()
    $ownerPath = Join-Path $Cache ('.owner-' + $nonce + '.tmp')
    Safe-UpdatePath $ownerPath
    $ownerBytes = (New-Object Text.UTF8Encoding($false)).GetBytes((@{schema=1;pid=$PID;nonce=$nonce} | ConvertTo-Json -Compress))
    $ownerFile = New-Object IO.FileStream($ownerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $ownerFile.Write($ownerBytes, 0, $ownerBytes.Length); $ownerFile.Flush($true) } finally { $ownerFile.Dispose() }
    try {
        # File.Move is exclusive and atomic on this volume, including against
        # an engine simultaneously publishing its lock with fs.link().
        [IO.File]::Move($ownerPath, $lock)
    } catch {
        [IO.File]::Delete($ownerPath)
        if (Test-Path -LiteralPath $lock) { return }
        throw
    }
    try {
        $receipt = Join-Path $Cache 'applied.json'
        Safe-UpdatePath $receipt
        $temporary = Join-Path $Cache ('receipt-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $json = @{schema=1;repository=$Request.repository;variant='standalone';channel=$Request.releaseChannel;version=$Request.version} | ConvertTo-Json -Compress
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
        $file = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        if ([IO.File]::Exists($receipt)) { [IO.File]::Replace($temporary, $receipt, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $receipt) }
        $pendingPath = Join-Path $Cache 'pending.json'
        Safe-UpdatePath $pendingPath
        if ([IO.File]::Exists($pendingPath)) {
            $pending = [IO.File]::ReadAllText($pendingPath) | ConvertFrom-Json
            $matching = @($pending.manifest.assets | Where-Object { $_.variant -ceq 'standalone' -and $_.sha256 -ceq $Request.sha256 })
            if ($pending.variant -ceq 'standalone' -and $pending.manifest.version -ceq $Request.version -and $pending.manifest.repository -ceq $Request.repository -and $pending.manifest.channel -ceq $Request.releaseChannel -and $matching.Count -eq 1) {
                [IO.File]::Delete($pendingPath)
            }
        }
    } finally { [IO.File]::Delete($lock) }
}
function Expand-VerifiedUpdate($Request, [string]$Destination) {
    Safe-UpdatePath $Request.assetPath
    Safe-UpdatePath $Destination
    Assert-Update (-not (Test-Path -LiteralPath $Destination)) 'Extraction directory already exists'
    Assert-Update ($Request.sha256 -cmatch '^[a-f0-9]{64}$' -and $Request.size -gt 0 -and $Request.size -le 268435456) 'Invalid archive metadata'
    Add-Type -AssemblyName System.IO.Compression
    # Keep this read handle open with no writer/delete sharing across hash and extraction.
    $stream = [IO.File]::Open($Request.assetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $archive = $null
    try {
        Assert-Update ($stream.Length -eq $Request.size) 'Archive size mismatch'
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        Assert-Update ($hash -ceq $Request.sha256) 'Archive SHA256 mismatch'
        $stream.Position = 0
        $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
        $prefix = 'SupportTemplates-' + $Request.version
        $seen = @{}; [long]$total = 0
        Assert-Update ($archive.Entries.Count -gt 0 -and $archive.Entries.Count -le 20000) 'Invalid archive entry count'
        # Validate the complete archive before creating any output.
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            Assert-Update ($name.Length -le 240 -and $name -cnotmatch '[\\:]' -and $name.StartsWith($prefix + '/', [StringComparison]::Ordinal)) 'Unexpected archive path'
            $parts = $name.TrimEnd('/').Split('/')
            foreach ($part in $parts) {
                Assert-Update ($part.Length -gt 0 -and $part -notin @('.', '..') -and $part -notmatch '[<>"|?*\x00-\x1f]' -and $part -notmatch '[. ]$' -and $part -notmatch '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') 'Unsafe archive name'
            }
            $key = $name.TrimEnd('/')
            Assert-Update (-not $seen.ContainsKey($key)) 'Duplicate archive entry'
            $seen[$key] = $true
            $type = ($entry.ExternalAttributes -shr 16) -band 61440
            Assert-Update ($type -in @(0, 32768, 16384) -and ($entry.ExternalAttributes -band 1024) -eq 0) 'Archive link or special file refused'
            $total += $entry.Length
            Assert-Update ($total -le 1073741824) 'Expanded archive too large'
        }
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        foreach ($entry in $archive.Entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            Assert-Update (Under-Update $target $Destination) 'Archive escaped destination'
            Safe-UpdatePath $target
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            $inputStream = $entry.Open()
            try {
                $outputStream = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
                finally { $outputStream.Dispose() }
            } finally { $inputStream.Dispose() }
        }
        $package = Join-Path $Destination $prefix
        $nested = Join-Path $package 'SupportTemplates'
        if ([IO.Directory]::Exists($nested)) {
            Assert-Update (-not [IO.File]::Exists((Join-Path $package 'manifest.json'))) 'Ambiguous package layout'
            $package = $nested
        }
        $manifest = [IO.File]::ReadAllText((Join-Path $package 'manifest.json')) | ConvertFrom-Json
        Assert-Update ($manifest.schema -eq 1 -and $manifest.product -ceq 'SupportTemplates' -and $manifest.version -ceq $Request.version) 'Package manifest identity mismatch'
        foreach ($file in @('SupportTemplates.ps1', 'RendererUpdate.ps1')) {
            Assert-Update ([IO.File]::Exists((Join-Path $package $file))) 'Package installer missing'
        }
        return $package
    } finally {
        if ($null -ne $archive) { $archive.Dispose() }
        $stream.Dispose()
    }
}
function Invoke-StandaloneUpdate([string]$Path) {
    Safe-UpdatePath $Path
    Assert-Update ((Get-Item -LiteralPath $Path).Length -le 16384) 'Handoff too large'
    $request = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    Assert-Update ($request.schema -eq 1 -and $request.variant -ceq 'standalone' -and $request.channel -cin @('canary', 'stable', 'ptb')) 'Invalid handoff'
    Assert-Update ($request.parentPid -gt 0 -and $request.version -cmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') 'Invalid host/version'
    $root = Join-Path $env:LOCALAPPDATA ('SupportTemplates/channels/' + $request.channel)
    $cache = Join-Path $root 'auto-updates'
    Assert-Update ((Under-Update $Path (Join-Path $cache 'handoff')) -and (Under-Update $request.assetPath $cache)) 'Handoff outside owned channel'
    Safe-UpdatePath $cache
    $mutex = New-Object Threading.Mutex($false, ('Local\SupportTemplatesAutoUpdate-' + $request.channel))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { return }
        $hostName = 'DiscordCanary'; if ($request.channel -eq 'stable') { $hostName = 'Discord' }
        if ($request.channel -eq 'ptb') { $hostName = 'DiscordPTB' }
        $parent = Get-Process -Id $request.parentPid -ErrorAction SilentlyContinue
        if ($null -ne $parent) { $parent.WaitForExit(); $parent.Dispose() }
        while (@(Get-Process -Name $hostName -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Seconds 2 }
        # A fresh directory is never reused after failure. The installer independently
        # rechecks all channel processes, ownership, payload hashes and transaction state.
        $destination = Join-Path $cache ('apply-' + [guid]::NewGuid().ToString('N'))
        $package = Expand-VerifiedUpdate $request $destination
        $installer = Join-Path $package 'SupportTemplates.ps1'
        # The existing installer mutex is reentrant on this PowerShell thread.
        # Hold it through the version check and synchronous script invocation so
        # a manual install cannot slip a newer version between check and apply.
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $mutexId = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $installMutex = New-Object Threading.Mutex($false, ('Local\SupportTemplates-' + $mutexId))
        $installLocked = $false
        try {
            try { $installLocked = $installMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $installLocked = $true }
            Assert-Update $installLocked 'Another installer is active; retry next launch'
            $installed = Get-InstalledUpdateState $env:LOCALAPPDATA $request.channel
            Assert-Update ($null -ne $installed) 'Installation was removed; automatic reinstall refused'
            if ((Compare-UpdateVersion $installed.version $request.version) -ge 0) { return }
            & $installer -Action Install -Channel $request.channel *> (Join-Path $destination 'installer.log')
            Assert-Update $? 'Installer deferred or failed; staged package retained for retry at next launch'
            $installed = Get-InstalledUpdateState $env:LOCALAPPDATA $request.channel
            Assert-Update ($null -ne $installed -and $installed.version -ceq $request.version -and $installed.manifestHash -ceq (Update-Hash (Join-Path $package 'manifest.json'))) 'Installation success could not be verified'
            Write-UpdateReceipt $request $cache
        } finally {
            if ($installLocked) { $installMutex.ReleaseMutex() }
            $installMutex.Dispose()
        }
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-StandaloneUpdate $RequestPath }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
}
