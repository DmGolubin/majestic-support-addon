# Fixture-only end-to-end tests. No network and no real Discord paths or processes.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
. (Join-Path $PSScriptRoot '../standalone/runtime/update-helper.ps1')
Add-Type -AssemblyName System.IO.Compression
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-installer-tests-' + [guid]::NewGuid().ToString('N'))
$fixtureLocal = Join-Path $testRoot 'localappdata'
$originalLocal = $env:LOCALAPPDATA
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Put($file, $text) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null; [IO.File]::WriteAllText($file, $text, $utf8) }
function Test($name, [scriptblock]$body) { & $body; $script:passed++; Write-Output "PASS $name" }
function Reject([scriptblock]$body, $pattern) {
    $caught = $false
    try { & $body | Out-Null } catch { $caught = $true; Assert ($_.Exception.Message -match $pattern) "Unexpected rejection: $_" }
    Assert $caught 'Expected rejection'
}
function New-OriginalAsar($file) {
    $pkg = $utf8.GetBytes('{"name":"discord","main":"index.js"}')
    $js = $utf8.GetBytes('module.exports = {};')
    $header = $utf8.GetBytes((@{files=@{'package.json'=@{size=$pkg.Length;offset='0'};'index.js'=@{size=$js.Length;offset=[string]$pkg.Length}}} | ConvertTo-Json -Depth 8 -Compress))
    $padding = [int]([Math]::Ceiling(($header.Length + 4) / 4.0) * 4)
    $stream = New-Object IO.MemoryStream; $writer = New-Object IO.BinaryWriter($stream)
    $writer.Write([uint32]4); $writer.Write([uint32]($padding + 4)); $writer.Write([uint32]$padding); $writer.Write([uint32]$header.Length); $writer.Write($header)
    for ($i = $header.Length + 4; $i -lt $padding; $i++) { $writer.Write([byte]0) }
    $writer.Write($pkg); $writer.Write($js)
    [IO.File]::WriteAllBytes($file, $stream.ToArray()); $writer.Dispose(); $stream.Dispose()
}
function Package($directory, $version) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Copy-Item -Path (Join-Path $PSScriptRoot '../standalone/installer/*') -Destination $directory -Recurse
    Put (Join-Path $directory 'payload/loader.asar') ('loader ' + $version)
    foreach ($name in @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')) { Put (Join-Path $directory ('payload/runtime/' + $name)) ($name + ' ' + $version) }
    $files = @(Get-ChildItem -LiteralPath (Join-Path $directory 'payload') -Recurse -File | ForEach-Object {
        @{path=$_.FullName.Substring($directory.Length + 1).Replace('\','/');size=$_.Length;sha256=(Update-Hash $_.FullName)}
    })
    Put (Join-Path $directory 'manifest.json') (@{schema=1;product='SupportTemplates';version=$version;upstreamCommit=('a'*40);files=$files} | ConvertTo-Json -Depth 10)
}
function Zip-Package($package, $file, $version, [string]$extra = '', [int]$attributes = 0) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
    $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew)
    $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        $prefix = 'SupportTemplates-' + $version + '/'
        $zip.CreateEntry($prefix) | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $package -Recurse -File) {
            $entry = $zip.CreateEntry($prefix + $item.FullName.Substring($package.Length + 1).Replace('\','/'))
            $out = $entry.Open(); $bytes = [IO.File]::ReadAllBytes($item.FullName)
            try { $out.Write($bytes, 0, $bytes.Length) } finally { $out.Dispose() }
        }
        if ($extra) {
            $entry = $zip.CreateEntry($extra); $entry.ExternalAttributes = $attributes
            $out = $entry.Open(); try { $out.WriteByte(1) } finally { $out.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    return [pscustomobject]@{schema=1;variant='standalone';channel='canary';releaseChannel='canary';repository='owner/releases';currentVersion='0.1.0-canary.14';parentPid=999999;version=$version;assetPath=$file;size=(Get-Item -LiteralPath $file).Length;sha256=(Update-Hash $file)}
}
# Deliberately shadow process enumeration only in this test's PowerShell scope.
# All installer destinations are also bound to the fresh TEMP LOCALAPPDATA below.
function Get-Process { param($Id, $Name, $ErrorAction) return @() }
try {
    [IO.Directory]::CreateDirectory($fixtureLocal) | Out-Null
    $env:LOCALAPPDATA = $fixtureLocal
    $resources = Join-Path $fixtureLocal 'DiscordCanary/app-1.0.9/resources'
    [IO.Directory]::CreateDirectory($resources) | Out-Null
    New-OriginalAsar (Join-Path $resources 'app.asar')
    Put (Join-Path (Split-Path $resources -Parent) 'DiscordCanary.exe') 'Fixture only; never executed'
    $basePackage = Join-Path $testRoot 'package'
    Package $basePackage '0.1.0-canary.14'
    & (Join-Path $basePackage 'SupportTemplates.ps1') -Action Install -Channel Canary | Out-Null
    Assert $? 'Baseline fixture install failed'
    $channelRoot = Join-Path $fixtureLocal 'SupportTemplates/channels/canary'
    $cache = Join-Path $channelRoot 'auto-updates'
    $nextPackage = Join-Path $testRoot 'next-package'; Package $nextPackage '0.1.0-canary.15'
    $request = Zip-Package $nextPackage (Join-Path $cache 'stage/update.zip') '0.1.0-canary.15'

    Test 'numeric prerelease comparison and build metadata' {
        Assert ((Compare-UpdateVersion '0.1.0-canary.10' '0.1.0-canary.9') -gt 0) 'Lexical downgrade'
        Assert ((Compare-UpdateVersion '0.1.0-canary.15+abc' '0.1.0-canary.15') -eq 0) 'Build metadata'
        Assert ((Compare-UpdateVersion '0.1.0' '0.1.0-canary.15') -gt 0) 'Final version'
    }
    Test 'full ZIP extraction accepts the top directory entry' {
        $out = Expand-VerifiedUpdate $request (Join-Path $cache 'valid-extraction')
        Assert ([IO.File]::Exists((Join-Path $out 'SupportTemplates.ps1'))) 'Installer missing'
    }
    Test 'compact ZIP resolves the nested service directory' {
        $bundle = Join-Path $testRoot 'compact'
        Package (Join-Path $bundle 'SupportTemplates') '1.0.2'
        Put (Join-Path $bundle 'install.bat') '@echo off'
        Put (Join-Path $bundle 'uninstall.bat') '@echo off'
        $compact = Zip-Package $bundle (Join-Path $cache 'compact.zip') '1.0.2'
        $out = Expand-VerifiedUpdate $compact (Join-Path $cache 'compact-extraction')
        Assert ((Split-Path $out -Leaf) -ceq 'SupportTemplates') 'Wrong service directory'
        Assert ([IO.File]::Exists((Join-Path $out 'SupportTemplates.ps1'))) 'Nested installer missing'
        Assert ([IO.File]::Exists((Join-Path $out 'manifest.json'))) 'Nested manifest missing'
    }
    Test 'ambiguous flat and nested manifests are rejected' {
        $bundle = Join-Path $testRoot 'ambiguous'
        Package $bundle '1.0.2'
        Package (Join-Path $bundle 'SupportTemplates') '1.0.2'
        $ambiguous = Zip-Package $bundle (Join-Path $cache 'ambiguous.zip') '1.0.2'
        Reject { Expand-VerifiedUpdate $ambiguous (Join-Path $cache 'ambiguous-extraction') } 'Ambiguous package'
    }
    Test 'corrupted ZIP rejected before extraction' {
        $bad = $request | Select-Object *; $bad.sha256 = '0' * 64
        $target = Join-Path $cache 'bad-hash'
        Reject { Expand-VerifiedUpdate $bad $target } 'SHA256'
        Assert (-not (Test-Path -LiteralPath $target)) 'Extraction began before verification'
    }
    foreach ($badName in @('SupportTemplates-0.1.0-canary.15/../escape', 'SupportTemplates-0.1.0-canary.15/NUL.txt', 'SupportTemplates-0.1.0-canary.15/manifest.json', 'Other-root/file')) {
        Test "reject unsafe entry $badName" {
            $bad = Zip-Package $nextPackage (Join-Path $cache ([guid]::NewGuid().ToString('N') + '.zip')) '0.1.0-canary.15' $badName
            Reject { Expand-VerifiedUpdate $bad (Join-Path $cache ([guid]::NewGuid().ToString('N'))) } 'archive|Archive|Duplicate'
        }
    }
    Test 'reject ZIP symlink' {
        $bad = Zip-Package $nextPackage (Join-Path $cache 'link.zip') '0.1.0-canary.15' 'SupportTemplates-0.1.0-canary.15/link' (-1610612736)
        Reject { Expand-VerifiedUpdate $bad (Join-Path $cache 'link-output') } 'link|special'
    }
    Test 'hidden helper installs verified package and acknowledges shared pending only after success' {
        $pending = @{schema=1;id='fixture';variant='standalone';manifest=@{repository='owner/releases';channel='canary';version=$request.version;assets=@(@{variant='standalone';sha256=$request.sha256})}}
        Put (Join-Path $cache 'pending.json') ($pending | ConvertTo-Json -Depth 8)
        $handoff = Join-Path $cache 'handoff/request.json'; Put $handoff ($request | ConvertTo-Json)
        Invoke-StandaloneUpdate $handoff
        $state = Get-InstalledUpdateState $fixtureLocal 'canary'
        Assert ($state.version -ceq '0.1.0-canary.15') 'Update was not installed'
        Assert (-not [IO.File]::Exists((Join-Path $cache 'pending.json'))) 'Pending not acknowledged'
        $receipt = [IO.File]::ReadAllText((Join-Path $cache 'applied.json')) | ConvertFrom-Json
        Assert ($receipt.version -ceq $state.version -and $receipt.repository -ceq 'owner/releases') 'Wrong receipt'
    }
    Test 'manual newer installation while helper was waiting cannot be downgraded' {
        $manual = Join-Path $testRoot 'manual'; Package $manual '0.1.0-canary.16'
        & (Join-Path $manual 'SupportTemplates.ps1') -Action Install -Channel Canary | Out-Null
        Invoke-StandaloneUpdate (Join-Path $cache 'handoff/request.json')
        Assert ((Get-InstalledUpdateState $fixtureLocal 'canary').version -ceq '0.1.0-canary.16') 'Downgraded newer installation'
    }
    Test 'receipt never removes a newer concurrently staged pending record' {
        Put (Join-Path $cache 'pending.json') (@{variant='standalone';manifest=@{version='0.1.0-canary.17';repository='owner/releases';channel='canary';assets=@(@{variant='standalone';sha256=('f'*64)})}} | ConvertTo-Json -Depth 8)
        Write-UpdateReceipt $request $cache
        Assert ([IO.File]::Exists((Join-Path $cache 'pending.json'))) 'Newer pending was removed'
    }
    Write-Output "Passed $passed standalone automatic updater fixture tests. No real host mutation."
} finally {
    $env:LOCALAPPDATA = $originalLocal
    $resolved = [IO.Path]::GetFullPath($testRoot)
    Assert ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf) -cmatch '^SupportTemplates-installer-tests-[a-f0-9]{32}$') 'Unsafe fixture cleanup'
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
