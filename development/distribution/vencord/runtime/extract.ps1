# GPL-3.0-or-later. Extract only into a new, private staging directory.
param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { throw 'Extraction target already exists' }
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$cursor = Split-Path $root -Parent
while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected extraction target' }
    $cursor = Split-Path $cursor -Parent
}
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $seen = @{}; $total = 0L
    if ($zip.Entries.Count -gt 12000) { throw 'Too many ZIP entries' }
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        if ($name -notmatch '^[A-Za-z0-9_+@./-]+$' -or $name.StartsWith('/')) { throw 'Invalid ZIP path' }
        foreach ($part in $name.TrimEnd('/').Split('/')) {
            if (-not $part -or $part -in @('.', '..') -or $part.EndsWith('.') -or $part -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)') { throw 'Unsafe ZIP segment' }
        }
        if ($seen.ContainsKey($name.TrimEnd('/'))) { throw 'Duplicate ZIP entry' }
        $seen[$name.TrimEnd('/')] = $true
        # Unix symlinks and other special entries are never materialized.
        $kind = ($entry.ExternalAttributes -shr 16) -band 61440
        if ($kind -notin @(0, 16384, 32768)) { throw 'Special ZIP entry' }
        $total += $entry.Length
        if ($total -gt 536870912 -or $entry.Length -gt 268435456) { throw 'ZIP expansion exceeds limit' }
    }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $root $entry.FullName))
        if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP path escapes target' }
        if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
