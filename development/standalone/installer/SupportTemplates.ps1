# Windows PowerShell 5.1. Service directory contains manifest.json, payload/ and native scripts.
# Local hashes detect corruption, not authenticity. No downloads or elevation.
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Repair', 'Uninstall', 'Rollback', 'Status', 'UpdateRenderer', 'Detect', 'Inspect')][string]$Action,
    [ValidateSet('Canary', 'Stable', 'PTB')][string]$Channel,
    # Close only the validated selected host, after mutation preflight.
    [switch]$CloseDiscord,
    [ValidateSet('vencord','betterdiscord')][string]$ReplaceExisting,
    # Optional redirected console encoding; does not affect operation or ownership.
    [switch]$Utf8Output,
    # Fixture-only overrides: require a marked, specifically named directory under TEMP.
    [string]$TestRoot,
    [string]$LocalAppDataRoot,
    [switch]$TestRunningTarget,
    [switch]$TestRunningOtherChannel,
    [ValidateRange(0, 4)][int]$TestFailAfterStep = 0,
    [ValidateRange(0, 4)][int]$TestCrashAfterStep = 0,
    [ValidateRange(0, 9)][int]$TestFailMigrationAfterStep = 0,
    [ValidateRange(0, 9)][int]$TestCrashMigrationAfterStep = 0
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$script:Utf8 = New-Object Text.UTF8Encoding($false, $true)
if ($Utf8Output) { [Console]::OutputEncoding = $script:Utf8; $OutputEncoding = $script:Utf8 }
$script:Fixture = $false
$script:FixtureTargetClosed = $false
$script:SimulatedCrash = $false
$script:Mutex = $null
$script:Locked = $false
$script:ChannelName = $null
$script:PackageRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$script:ResourceNames = @('_app.asar', 'support-templates.json', 'app.asar', 'support-templates.install.json')
. (Join-Path $PSScriptRoot 'RendererUpdate.ps1')
. (Join-Path $PSScriptRoot 'Migration.ps1')

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Full([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Under([string]$Path, [string]$Root) {
    (Full $Path).StartsWith((Full $Root) + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Exists([string]$Path) { Test-Path -LiteralPath $Path }
function Safe-Path([string]$Path) {
    # Check every existing ancestor, including the drive-to-root chain; never follow junctions.
    $cursor = [IO.Path]::GetFullPath($Path)
    Require ($cursor -match '^[A-Za-z]:\\' -and $cursor.Substring(2) -notmatch ':') "Only local drive paths are supported: $Path"
    while ($cursor) {
        $attributes = 0
        try { $attributes = [IO.File]::GetAttributes($cursor) }
        catch [IO.FileNotFoundException] { }
        catch [IO.DirectoryNotFoundException] { }
        Require (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse path refused: $cursor"
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Safe-File([string]$Path) {
    Safe-Path $Path
    Require ([IO.File]::Exists($Path)) "Missing regular file: $Path"
}
function Safe-Directory([string]$Path) {
    Safe-Path $Path
    Require ([IO.Directory]::Exists($Path)) "Missing directory: $Path"
}
function Get-PhysicalFilePath([string]$Path) {
    if (-not ('SupportTemplatesRuntimePath' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SupportTemplatesRuntimePath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
}
'@
    }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $buffer = New-Object Text.StringBuilder(32768)
        $length = [SupportTemplatesRuntimePath]::GetFinalPathNameByHandle($stream.SafeFileHandle, $buffer, $buffer.Capacity, 0)
        Require ($length -gt 0 -and $length -lt $buffer.Capacity) 'Cannot resolve physical runtime file'
        $actual = $buffer.ToString()
        if ($actual.StartsWith('\\?\UNC\')) { return '\\' + $actual.Substring(8) }
        if ($actual.StartsWith('\\?\')) { return $actual.Substring(4) }
        return $actual
    } finally { $stream.Dispose() }
}
function Assert-SharedRuntimeFile([string]$Path) {
    # Packaged parent apps can virtualize new files without a reparse point.
    $actual = Get-PhysicalFilePath $Path
    Require ((Full $actual) -ieq (Full $Path)) "Runtime storage is redirected. Run install.bat from File Explorer.`nExpected: $Path`nActual: $actual"
}
function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Hash-File([string]$Path) {
    Safe-File $Path
    # Get-FileHash's PS5 implementation inherits WhatIf in internal provider operations.
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Current-Hash([string]$Path) {
    Safe-Path $Path
    if (Exists $Path) { return Hash-File $Path }
    return $null
}
function Json-Bytes($Value) { ,$script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 40 -Compress)) }
function Read-Json([string]$Path) {
    Safe-File $Path
    Require ((Get-Item -LiteralPath $Path).Length -le 8388608) "JSON file too large: $Path"
    $script:Utf8.GetString([IO.File]::ReadAllBytes($Path)) | ConvertFrom-Json
}
function Write-New([string]$Path, [byte[]]$Bytes) {
    Safe-Path $Path
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Valid-Version([string]$Version) {
    Require ($Version.Length -le 120 -and $Version -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$') 'Invalid package version'
}
function Compare-PackageVersion([string]$Left, [string]$Right) {
    $pattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$'
    $a = [regex]::Match($Left, $pattern); $b = [regex]::Match($Right, $pattern)
    Require ($a.Success -and $b.Success) 'Invalid installed version'
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
function Valid-Relative([string]$Path) {
    Require ($Path.Length -le 220 -and $Path -cmatch '^payload/(loader\.asar|runtime/[A-Za-z0-9_@+.-]+(/[A-Za-z0-9_@+.-]+)*)$') "Invalid payload path: $Path"
    foreach ($part in $Path.Split('/')) {
        Require ($part -notin @('.', '..') -and -not $part.EndsWith('.') -and $part -notmatch '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') "Unsafe payload path: $Path"
    }
}
function Tree-Files([string]$Root) {
    Safe-Directory $Root
    foreach ($item in Get-ChildItem -LiteralPath $Root -Force) {
        Safe-Path $item.FullName
        if ($item.PSIsContainer) { Tree-Files $item.FullName }
        else { $item.FullName }
    }
}
function Read-Package([string]$Base, [switch]$Stored) {
    Safe-Directory $Base
    if ($Stored) {
        Safe-File (Join-Path $Base 'manifest.json')
        Assert-SharedRuntimeFile (Join-Path $Base 'manifest.json')
    }
    $manifest = Read-Json (Join-Path $Base 'manifest.json')
    Require (($manifest.schema -is [int] -or $manifest.schema -is [long]) -and $manifest.schema -eq 1 -and $manifest.product -ceq 'SupportTemplates') 'Unknown manifest schema/product'
    Require ($manifest.upstreamCommit -is [string] -and $manifest.upstreamCommit.Length -gt 0) 'Missing upstreamCommit'
    Valid-Version $manifest.version
    Require ($manifest.files -is [Array] -and $manifest.files.Count -ge 5) 'Manifest files must be a nonempty array'
    $seen = @{}
    $overlay = $null
    if ($Stored -and (Full $Base) -ieq (Full (Version-Path $manifest.version))) { $overlay = Read-RendererOverlay $manifest.version }
    foreach ($file in $manifest.files) {
        Require ($file.path -is [string]) 'Manifest path must be a string'
        Valid-Relative $file.path
        Require (-not $seen.ContainsKey($file.path)) "Duplicate manifest path: $($file.path)"
        Require ($file.sha256 -is [string] -and $file.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid SHA-256'
        Require (($file.size -is [int] -or $file.size -is [long] -or $file.size -is [double]) -and $file.size -ge 0 -and $file.size -le 2147483647 -and [Math]::Floor($file.size) -eq $file.size) 'Invalid file size'
        $relative = $file.path
        if ($Stored) { $relative = $relative.Substring(8) }
        $path = Full (Join-Path $Base $relative)
        Require (Under $path $Base) 'Payload path escapes package'
        Safe-File $path
        if ($Stored) { Assert-SharedRuntimeFile $path }
        if ($null -ne $overlay -and $relative -ceq 'runtime/renderer.js') {
            Require ((Hash-File $path) -cin @($overlay.hash, $overlay.previousHash)) 'Renderer differs from update journal'
        } else {
            Require ((Get-Item -LiteralPath $path).Length -eq $file.size -and (Hash-File $path) -ceq $file.sha256) "Payload integrity failure: $relative"
        }
        $seen[$file.path] = $path
    }
    foreach ($required in @('payload/loader.asar', 'payload/runtime/patcher.js', 'payload/runtime/preload.js', 'payload/runtime/renderer.js', 'payload/runtime/renderer.css')) {
        Require ($seen.ContainsKey($required)) "Required payload missing: $required"
    }
    $treeRoot = Join-Path $Base 'payload'
    if ($Stored) { $treeRoot = $Base }
    $actual = @(Tree-Files $treeRoot)
    $count = 0
    foreach ($path in $actual) {
        $rel = $path.Substring($Base.Length + 1).Replace('\', '/')
        if ($Stored -and $rel -ceq 'manifest.json') { continue }
        if ($Stored) { $rel = 'payload/' + $rel }
        Require ($seen.ContainsKey($rel)) "Unlisted payload file: $rel"
        $count++
    }
    Require ($count -eq $seen.Count) 'Payload file count mismatch'
    [pscustomobject]@{ Manifest=$manifest; Base=$Base; Files=$seen; LoaderHash=$manifest.files.Where({$_.path -ceq 'payload/loader.asar'})[0].sha256 }
}
function Version-Path([string]$Version) {
    Valid-Version $Version
    Join-Path $script:ChannelRoot ('versions/' + $Version)
}
function Stored-Package([string]$Version) {
    $package = Read-Package (Version-Path $Version) -Stored
    Require ($package.Manifest.version -ceq $Version) 'Stored version does not match its directory'
    return $package
}
function Ensure-Directory([string]$Path) {
    Safe-Path $Path
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    Safe-Directory $Path
}
function Save-Package($Package) {
    $destination = Version-Path $Package.Manifest.version
    if (Exists $destination) {
        $existing = Stored-Package $Package.Manifest.version
        Require ((Hash-File (Join-Path $destination 'manifest.json')) -eq (Hash-File (Join-Path $Package.Base 'manifest.json'))) 'Version already exists with different manifest; use a new version'
        return $existing
    }
    Ensure-Directory (Split-Path $destination -Parent)
    $stage = Join-Path (Split-Path $destination -Parent) ('.stage-' + [guid]::NewGuid().ToString('N'))
    Ensure-Directory $stage
    # A crash here can leave only an unused stage directory. It cannot affect Discord.
    foreach ($entry in $Package.Manifest.files) {
        $target = Join-Path $stage $entry.path.Substring(8)
        Ensure-Directory (Split-Path $target -Parent)
        Write-New $target ([IO.File]::ReadAllBytes($Package.Files[$entry.path]))
    }
    Write-New (Join-Path $stage 'manifest.json') ([IO.File]::ReadAllBytes((Join-Path $Package.Base 'manifest.json')))
    Read-Package $stage -Stored | Out-Null
    Safe-Path $destination
    [IO.Directory]::Move($stage, $destination)
    Stored-Package $Package.Manifest.version
}
function Missing-CacheFiles($Package) {
    $destination = Version-Path $Package.Manifest.version
    Safe-Path $destination
    $expected = @{'manifest.json'=(Hash-File (Join-Path $Package.Base 'manifest.json'))}
    foreach ($entry in $Package.Manifest.files) { $expected[$entry.path.Substring(8)] = $entry.sha256 }
    if (Exists $destination) {
        foreach ($file in @(Tree-Files $destination)) {
            $relative = $file.Substring($destination.Length + 1).Replace('\', '/')
            Require ($expected.ContainsKey($relative)) "Foreign cached file: $relative"
            Require ((Hash-File $file) -ceq $expected[$relative]) "Cached file changed; refusing overwrite: $relative"
        }
    }
    foreach ($relative in $expected.Keys) {
        $path = Join-Path $destination $relative
        Safe-Path $path
        if (-not (Exists $path)) { $relative }
        else { Safe-File $path }
    }
}
function Repair-Cache($Package, [string]$ManifestHash) {
    $missing = @(Missing-CacheFiles $Package)
    $destination = Version-Path $Package.Manifest.version
    foreach ($relative in $missing) {
        $source = Join-Path $Package.Base ('payload/' + $relative)
        if ($relative -ceq 'manifest.json') { $source = Join-Path $Package.Base $relative }
        $bytes = [IO.File]::ReadAllBytes($source)
        $expectedHash = $ManifestHash
        if ($relative -cne 'manifest.json') { $expectedHash = $Package.Manifest.files.Where({$_.path -ceq ('payload/' + $relative)})[0].sha256 }
        Require ((Hash-Bytes $bytes) -ceq $expectedHash) 'Repair input changed while reading'
        Ensure-Directory (Split-Path $destination -Parent)
        $stage = Join-Path (Split-Path $destination -Parent) ('.repair-' + [guid]::NewGuid().ToString('N'))
        Write-New $stage $bytes
        $target = Join-Path $destination $relative
        Ensure-Directory (Split-Path $target -Parent)
        # Move cannot overwrite an existing file. Interrupted repairs can be retried safely.
        [IO.File]::Move($stage, $target)
    }
    Stored-Package $Package.Manifest.version | Out-Null
}

function Asar-Entry($Tree, [string]$Name) {
    $node = $Tree
    foreach ($segment in $Name.Split('/')) {
        $property = $node.files.PSObject.Properties[$segment]
        Require ($null -ne $property) "ASAR entry missing: $Name"
        $node = $property.Value
    }
    return $node
}
function Check-AsarTree($Node, [long]$PayloadLength, [int]$Depth = 0) {
    Require ($Depth -lt 64) 'ASAR directory nesting too deep'
    foreach ($entry in $Node.files.PSObject.Properties) {
        Require ($entry.Name -notin @('.', '..') -and $entry.Name -notmatch '[/\\:]') 'Unsafe ASAR entry name'
        $value = $entry.Value
        Require ($null -eq $value.PSObject.Properties['link']) 'ASAR links are not supported'
        if ($null -ne $value.PSObject.Properties['files']) { Check-AsarTree $value $PayloadLength ($Depth + 1); continue }
        Require ($null -ne $value.PSObject.Properties['size'] -and $value.size -ge 0) 'Invalid ASAR entry size'
        if ($null -ne $value.PSObject.Properties['unpacked'] -and $value.unpacked -eq $true) { continue }
        Require ($value.offset -match '^\d+$') 'Invalid ASAR offset'
        Require ([long]$value.offset -le $PayloadLength -and [long]$value.size -le ($PayloadLength - [long]$value.offset)) 'ASAR entry outside archive'
    }
}
function Check-OriginalAsar([string]$Path) {
    Safe-File $Path
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        Require ($stream.Length -ge 20) 'Unknown app.asar: not a supported ASAR archive'
        $sizeSize = $reader.ReadUInt32(); $headerSize = $reader.ReadUInt32()
        $pickleSize = $reader.ReadUInt32(); $jsonSize = $reader.ReadUInt32()
        Require ($sizeSize -eq 4 -and $headerSize -ge 8 -and $headerSize -le 8388608 -and $pickleSize -eq ($headerSize - 4) -and $jsonSize -gt 0 -and $jsonSize -le ($headerSize - 8) -and ($headerSize - 8 - $jsonSize) -le 3 -and ($headerSize % 4) -eq 0 -and ($headerSize + 8) -lt $stream.Length) 'Unknown app.asar: invalid ASAR header'
        $json = $script:Utf8.GetString($reader.ReadBytes($jsonSize))
        Require ($json -notmatch '(?i)vencord|betterdiscord|openasar|replugged|modloader') 'Foreign modloader ASAR refused'
        $tree = $json | ConvertFrom-Json
        $payloadStart = [long]$headerSize + 8
        Check-AsarTree $tree ($stream.Length - $payloadStart)
        $entry = Asar-Entry $tree 'package.json'
        Require ($entry.size -gt 0 -and $entry.size -le 65536 -and $null -ne $entry.PSObject.Properties['offset']) 'Unknown ASAR package.json'
        $stream.Position = $payloadStart + [long]$entry.offset
        $packageText = $script:Utf8.GetString($reader.ReadBytes($entry.size))
        Require ($packageText -notmatch '(?i)vencord|betterdiscord|openasar|replugged|modloader') 'Foreign modloader package refused'
        $package = $packageText | ConvertFrom-Json
        $main = $package.main -replace '^\./', ''
        Require ($main -match '^[A-Za-z0-9_./-]+\.(js|cjs)$' -and $main -notmatch '(^|/)\.\.(/|$)') 'Unknown ASAR main entry'
        $mainEntry = Asar-Entry $tree $main
        Require ($mainEntry.size -gt 0 -and $null -ne $mainEntry.PSObject.Properties['offset']) 'Unknown ASAR main file'
        $stream.Position = $payloadStart + [long]$mainEntry.offset
        $mainText = $script:Utf8.GetString($reader.ReadBytes([int][Math]::Min($mainEntry.size, 65536)))
        Require ($mainText -notmatch '(?i)vencord|betterdiscord|openasar|replugged|modloader') 'Foreign modloader bootstrap refused'
    }
    finally { $reader.Dispose(); $stream.Dispose() }
}

function Compare-AppVersion([string]$Left, [string]$Right) {
    $l = $Left.Split('-', 2); $r = $Right.Split('-', 2)
    $core = ([version]$l[0]).CompareTo([version]$r[0])
    if ($core -ne 0) { return $core }
    if ($l.Length -eq 1 -and $r.Length -eq 1) { return 0 }
    if ($l.Length -eq 1) { return 1 }; if ($r.Length -eq 1) { return -1 }
    $lp = $l[1].Split('.'); $rp = $r[1].Split('.')
    for ($i = 0; $i -lt [Math]::Min($lp.Length, $rp.Length); $i++) {
        $ln = $lp[$i] -match '^\d+$'; $rn = $rp[$i] -match '^\d+$'
        if ($ln -and $rn) { $cmp = ([decimal]$lp[$i]).CompareTo([decimal]$rp[$i]) }
        elseif ($ln) { $cmp = -1 } elseif ($rn) { $cmp = 1 }
        else { $cmp = [string]::CompareOrdinal($lp[$i], $rp[$i]) }
        if ($cmp -ne 0) { return $cmp }
    }
    return $lp.Length.CompareTo($rp.Length)
}
function Get-DiscordClients([string]$LocalRoot) {
    # Discovery is read-only. Selection never implies permission to close Discord;
    # the existing installer validates ownership, paths and stopped state afterwards.
    $choices = @()
    foreach ($candidate in @(
        @{Channel='Stable';Exe='Discord';Label='Discord (Stable)'},
        @{Channel='Canary';Exe='DiscordCanary';Label='Discord Canary'},
        @{Channel='PTB';Exe='DiscordPTB';Label='Discord PTB'}
    )) {
        $client = Join-Path $LocalRoot $candidate.Exe
        Safe-Path $client
        if (-not [IO.Directory]::Exists($client)) { continue }
        $found = $false
        foreach ($entry in Get-ChildItem -LiteralPath $client -Force) {
            if (-not $entry.PSIsContainer -or $entry.Name -notmatch '^app-\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { continue }
            Safe-Directory $entry.FullName
            $exe = Join-Path $entry.FullName ($candidate.Exe + '.exe')
            $resources = Join-Path $entry.FullName 'resources'
            Safe-Path $exe; Safe-Path $resources
            if ([IO.File]::Exists($exe) -and [IO.Directory]::Exists($resources)) { $found = $true }
        }
        if ($found) { $choices += [pscustomobject]@{Channel=$candidate.Channel;Label=$candidate.Label;Path=$client} }
    }
    return $choices
}
function Select-DiscordChannel([string]$LocalRoot) {
    $choices = @(Get-DiscordClients $LocalRoot)
    Require ($choices.Count -gt 0) 'No supported Discord installation found. Install Discord, Discord Canary or Discord PTB first. Portable locations are not supported.'
    Write-Host ''
    Write-Host 'SupportTemplates - Select Discord'
    for ($i = 0; $i -lt $choices.Count; $i++) {
        Write-Host ('  {0}. {1}  [{2}]' -f ($i + 1), $choices[$i].Label, $choices[$i].Path)
    }
    Write-Host '  0. Cancel'
    while ($true) {
        $answer = Read-Host 'Enter a number (Enter = cancel)'
        if ([string]::IsNullOrWhiteSpace($answer) -or $answer.Trim() -eq '0') { return $null }
        $number = 0
        if ([int]::TryParse($answer.Trim(), [ref]$number) -and $number -ge 1 -and $number -le $choices.Count) {
            Write-Host ('Selected: ' + $choices[$number - 1].Label)
            return $choices[$number - 1].Channel
        }
        Write-Host 'Invalid selection. Enter one of the displayed numbers, or 0 to cancel.'
    }
}
function Select-Resources {
    Safe-Directory $script:DiscordRoot
    $latest = $null
    foreach ($item in Get-ChildItem -LiteralPath $script:DiscordRoot -Force) {
        if (-not $item.PSIsContainer -or $item.Name -notmatch '^app-(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$') { continue }
        Safe-Directory $item.FullName
        $version = $Matches[1]
        if ($null -eq $latest -or (Compare-AppVersion $version $latest.Version) -gt 0) {
            $latest = [pscustomobject]@{Path=$item.FullName;Version=$version}
        }
    }
    Require ($null -ne $latest) "No supported app-SEMVER directory in $script:DiscordRoot"
    $resources = Full (Join-Path $latest.Path 'resources')
    Require (Under $resources $script:DiscordRoot) 'Resources escape target root'
    Safe-Directory $resources
    Safe-File (Join-Path $latest.Path ($script:ExeName + '.exe'))
    return $resources
}
function Set-Resources([string]$Path) {
    $script:Resources = Full $Path
    Require (Under $script:Resources $script:DiscordRoot) 'Resources escape target channel'
    Safe-Directory $script:Resources
    $script:Transaction = Join-Path $script:Resources '.support-templates-transaction'
    $script:Migration = Join-Path $script:Resources '.support-templates-migration'
}
function Uninstall-Channel {
    Safe-Directory $script:DiscordRoot
    if (-not $CloseDiscord) { Check-TargetStopped }
    $targets = @()
    foreach ($app in Get-ChildItem -LiteralPath $script:DiscordRoot -Force) {
        if (-not $app.PSIsContainer -or $app.Name -notmatch '^app-\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') { continue }
        Safe-Directory $app.FullName
        $resources = Join-Path $app.FullName 'resources'
        Safe-Path $resources
        if (-not (Exists $resources)) { continue }
        $owned = $false
        foreach ($name in @('support-templates.install.json', 'support-templates.json', '.support-templates-transaction', '.support-templates-migration')) {
            Safe-Path (Join-Path $resources $name)
            if (Exists (Join-Path $resources $name)) { $owned = $true }
        }
        if (-not $owned) { continue }
        Set-Resources $resources
        if (Exists $script:Migration) {
            Check-Migration | Out-Null
            throw 'Interrupted replacement: retry Install with ReplaceExisting and Discord closed to restore the displaced mod first'
        }
        Check-Foreign
        if (Exists $script:Transaction) { Check-Journal | Out-Null }
        else { Read-State | Out-Null }
        $targets += $resources
    }
    if ($targets.Count -eq 0) { Write-Output 'Not installed; no owned app versions to uninstall.'; return }
    # Preflight every owned version before changing any one of them. Each archive has its own journal.
    if (-not $PSCmdlet.ShouldProcess($script:DiscordRoot, "Uninstall $($targets.Count) owned app version(s); retain settings and runtime cache")) { return }
    if ($CloseDiscord -and -not (Close-TargetDiscord)) { return }
    foreach ($resources in $targets) {
        Set-Resources $resources
        if (Exists $script:Transaction) { Recover-Transaction }
        $state = Read-State
        if ($null -eq $state) { continue }
        Transact @{'app.asar'=[IO.File]::ReadAllBytes((Join-Path $script:Resources '_app.asar'));'_app.asar'=$null;'support-templates.json'=$null;'support-templates.install.json'=$null}
    }
    Write-Output "Uninstalled all owned app versions in $script:ChannelName. Original archives restored; settings and runtime versions retained."
}
function Get-TargetProcesses {
    $processes = @()
    if ($script:Fixture) {
        if ($TestRunningTarget -and -not $script:FixtureTargetClosed) { $processes += [pscustomobject]@{ProcessName=$script:ExeName;Path=(Join-Path $script:DiscordRoot ('app-1.0.9/' + $script:ExeName + '.exe'));Id=999001} }
        if ($TestRunningOtherChannel) {
            $other = 'Discord'; if ($script:ExeName -eq 'Discord') { $other = 'DiscordCanary' }
            $processes += [pscustomobject]@{ProcessName=$other;Path=(Join-Path $script:LocalRoot ($other + '/app-0.0.1/' + $other + '.exe'));Id=999002}
        }
    }
    else { $processes = @(Get-Process -Name $script:ExeName -ErrorAction SilentlyContinue) }
    return @($processes | Where-Object { $_.ProcessName -ieq $script:ExeName })
}
function Read-LiveProcessPath($Process) {
    if (-not $script:Fixture) {
        $Process.Refresh()
        if ($Process.HasExited) { return $null }
    }
    $path = $null
    try { $path = $Process.Path } catch { }
    # Electron children can exit between enumeration, HasExited and MainModule
    # (the Path property). An unreadable path is safe only after confirmed exit.
    if (-not $script:Fixture) {
        $Process.Refresh()
        if ($Process.HasExited) { return $null }
    }
    Require (-not [string]::IsNullOrWhiteSpace($path)) 'Cannot establish target process path; close the target Discord before retrying'
    return $path
}
function Check-TargetStopped {
    $processes = @(Get-TargetProcesses)
    # Check all versions of the selected channel; never inspect or control the other channel.
    foreach ($process in $processes) {
        if ($process.ProcessName -ine $script:ExeName) { continue }
        $path = Read-LiveProcessPath $process
        if ($null -eq $path) { continue }
        Require (-not (Under $path $script:DiscordRoot)) "Target Discord is running (PID $($process.Id)); close it before retrying"
    }
}
function Confirm-ClosePath([string]$Path) {
    Require (-not [string]::IsNullOrWhiteSpace($Path)) 'Cannot establish target process path; close the target Discord before retrying'
    $fullPath = Full $Path
    $app = Split-Path $fullPath -Parent
    Require ((Split-Path $fullPath -Leaf) -ieq ($script:ExeName + '.exe') -and
        (Split-Path $app -Parent) -ieq (Full $script:DiscordRoot) -and
        (Split-Path $app -Leaf) -match '^app-\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') 'Unrecognized selected Discord process path; automatic close refused'
    Safe-File $fullPath
    return $fullPath
}
function Confirm-CloseProcess($Target) {
    $process = $Target.Process
    $path = Read-LiveProcessPath $process
    if ($null -eq $path) { return $false }
    try {
        Require ((Confirm-ClosePath $path) -ieq $Target.Path -and
            $process.StartTime.ToUniversalTime().Ticks -eq $Target.Started -and
            $process.Handle -eq $Target.Handle) 'Selected Discord process identity changed; automatic close refused'
    } catch {
        $process.Refresh()
        if ($process.HasExited) { return $false }
        throw
    }
    return $true
}
function Check-CloseHostOwnership([string]$Path) {
    $resources = $script:Resources
    $expected = Get-Variable ExpectedFiles -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    try {
        Set-Resources (Join-Path (Split-Path $Path -Parent) 'resources')
        Require (-not (Exists $script:Transaction)) 'Running host has a pending transaction; close Discord manually before recovery'
        Require (-not (Exists $script:Migration)) 'Running host has a pending replacement; close Discord manually before recovery'
        if ($null -ne $script:ReplacementApproval -and $script:Resources -ieq $script:ReplacementApproval.Resources) { Check-MigrationApproval }
        else { Read-State | Out-Null }
    } finally {
        Set-Resources $resources
        $script:ExpectedFiles = $expected
    }
}
function Close-TargetDiscord {
    $processes = @(Get-TargetProcesses)
    if ($processes.Count -eq 0) { Check-TargetStopped; return $true }
    $targets = @()
    $checkedHosts = @{}
    $selectedCount = 0
    try {
        # Validate the entire set before contacting any window. Retaining Handle
        # pins each Process object to the original process, not a recycled PID.
        foreach ($process in $processes) {
            $processPath = Read-LiveProcessPath $process
            if ($null -eq $processPath) { continue }
            Require ($processPath -match '^[A-Za-z]:[\\/]') 'Cannot establish target process path; close the target Discord before retrying'
            # A readable same-name executable belonging to another installation
            # is unrelated. Unknown paths cannot safely be classified this way.
            if (-not (Under $processPath $script:DiscordRoot)) { continue }
            $path = Confirm-ClosePath $processPath
            $selectedCount++
            if (-not $checkedHosts.ContainsKey($path)) {
                Check-CloseHostOwnership $path
                $checkedHosts[$path] = $true
            }
            if ($script:Fixture) { continue } # Synthetic PIDs can never reach process methods.
            try {
                $targets += [pscustomobject]@{Process=$process;Path=$path;Handle=$process.Handle;Started=$process.StartTime.ToUniversalTime().Ticks}
            } catch {
                $process.Refresh()
                if (-not $process.HasExited) { throw }
            }
        }
        if ($selectedCount -eq 0) { Check-TargetStopped; return $true }
        if (-not $PSCmdlet.ShouldProcess($script:DiscordRoot, 'Close selected Discord; terminate remaining confirmed host processes after a short grace period')) { return $false }
        if ($script:Fixture) {
            $script:FixtureTargetClosed = $true
            Write-Host 'Fixture: selected Discord close simulated; no process methods called.'
        } else {
            foreach ($target in $targets) {
                if (Confirm-CloseProcess $target) { $null = $target.Process.CloseMainWindow() }
            }
            $clock = [Diagnostics.Stopwatch]::StartNew()
            do {
                $running = @($targets | Where-Object { $_.Process.Refresh(); -not $_.Process.HasExited })
                if ($running.Count -eq 0 -or $clock.ElapsedMilliseconds -ge 1500) { break }
                Start-Sleep -Milliseconds 50
            } while ($true)
            foreach ($target in $running) {
                if (Confirm-CloseProcess $target) { $target.Process.Kill() }
            }
            $clock.Restart()
            do {
                $running = @($targets | Where-Object { $_.Process.Refresh(); -not $_.Process.HasExited })
                if ($running.Count -eq 0) { break }
                Require ($clock.ElapsedMilliseconds -lt 2000) 'Selected Discord did not stop; no installation writes permitted'
                Start-Sleep -Milliseconds 50
            } while ($true)
        }
        # A child/restarted client discovered after the snapshot is never killed
        # blindly; it causes refusal, and Transact checks again before writing.
        Check-TargetStopped
        return $true
    } finally {
        if (-not $script:Fixture) { foreach ($process in $processes) { $process.Dispose() } }
    }
}
function Read-ClosePreflight($State) {
    Require ($null -eq (Read-RendererCleanup)) 'Pending renderer cleanup requires manual Discord close before recovery'
    if ($Action -eq 'Rollback') {
        Require ($null -ne $State -and $null -ne $State.previousVersion) 'No previous owned runtime is available for rollback'
        $package = Stored-Package $State.previousVersion
        Require ($package.LoaderHash -ceq $State.previousLoaderHash -and (Hash-File (Join-Path $package.Base 'manifest.json')) -ceq $State.previousManifestHash) 'Previous runtime no longer matches its ownership record'
    } else { $package = Read-Package $script:PackageRoot }
    $version = $package.Manifest.version
    if ($null -ne $State -and $Action -in @('Install', 'Repair')) {
        Require ((Compare-PackageVersion $version $State.version) -ge 0) "$Action cannot downgrade the installed version; refresh the package first"
        if ($version -ceq $State.version) {
            Require ($package.LoaderHash -ceq $State.loaderHash -and (Hash-File (Join-Path $package.Base 'manifest.json')) -ceq $State.manifestHash) 'Same version has different package content; use a new version'
        }
    }
    if ($null -ne $State -and $null -ne (Read-RendererOverlay $State.version)) { Stored-Package $State.version | Out-Null }
    if (Exists (Version-Path $version)) {
        if (($Action -eq 'Repair' -or ($Action -eq 'Install' -and $null -ne $State -and $version -ceq $State.version)) -and $null -eq (Read-RendererOverlay $version)) { Missing-CacheFiles $package | Out-Null }
        else {
            Stored-Package $version | Out-Null
            Require ((Hash-File (Join-Path (Version-Path $version) 'manifest.json')) -ceq (Hash-File (Join-Path $package.Base 'manifest.json'))) 'Existing version content differs'
        }
    }
    return $package
}
function Check-Foreign {
    Safe-Directory $script:Resources
    Require (-not (Exists (Join-Path $script:Resources 'app'))) 'Foreign resources/app directory refused'
    foreach ($name in $script:ResourceNames) { Safe-Path (Join-Path $script:Resources $name) }
}
function Make-Config([string]$Version) {
    [ordered]@{schema=1;product='SupportTemplates';channel=$script:ChannelName;runtime=(Join-Path (Version-Path $Version) 'runtime');dataDir=(Join-Path $script:ChannelRoot 'data')}
}
function Check-OwnedFiles($State, [string]$App, [string]$Backup, [string]$Config) {
    Require ($State.schema -eq 1 -and $State.product -ceq 'SupportTemplates' -and $State.channel -ceq $script:ChannelName -and $State.resources -ieq $script:Resources) 'Invalid installer ownership state'
    Valid-Version $State.version
    if ($null -ne $State.previousVersion) {
        Valid-Version $State.previousVersion
        Require ($State.previousManifestHash -cmatch '^[a-f0-9]{64}$' -and $State.previousLoaderHash -cmatch '^[a-f0-9]{64}$') 'Invalid prior runtime ownership hashes'
    }
    foreach ($hash in @($State.loaderHash, $State.originalHash, $State.configHash, $State.manifestHash)) { Require ($hash -cmatch '^[a-f0-9]{64}$') 'Invalid state hash' }
    Require ($State.loaderHash -cne $State.originalHash) 'Loader and original must be distinct'
    Require ((Hash-File $App) -ceq $State.loaderHash) 'Current app.asar is not the owned loader; refusing overwrite'
    Require ((Hash-File $Backup) -ceq $State.originalHash) 'Original backup was modified; refusing overwrite'
    Require ((Get-Item -LiteralPath $Backup).Length -eq $State.originalSize) 'Original backup size mismatch'
    Check-OriginalAsar $Backup
    Require ((Hash-File $Config) -ceq $State.configHash) 'Owned configuration was modified; refusing overwrite'
    $configValue = Read-Json $Config
    $expected = Make-Config $State.version
    Require ($configValue.schema -eq 1 -and $configValue.product -ceq 'SupportTemplates' -and $configValue.channel -ceq $script:ChannelName -and $configValue.runtime -ieq $expected.runtime -and $configValue.dataDir -ieq $expected.dataDir) 'Configuration path/identity mismatch'
    Safe-Path $configValue.dataDir
    # Ownership/original verification deliberately does not depend on the runtime cache.
}
function Read-State {
    Check-Foreign
    $expectedFiles = @{}
    foreach ($name in $script:ResourceNames) { $expectedFiles[$name] = Current-Hash (Join-Path $script:Resources $name) }
    $statePath = Join-Path $script:Resources 'support-templates.install.json'
    if (-not (Exists $statePath)) {
        Require (-not (Exists (Join-Path $script:Resources '_app.asar')) -and -not (Exists (Join-Path $script:Resources 'support-templates.json'))) 'Foreign backup/config without ownership state refused'
        Check-OriginalAsar (Join-Path $script:Resources 'app.asar')
        Save-ExpectedFiles $expectedFiles
        return $null
    }
    $state = Read-Json $statePath
    Check-OwnedFiles $state (Join-Path $script:Resources 'app.asar') (Join-Path $script:Resources '_app.asar') (Join-Path $script:Resources 'support-templates.json')
    Save-ExpectedFiles $expectedFiles
    return $state
}
function Save-ExpectedFiles([hashtable]$ExpectedFiles) {
    foreach ($name in $script:ResourceNames) {
        Require ((Current-Hash (Join-Path $script:Resources $name)) -ceq $ExpectedFiles[$name]) 'Resources changed during validation; retry with Discord closed'
    }
    $script:ExpectedFiles = $ExpectedFiles
}

# Transaction directory contains an immutable journal and complete before/after bytes.
# Recovery always restores BEFORE. Each current file must match either snapshot before ANY writes.
# These hashes are ownership/corruption checks, not a security boundary against a same-user attacker.
function Check-JournalSide($Journal, [string]$Side) {
    Require ($null -ne $Journal.files[2].$Side) 'Invalid journal: app.asar must exist in both states'
    $app = Join-Path $script:Transaction "2.$Side"
    if ($null -eq $Journal.files[3].$Side) {
        Require ($null -eq $Journal.files[0].$Side -and $null -eq $Journal.files[1].$Side) 'Invalid journal: clean state has owned sidecars'
        Check-OriginalAsar $app
        return [pscustomobject]@{OriginalHash=$Journal.files[2].$Side;OriginalSize=(Get-Item -LiteralPath $app).Length;State=$null}
    }
    Require ($null -ne $Journal.files[0].$Side -and $null -ne $Journal.files[1].$Side) 'Invalid journal: installed state lacks backup/config'
    $state = Read-Json (Join-Path $script:Transaction "3.$Side")
    Check-OwnedFiles $state $app (Join-Path $script:Transaction "0.$Side") (Join-Path $script:Transaction "1.$Side")
    return [pscustomobject]@{OriginalHash=$state.originalHash;OriginalSize=$state.originalSize;State=$state}
}
function Check-Journal {
    Safe-Directory $script:Transaction
    $journal = Read-Json (Join-Path $script:Transaction 'journal.json')
    Require ($journal.schema -eq 1 -and $journal.product -ceq 'SupportTemplates' -and $journal.resources -ieq $script:Resources -and $journal.channel -ceq $script:ChannelName) 'Foreign transaction refused'
    Require ($journal.files.Count -eq 4) 'Invalid transaction file count'
    $allowed = @{'journal.json'=$true}
    for ($i = 0; $i -lt 4; $i++) {
        $entry = $journal.files[$i]
        Require ($entry.name -ceq $script:ResourceNames[$i]) 'Invalid transaction target'
        foreach ($side in @('before', 'after')) {
            $hash = $entry.$side
            if ($null -ne $hash) {
                Require ($hash -cmatch '^[a-f0-9]{64}$') 'Invalid transaction hash'
                $copy = "$i.$side"
                $allowed[$copy] = $true
                Require ((Hash-File (Join-Path $script:Transaction $copy)) -ceq $hash) 'Transaction snapshot corrupted'
            }
        }
        $swap = "$i.swap"
        if (Exists (Join-Path $script:Transaction $swap)) {
            $swapHash = Hash-File (Join-Path $script:Transaction $swap)
            Require ($swapHash -ceq $entry.before -or $swapHash -ceq $entry.after) 'Foreign transaction staging file'
            $allowed[$swap] = $true
        }
        $current = Current-Hash (Join-Path $script:Resources $entry.name)
        Require ($current -ceq $entry.before -or $current -ceq $entry.after) "Foreign modification during transaction: $($entry.name)"
    }
    foreach ($item in Get-ChildItem -LiteralPath $script:Transaction -Force) {
        Safe-File $item.FullName
        Require ($allowed.ContainsKey($item.Name)) 'Unknown file in transaction directory'
    }
    $before = Check-JournalSide $journal 'before'
    $after = Check-JournalSide $journal 'after'
    Require ($before.OriginalHash -ceq $after.OriginalHash -and $before.OriginalSize -eq $after.OriginalSize) 'Invalid journal: original archive identity changes between states'
    Require ($null -ne $before.State -or $null -ne $after.State) 'Invalid journal: no owned installation on either side'
    if ($null -ne $before.State -and $null -ne $after.State) {
        Require ($after.State.previousVersion -ceq $before.State.version -and $after.State.previousManifestHash -ceq $before.State.manifestHash -and $after.State.previousLoaderHash -ceq $before.State.loaderHash) 'Invalid journal: upgrade history does not match'
    }
    elseif ($null -ne $after.State) { Require ($null -eq $after.State.previousVersion) 'Invalid journal: fresh install has an unexpected predecessor' }
    return $journal
}
function Apply-Snapshot($Journal, [int]$Index, [string]$Side) {
    Check-TargetStopped
    Check-Foreign
    $entry = $Journal.files[$Index]
    $target = Join-Path $script:Resources $entry.name
    $current = Current-Hash $target
    Require ($current -ceq $entry.before -or $current -ceq $entry.after) "Concurrent modification of $($entry.name)"
    $wanted = $entry.$Side
    if ($current -ceq $wanted) { return }
    if ($null -eq $wanted) {
        Require ($entry.name -cne 'app.asar') 'Refusing to delete app.asar'
        if ($entry.name -ceq '_app.asar') {
            Require ((Hash-File (Join-Path $script:Resources 'app.asar')) -ceq $Journal.files[2].$Side) 'Cannot remove backup before original is restored'
            Check-OriginalAsar (Join-Path $script:Resources 'app.asar')
        }
        [IO.File]::Delete($target)
        return
    }
    $snapshot = Join-Path $script:Transaction "$Index.$Side"
    Require ((Hash-File $snapshot) -ceq $wanted) 'Snapshot changed during transaction'
    $swap = Join-Path $script:Transaction "$Index.swap"
    if (Exists $swap) {
        $swapHash = Hash-File $swap
        Require ($swapHash -ceq $entry.before -or $swapHash -ceq $entry.after) 'Foreign swap file refused'
        [IO.File]::Delete($swap)
    }
    Write-New $swap ([IO.File]::ReadAllBytes($snapshot))
    Safe-Path $target
    if (Exists $target) { [IO.File]::Replace($swap, $target, [NullString]::Value) }
    else { [IO.File]::Move($swap, $target) }
    Require ((Hash-File $target) -ceq $wanted) 'Atomic replacement verification failed'
}
function Clear-Journal($Journal, [string]$Side) {
    Check-Journal | Out-Null
    foreach ($entry in $Journal.files) {
        Require ((Current-Hash (Join-Path $script:Resources $entry.name)) -ceq $entry.$Side) 'Transaction final state changed; retaining journal for recovery'
    }
    # Rename is the commit point. A crash during subsequent cleanup cannot cause partial rollback.
    $garbage = Join-Path $script:Resources ('.support-templates-complete-' + [guid]::NewGuid().ToString('N'))
    Safe-Path $garbage
    [IO.Directory]::Move($script:Transaction, $garbage)
    foreach ($file in Get-ChildItem -LiteralPath $garbage -Force) {
        Safe-File $file.FullName
        [IO.File]::Delete($file.FullName)
    }
    [IO.Directory]::Delete($garbage)
}
function Recover-Transaction {
    Check-Foreign
    $journal = Check-Journal
    # Restore app first; remove a newly created backup only after the original is in place.
    foreach ($index in @(2, 1, 3, 0)) { Apply-Snapshot $journal $index 'before' }
    Clear-Journal $journal 'before'
    Write-Output 'Recovered interrupted transaction to its previous state.'
}
function Transact([hashtable]$After) {
    Require (-not (Exists $script:Transaction)) 'Pending transaction requires recovery'
    Check-TargetStopped
    Check-Foreign
    $entries = @()
    $snapshots = @{}
    for ($i = 0; $i -lt 4; $i++) {
        $name = $script:ResourceNames[$i]
        $path = Join-Path $script:Resources $name
        $before = $null; $afterHash = $null
        if (Exists $path) {
            Safe-File $path
            $snapshots["$i.before"] = [IO.File]::ReadAllBytes($path)
            $before = Hash-Bytes $snapshots["$i.before"]
        }
        Require ($before -ceq $script:ExpectedFiles[$name]) "Resources changed after validation: $name"
        if ($null -ne $After[$name]) {
            $snapshots["$i.after"] = $After[$name]
            $afterHash = Hash-Bytes $After[$name]
        }
        $entries += [ordered]@{name=$name;before=$before;after=$afterHash}
    }
    $journal = [pscustomobject]@{schema=1;product='SupportTemplates';channel=$script:ChannelName;resources=$script:Resources;files=$entries}
    # Build outside the active name; no target writes until the entire journal is published.
    $preparing = Join-Path $script:Resources ('.support-templates-prepare-' + [guid]::NewGuid().ToString('N'))
    Ensure-Directory $preparing
    foreach ($name in $snapshots.Keys) { Write-New (Join-Path $preparing $name) $snapshots[$name] }
    Write-New (Join-Path $preparing 'journal.json') (Json-Bytes $journal)
    [IO.Directory]::Move($preparing, $script:Transaction)
    $journal = Check-Journal
    try {
        # On uninstall restore app BEFORE removing the original backup.
        $order = @(0, 1, 2, 3)
        if ($null -eq $After['_app.asar']) { $order = @(2, 1, 3, 0) }
        $step = 0
        foreach ($index in $order) {
            Apply-Snapshot $journal $index 'after'
            $step++
            if ($TestCrashAfterStep -eq $step) { $script:SimulatedCrash = $true; throw "Simulated crash after step $step" }
            if ($TestFailAfterStep -eq $step) { throw "Simulated write failure after step $step" }
        }
        Clear-Journal $journal 'after'
    }
    catch {
        $failure = $_
        if (-not $script:SimulatedCrash -and (Exists $script:Transaction)) {
            try { Recover-Transaction }
            catch { Write-Warning "Automatic recovery stopped safely: $_. Keep the transaction directory and retry after resolving the cause." }
        }
        throw $failure
    }
}

try {
    if ($TestRoot) {
        $root = Full $TestRoot
        $temp = Full ([IO.Path]::GetTempPath())
        Require ((Under $root $temp) -and (Split-Path $root -Parent) -ieq $temp -and (Split-Path $root -Leaf) -cmatch '^SupportTemplates-installer-tests-[a-f0-9]{32}$') 'TestRoot must be a dedicated direct TEMP fixture'
        Safe-Directory $root
        Safe-File (Join-Path $root '.support-templates-fixture')
        Require ([IO.File]::ReadAllText((Join-Path $root '.support-templates-fixture')) -ceq 'SupportTemplates installer TEMP fixture') 'Missing fixture marker'
        Require ($LocalAppDataRoot -and (Full $LocalAppDataRoot) -ieq (Full (Join-Path $root 'localappdata'))) 'Fixture LocalAppDataRoot must equal TestRoot/localappdata'
        $fixturePackages = @((Full (Join-Path $root 'package')), (Full (Join-Path $root 'package/SupportTemplates')))
        Require ((Full $script:PackageRoot) -iin $fixturePackages) 'Fixture installer must run from TestRoot/package or its SupportTemplates directory'
        $script:Fixture = $true
        $script:LocalRoot = Full $LocalAppDataRoot
    }
    else {
        Require (-not $LocalAppDataRoot -and -not $TestRunningTarget -and -not $TestRunningOtherChannel -and $TestFailAfterStep -eq 0 -and $TestCrashAfterStep -eq 0 -and $TestFailMigrationAfterStep -eq 0 -and $TestCrashMigrationAfterStep -eq 0) 'Test switches require a validated TEMP fixture'
        Require (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) 'LOCALAPPDATA is missing'
        $script:LocalRoot = Full $env:LOCALAPPDATA
    }
    Safe-Directory $script:LocalRoot
    Safe-Directory $script:PackageRoot
    Require (-not $ReplaceExisting -or $Action -eq 'Install') 'ReplaceExisting is supported only for Install'
    if ($Action -eq 'Detect') {
        ConvertTo-Json -InputObject @(Get-DiscordClients $script:LocalRoot) -Depth 4 -Compress
        return
    }
    if (-not $PSBoundParameters.ContainsKey('Channel')) {
        $selectedChannel = Select-DiscordChannel $script:LocalRoot
        if ([string]::IsNullOrWhiteSpace($selectedChannel)) { Write-Host 'Cancelled. No files changed.'; return }
        $Channel = $selectedChannel
    }
    # ValidateSet accepts case-insensitive input; JSON consumers use canonical labels.
    $Channel = @{stable='Stable';canary='Canary';ptb='PTB'}[$Channel.ToLowerInvariant()]
    $script:ChannelName = $Channel.ToLowerInvariant()
    $script:ExeName = 'DiscordCanary'
    if ($Channel -eq 'Stable') { $script:ExeName = 'Discord' }
    if ($Channel -eq 'PTB') { $script:ExeName = 'DiscordPTB' }
    $script:DiscordRoot = Join-Path $script:LocalRoot $script:ExeName
    $script:ChannelRoot = Join-Path $script:LocalRoot ('SupportTemplates/channels/' + $script:ChannelName)
    Safe-Path $script:ChannelRoot
    # A named mutex serializes our own processes without creating a lock file during Status/WhatIf.
    $mutexId = Hash-Bytes $script:Utf8.GetBytes($script:ChannelRoot.ToLowerInvariant())
    $script:Mutex = New-Object Threading.Mutex($false, ('Local\SupportTemplates-' + $mutexId))
    try { $script:Locked = $script:Mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $script:Locked = $true }
    Require $script:Locked 'Another SupportTemplates installer is operating on this channel'
    if ($Action -eq 'Uninstall') { Uninstall-Channel; return }
    Set-Resources (Select-Resources)
    if ($Action -eq 'Inspect') { Inspect-Installation | ConvertTo-Json -Depth 4 -Compress; return }
    if (Exists $script:Migration) {
        $pending = Check-Migration
        if ($Action -eq 'Status') { Write-Output 'Pending replacement; retry explicit replacement with Discord closed to recover.'; return }
        Require ($Action -eq 'Install' -and $ReplaceExisting -ceq $pending.kind) 'Pending replacement requires matching explicit ReplaceExisting'
        $recoveryPackage = Read-ClosePreflight $null
        if ($null -ne $pending.files[5].before) {
            $displaced = Read-Json (Join-Path $script:Migration 'before/support-templates-vencord.install.json')
            Require ((Compare-PackageVersion $recoveryPackage.Manifest.version $displaced.version) -ge 0) 'Replacement cannot downgrade the installed package version'
        }
        if ($WhatIfPreference) { Write-Output 'What if: restore interrupted replacement, revalidate and replace the explicitly selected mod.'; return }
        Check-TargetStopped
        if (-not $PSCmdlet.ShouldProcess($script:Resources, 'Recover interrupted replacement before retry')) { return }
        Recover-Migration
    }
    if ($ReplaceExisting) { Install-Replacement; return }
    Check-Foreign
    if (Exists $script:Transaction) {
        Check-Journal | Out-Null
        if ($Action -eq 'Status') { Write-Output "Pending transaction: $script:Resources. Run repair or uninstall with the target closed to recover."; return }
        Check-TargetStopped
        if ($WhatIfPreference) { Write-Output 'What if: recover the interrupted transaction, then revalidate and plan the requested action.'; return }
        if (-not $PSCmdlet.ShouldProcess($script:Resources, 'Recover interrupted SupportTemplates transaction')) { return }
        Recover-Transaction
    }
    $state = Read-State
    if ($Action -eq 'Status') {
        if ($null -ne (Read-RendererCleanup)) { Write-Output 'Pending full-install renderer cleanup; repeat Install with the target closed.' }
        if ($null -eq $state) { Write-Output "Not installed: $script:ChannelName at $script:Resources" }
        else {
            try {
                $stored = Stored-Package $state.version
                Require ($stored.LoaderHash -ceq $state.loaderHash -and (Hash-File (Join-Path $stored.Base 'manifest.json')) -ceq $state.manifestHash) 'Runtime cache differs from ownership state'
                Write-Output "Installed: SupportTemplates $($state.version), $script:ChannelName at $script:Resources"
                $overlay = Read-RendererOverlay $state.version
                if ($null -ne $overlay) {
                    if ((Hash-File $stored.Files['payload/runtime/renderer.js']) -cne $overlay.hash) { Write-Output 'Pending renderer update: retry UpdateRenderer to finish.' }
                    else { Write-Output "Renderer: $($overlay.version); apply with Ctrl+R." }
                }
            }
            catch { throw "Runtime cache is unhealthy: $_" }
        }
        return
    }
    if ($Action -eq 'UpdateRenderer') {
        Require ($null -eq (Read-RendererCleanup)) 'Finish the interrupted full installation with Discord closed before updating the renderer'
        Update-Renderer $state; return
    }
    $preparedPackage = $null
    if ($CloseDiscord -and @(Get-TargetProcesses).Count -gt 0) {
        $preparedPackage = Read-ClosePreflight $state
        if ($Action -eq 'Install' -and $null -ne $state -and $state.version -ceq $preparedPackage.Manifest.version -and
            ($null -ne (Read-RendererOverlay $state.version) -or @(Missing-CacheFiles $preparedPackage).Count -eq 0)) {
            Stored-Package $state.version | Out-Null
            Write-Output "Already installed and verified: $($state.version)"
            return
        }
        if (-not (Close-TargetDiscord)) { return }
    } else { Check-TargetStopped }
    if ($null -ne (Read-RendererCleanup)) {
        if (-not $PSCmdlet.ShouldProcess($script:ChannelRoot, 'Complete interrupted full-install renderer cleanup')) { return }
        Complete-RendererCleanup $state
    }
    if ($null -ne $preparedPackage) { $package = $preparedPackage }
    elseif ($Action -eq 'Rollback') {
        Require ($null -ne $state -and $null -ne $state.previousVersion) 'No previous owned runtime is available for rollback'
        $package = Stored-Package $state.previousVersion
        Require ($package.LoaderHash -ceq $state.previousLoaderHash -and (Hash-File (Join-Path $package.Base 'manifest.json')) -ceq $state.previousManifestHash) 'Previous runtime no longer matches its ownership record'
    }
    else { $package = Read-Package $script:PackageRoot }
    $version = $package.Manifest.version
    if ($Action -in @('Install', 'Repair') -and $null -ne $state) {
        Require ((Compare-PackageVersion $version $state.version) -ge 0) "$Action cannot downgrade the installed version; refresh the package first"
    }
    $manifestHash = Hash-File (Join-Path $package.Base 'manifest.json')
    $oldOverlayVersion = $null
    if ($null -ne $state -and $null -ne (Read-RendererOverlay $state.version)) {
        Stored-Package $state.version | Out-Null
        $oldOverlayVersion = $state.version
    }
    if ($null -ne $state -and $state.version -ceq $version) {
        Require ($state.loaderHash -ceq $package.LoaderHash -and $state.manifestHash -ceq $manifestHash) 'Same version has different package content; use a new version'
        if ($Action -eq 'Repair' -and $null -ne $oldOverlayVersion) {
            if (-not $PSCmdlet.ShouldProcess((Version-Path $state.version), 'Restore verified base renderer')) { return }
            Restore-RendererOverlay $state.version
        }
        if ($Action -eq 'Repair' -or ($Action -eq 'Install' -and $null -eq $oldOverlayVersion)) {
            $missing = @(Missing-CacheFiles $package)
            if ($missing.Count -gt 0) {
                if (-not $PSCmdlet.ShouldProcess((Version-Path $version), "Restore $($missing.Count) missing cached files from matching verified package")) { return }
                Repair-Cache $package $manifestHash
                Write-Output "Repaired missing runtime cache files: $version"
                return
            }
        }
        Stored-Package $version | Out-Null
        Write-Output "Already installed and verified: $version"
        return
    }
    $cacheMissing = @()
    if (Exists (Version-Path $version)) {
        if ($Action -eq 'Repair') { $cacheMissing = @(Missing-CacheFiles $package) }
        else {
            Stored-Package $version | Out-Null
            Require ((Hash-File (Join-Path (Version-Path $version) 'manifest.json')) -eq $manifestHash) 'Existing version content differs'
        }
    }
    if (-not $PSCmdlet.ShouldProcess($script:Resources, "$Action SupportTemplates $version for $script:ChannelName")) { return }
    if ($cacheMissing.Count -gt 0) { Repair-Cache $package $manifestHash }
    if ($Action -ne 'Rollback') { $package = Save-Package $package }
    Ensure-Directory (Join-Path $script:ChannelRoot 'data')
    # Revalidate after staging, before taking snapshots or changing any resources.
    $state = Read-State
    $originalPath = Join-Path $script:Resources 'app.asar'
    $previous = $null
    $previousManifestHash = $null; $previousLoaderHash = $null
    if ($null -ne $state) {
        $originalPath = Join-Path $script:Resources '_app.asar'; $previous = $state.version
        $previousManifestHash = $state.manifestHash; $previousLoaderHash = $state.loaderHash
    }
    $original = [IO.File]::ReadAllBytes($originalPath)
    $config = Json-Bytes (Make-Config $version)
    $newState = [ordered]@{schema=1;product='SupportTemplates';channel=$script:ChannelName;resources=$script:Resources;version=$version;previousVersion=$previous;previousManifestHash=$previousManifestHash;previousLoaderHash=$previousLoaderHash;loaderHash=$package.LoaderHash;manifestHash=$manifestHash;originalHash=(Hash-Bytes $original);originalSize=$original.Length;configHash=(Hash-Bytes $config)}
    if ($null -ne $oldOverlayVersion -or $null -ne (Read-RendererOverlay $version)) {
        Atomic-RendererFile (Join-Path $script:ChannelRoot 'renderer-cleanup.json') (Json-Bytes ([ordered]@{schema=1;version=$version;manifestHash=$manifestHash;oldVersion=$oldOverlayVersion}))
    }
    Transact @{'_app.asar'=$original;'app.asar'=[IO.File]::ReadAllBytes($package.Files['payload/loader.asar']);'support-templates.json'=$config;'support-templates.install.json'=(Json-Bytes $newState)}
    # Keep the current UI intact if validation or the resource transaction fails.
    # Successful full installs also clear an overlay retained by a prior uninstall.
    Complete-RendererCleanup (Read-State)
    Write-Output "$Action complete: SupportTemplates $version ($script:ChannelName). Restart Discord yourself when ready."
}
catch {
    [Console]::Error.WriteLine("SupportTemplates: {0}", $_.Exception.Message)
    exit 1
}
finally {
    if ($script:Locked -and $null -ne $script:Mutex) { $script:Mutex.ReleaseMutex() }
    if ($null -ne $script:Mutex) { $script:Mutex.Dispose() }
}
