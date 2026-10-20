# PS5.1, fixture-only. The download boundary is mocked; no network or Discord access.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Add-Type -AssemblyName System.IO.Compression
$repo = Split-Path $PSScriptRoot -Parent
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-package-tests-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
function Put($path, $text) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.File]::WriteAllText($path, $text, $utf8)
}
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Reject([scriptblock]$body, $pattern = '.') {
    $caught = $false
    try { & $body | Out-Null } catch {
        $caught = $true
        Assert ($_.Exception.Message -match $pattern) "Unexpected rejection: $_"
    }
    Assert $caught 'Expected rejection'
}
function Test($name, [scriptblock]$body) {
    Reset-Scenario
    & $body
    $script:passed++
    Write-Output "PASS $name"
}
function New-Zip([string]$version, [string]$extra = '', [bool]$nested = $true) {
    $stream = New-Object IO.MemoryStream
    $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        $prefix = "SupportTemplates-$version/"
        $package = $prefix
        if ($nested) { $package += 'SupportTemplates/' }
        $files = @{
            ($package + 'manifest.json') = (@{schema=1;product='SupportTemplates';version=$version;files=@()} | ConvertTo-Json)
            ($package + 'SupportTemplates.ps1') = "# fixture native $version, never executed"
            ($package + 'RendererUpdate.ps1') = '# fixture renderer'
            ($prefix + 'install.bat') = '@echo fixture, never executed'
            ($prefix + 'uninstall.bat') = '@echo fixture, never executed'
        }
        if ($extra) { $files[$extra] = 'unsafe fixture' }
        foreach ($name in $files.Keys) {
            $entry = $zip.CreateEntry($name)
            $output = $entry.Open()
            try { $bytes = $utf8.GetBytes($files[$name]); $output.Write($bytes, 0, $bytes.Length) }
            finally { $output.Dispose() }
        }
    } finally { $zip.Dispose() }
    try { return ,$stream.ToArray() } finally { $stream.Dispose() }
}
function Set-Offer([string]$version = '1.0.2', [string]$extra = '', [bool]$nested = $true) {
    $script:zipBytes = New-Zip $version $extra $nested
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $sha = ([BitConverter]::ToString($hash.ComputeHash($script:zipBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    $script:manifest = @{schema=1;product='SupportTemplates';repository=$script:PackageRepository;channel='stable';version=$version;
        assets=@(@{variant='standalone';platform='win32';kind='native';name="SupportTemplates-standalone-$version.zip";sha256=$sha;size=$script:zipBytes.Length},
            @{variant='betterdiscord';platform='win32';kind='renderer';name='SupportTemplates.plugin.js';sha256=('a'*64);size=10})}
    $script:release = @{tag_name="v$version";draft=$false;prerelease=$false;published_at='2026-10-20T12:00:00Z';
        html_url="https://github.com/$script:PackageRepository/releases/tag/v$version";assets=@(
            @{name=$script:PackageManifestName;size=1;state='uploaded';browser_download_url=(Get-PackageDownloadUrl $version $script:PackageManifestName)},
            @{name="SupportTemplates-standalone-$version.zip";size=$script:zipBytes.Length;state='uploaded';browser_download_url=(Get-PackageDownloadUrl $version "SupportTemplates-standalone-$version.zip")})}
}
function Reset-Scenario {
    $script:caseCache = Join-Path $fixtureRoot ([guid]::NewGuid().ToString('N'))
    $script:requests = New-Object 'System.Collections.Generic.List[string]'
    $script:installs = New-Object 'System.Collections.Generic.List[string]'
    $script:nativeActions = New-Object 'System.Collections.Generic.List[string]'
    $script:offline = $false; $script:badDownload = $false; $script:installerFails = $false
    $script:expectedInvalidSelection = $null
    Set-Offer
}
try {
    $bundle = Join-Path $fixtureRoot 'bundle/SupportTemplates'
    Put (Join-Path $bundle 'manifest.json') '{"schema":1,"product":"SupportTemplates","version":"1.0.1"}'
    Put (Join-Path $bundle 'payload/runtime/update-config.json') '{"schema":1,"version":"1.0.1","channel":"stable","releaseRepository":"DmGolubin/majestic-support-addon","manifestAsset":"support-templates-update.json"}'
    Put (Join-Path $bundle 'SupportTemplates.ps1') '# fixture bundled native'
    Copy-Item -LiteralPath (Join-Path $repo 'standalone/runtime/update-helper.ps1') -Destination (Join-Path $bundle 'payload/runtime/update-helper.ps1')
    Copy-Item -LiteralPath (Join-Path $repo 'standalone/installer/PackageUpdate.ps1') -Destination (Join-Path $bundle 'PackageUpdate.ps1')
    . (Join-Path $bundle 'PackageUpdate.ps1')
    # Replace only the transport boundary and explicit native dispatch. All JSON,
    # identity, hash, ZIP, cache and selection logic remains production code.
    $realDownload = ${function:Receive-PackageDownload}
    function Receive-PackageDownload([string]$Url, [long]$Limit, [string]$OutputPath = '') {
        $script:requests.Add($Url)
        if ($null -ne $script:expectedInvalidSelection) {
            # Check while recovery is in progress, before its finally block can
            # run: killing the process here must not enable bundled fallback.
            Assert ([IO.File]::Exists($script:expectedInvalidSelection)) 'Recovery removed selection before verified replacement'
            Assert ([IO.File]::ReadAllText($script:expectedInvalidSelection) -ceq '{broken') 'Recovery changed selection before verification'
        }
        if ($script:offline) { throw 'HTTP 404 / offline fixture' }
        $manifestBytes = $utf8.GetBytes(($script:manifest | ConvertTo-Json -Depth 20 -Compress))
        $script:release.assets[0].size = $manifestBytes.Length
        if ($Url -ceq "https://api.github.com/repos/$script:PackageRepository/releases/latest") {
            return ,$utf8.GetBytes(($script:release | ConvertTo-Json -Depth 20 -Compress))
        }
        if ($Url -ceq $script:release.assets[0].browser_download_url) { return ,$manifestBytes }
        Assert ($Url -ceq $script:release.assets[1].browser_download_url -and $OutputPath) 'Unexpected download'
        $bytes = $script:zipBytes
        if ($script:badDownload) { $bytes = [byte[]]@(1,2,3) }
        [IO.File]::WriteAllBytes($OutputPath, $bytes)
    }
    function Invoke-PackageInstaller([string]$Package, [string]$TargetChannel, [string]$NativeAction = 'Install') {
        Assert ($TargetChannel -cin @('Stable','Canary')) 'Invalid dispatch channel'
        $script:installs.Add($Package)
        $script:nativeActions.Add($NativeAction)
        Assert ([IO.File]::ReadAllText((Join-Path $Package 'SupportTemplates.ps1')) -like '# fixture*') 'Mutated script reached dispatch'
        if ($script:installerFails) { throw 'Native installer fixture failed' }
    }

    Test 'Check uses two metadata requests, reports availability, never downloads or executes ZIP' {
        $status = Invoke-PackageUpdate Check '' $caseCache | ConvertFrom-Json
        Assert ($status.updateAvailable -and $status.selectedVersion -ceq '1.0.1' -and $status.latestVersion -ceq '1.0.2') 'Wrong check result'
        Assert ($requests.Count -eq 2 -and $installs.Count -eq 0) 'Unexpected side effect'
        Assert (-not [IO.File]::Exists((Join-Path $caseCache 'selected.json'))) 'Check selected package'
    }
    Test 'Resolve and explicit Install use bundled package offline when no cache exists' {
        $script:offline = $true
        Assert ((Invoke-PackageUpdate Resolve '' $caseCache) -ceq $bundle) 'Wrong bundled resolution'
        Invoke-PackageUpdate Install Stable $caseCache
        Assert ($requests.Count -eq 0 -and $installs.Count -eq 1 -and $installs[0] -ceq $bundle) 'Unexpected offline dispatch'
    }
    Test 'Install requires an explicit host channel before resolving or dispatching' {
        Reject { Invoke-PackageUpdate Install '' $caseCache } 'Choose Stable or Canary'
        Assert ($requests.Count -eq 0 -and $installs.Count -eq 0) 'Implicit install'
    }
    Test 'Update validates nested package and stores original ZIP and metadata without executing' {
        $status = Invoke-PackageUpdate Update '' $caseCache | ConvertFrom-Json
        Assert ($status.selectedVersion -ceq '1.0.2' -and -not $status.updateAvailable) 'Update did not select'
        Assert ($requests.Count -eq 3 -and $installs.Count -eq 0) 'Unexpected execution'
        $selected = Get-PackageSelection $caseCache (Get-PackageContext)
        Assert ((Update-Hash $selected.archive) -ceq $selected.offer.sha256) 'Original ZIP missing'
    }
    Test 'Install reextracts original ZIP and ignores previously mutated extracted scripts' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $first = Invoke-PackageUpdate Resolve '' $caseCache
        Put (Join-Path $first 'SupportTemplates.ps1') 'MUTATED SCRIPT'
        $script:offline = $true
        Invoke-PackageUpdate Install Canary $caseCache
        Assert ($installs.Count -eq 1 -and $installs[0] -cne $first -and $requests.Count -eq 3) 'Did not reverify offline'
    }
    Test 'Cache ZIP mutation fails closed before native dispatch' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $selected = Get-PackageSelection $caseCache (Get-PackageContext)
        [IO.File]::WriteAllBytes($selected.archive, [byte[]]@(1,2,3))
        Reject { Invoke-PackageUpdate Install Stable $caseCache } 'size mismatch'
        Assert ($installs.Count -eq 0) 'Corrupt ZIP executed'
    }
    Test 'Update repairs a corrupted selected ZIP and keeps selection unchanged on failed replacement' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $selected = Get-PackageSelection $caseCache (Get-PackageContext)
        $selectionPath = Join-Path $caseCache 'selected.json'
        $saved = [IO.File]::ReadAllText($selectionPath)
        $corrupted = [byte[]]$script:zipBytes.Clone(); $corrupted[0] = $corrupted[0] -bxor 255
        [IO.File]::WriteAllBytes($selected.archive, $corrupted)
        $script:badDownload = $true
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'SHA256'
        Assert ([IO.File]::ReadAllText($selectionPath) -ceq $saved) 'Failed repair altered metadata'
        Reject { Invoke-PackageUpdate Install Stable $caseCache }
        Assert ($installs.Count -eq 0) 'Failed replacement dispatched'
        $script:badDownload = $false
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Assert ((Update-Hash $selected.archive) -ceq $selected.offer.sha256) 'Cache not repaired'
        Invoke-PackageUpdate Install Stable $caseCache
        Assert ($installs.Count -eq 1) 'Repaired package unavailable'
    }
    Test 'Verification and successful or failed Install clean only owned temporary extractions' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Directory).Count -eq 0) 'Update retained extraction'
        Invoke-PackageUpdate Install Stable $caseCache
        Invoke-PackageUpdate Install Canary $caseCache
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Directory).Count -eq 0) 'Install retained extraction'
        $script:installerFails = $true
        Reject { Invoke-PackageUpdate Install Stable $caseCache } 'Native installer fixture failed'
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Directory).Count -eq 0) 'Failed install retained extraction'
        Reject { Remove-PackageExtraction $bundle $caseCache } 'outside package cache'
        Assert ([IO.File]::Exists((Join-Path $bundle 'manifest.json'))) 'Cleanup escaped owned extraction'
    }
    Test 'Repair selects the verified cached version offline and dispatches native Repair explicitly' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $script:offline = $true
        Invoke-PackageUpdate Repair Stable $caseCache
        Assert ($installs.Count -eq 1 -and $installs[0] -cne $bundle -and $nativeActions[0] -ceq 'Repair') 'Repair used bundled or Install action'
        Assert ($requests.Count -eq 3 -and @(Get-ChildItem -LiteralPath $caseCache -Directory).Count -eq 0) 'Repair network or extraction leak'
        $selected = Get-PackageSelection $caseCache (Get-PackageContext)
        [IO.File]::WriteAllBytes($selected.archive, [byte[]]@(1))
        Reject { Invoke-PackageUpdate Repair Stable $caseCache } 'size mismatch'
        Assert ($installs.Count -eq 1) 'Corrupt Repair dispatched'
    }
    Test 'Malformed selection recovers only through explicit trusted Update' {
        [IO.Directory]::CreateDirectory($caseCache) | Out-Null
        $path = Join-Path $caseCache 'selected.json'
        Put $path '{broken'
        $script:expectedInvalidSelection = $path
        foreach ($operation in @('Check','Install','Repair')) {
            Reject { Invoke-PackageUpdate $operation Stable $caseCache }
        }
        Assert ($requests.Count -eq 0 -and $installs.Count -eq 0) 'Invalid selection bypassed'
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Assert ((Get-PackageSelection $caseCache (Get-PackageContext)).offer.version -ceq '1.0.2') 'Recovery did not verify newer selection'
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Filter 'selected-invalid-*.json').Count -eq 1) 'Invalid metadata not quarantined'
        Invoke-PackageUpdate Repair Stable $caseCache
        Assert ($nativeActions[0] -ceq 'Repair') 'Recovered Repair unavailable'
    }
    Test 'Failed metadata recovery never removes invalid selection and leaves Install and Repair fail-closed' {
        [IO.Directory]::CreateDirectory($caseCache) | Out-Null
        $path = Join-Path $caseCache 'selected.json'
        Put $path '{broken'
        $script:expectedInvalidSelection = $path
        $script:offline = $true
        Reject { Invoke-PackageUpdate Update '' $caseCache } '404'
        Assert ([IO.File]::ReadAllText($path) -ceq '{broken') 'Failed recovery erased invalid selection'
        Reject { Invoke-PackageUpdate Install Stable $caseCache }
        Reject { Invoke-PackageUpdate Repair Stable $caseCache }
        Assert ($installs.Count -eq 0) 'Failed recovery enabled bundled fallback'
        $script:offline = $false; $script:badDownload = $true
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'SHA256'
        Assert ([IO.File]::ReadAllText($path) -ceq '{broken') 'Failed archive recovery erased invalid selection'
    }
    Test 'Recovery at the bundled version replaces invalid metadata only after trusted archive verification' {
        [IO.Directory]::CreateDirectory($caseCache) | Out-Null
        $path = Join-Path $caseCache 'selected.json'
        Put $path '{broken'
        $script:expectedInvalidSelection = $path
        Set-Offer '1.0.1'
        $status = Invoke-PackageUpdate Update '' $caseCache | ConvertFrom-Json
        Assert (-not $status.updateAvailable -and $requests.Count -eq 3) 'Recovery skipped archive verification'
        Assert ((Read-PackageJson $path).manifest.version -ceq '1.0.1') 'No-newer-version recovery did not replace metadata'
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Filter 'selected-invalid-*.json').Count -eq 1) 'Invalid metadata copy missing'
        Invoke-PackageUpdate Install Stable $caseCache
        Assert ($installs.Count -eq 1 -and $installs[0] -ceq $bundle) 'Validated bundled fallback unavailable'
    }
    Test '404 or offline failure retains a prior verified cache usable offline' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $saved = [IO.File]::ReadAllText((Join-Path $caseCache 'selected.json'))
        $script:offline = $true
        Reject { Invoke-PackageUpdate Check '' $caseCache } '404'
        Reject { Invoke-PackageUpdate Update '' $caseCache } '404'
        Assert ([IO.File]::ReadAllText((Join-Path $caseCache 'selected.json')) -ceq $saved) 'Failed update altered selection'
        Invoke-PackageUpdate Install Stable $caseCache
        Assert ($installs.Count -eq 1) 'Cached offline install unavailable'
    }
    Test 'Older remote release cannot replace cached newer package' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Set-Offer '1.0.0'
        $status = Invoke-PackageUpdate Update '' $caseCache | ConvertFrom-Json
        Assert ($status.selectedVersion -ceq '1.0.2' -and -not $status.updateAvailable -and $requests.Count -eq 5) 'Downgrade or ZIP fetch'
    }
    Test 'Same release is not downloaded twice' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Assert ($requests.Count -eq 5) 'Repeated ZIP download'
    }
    Test 'Truncated or corrupted download does not publish selection or execute' {
        $script:badDownload = $true
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'size or SHA256'
        Assert (-not [IO.File]::Exists((Join-Path $caseCache 'selected.json')) -and $installs.Count -eq 0) 'Corrupt package selected'
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Filter '*.tmp').Count -eq 0) 'Partial download retained'
    }
    Test 'Wrong SHA256 fails before extraction even when byte count matches' {
        $script:manifest.assets[0].sha256 = '0' * 64
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'SHA256'
        Assert (@(Get-ChildItem -LiteralPath $caseCache -Directory).Count -eq 0) 'Unverified bytes extracted'
    }
    foreach ($path in @('SupportTemplates-1.0.2/../escape.ps1', 'SupportTemplates-1.0.2/NUL.txt', 'Other-root/execute.ps1')) {
        Test "Reject unsafe ZIP $path even with a matching advertised checksum" {
            Set-Offer '1.0.2' $path
            Reject { Invoke-PackageUpdate Update '' $caseCache } 'archive|Archive'
            Assert (-not [IO.File]::Exists((Join-Path $caseCache 'selected.json')) -and $installs.Count -eq 0) 'Unsafe ZIP selected'
        }
    }
    Test 'Old flat package layout remains accepted' {
        Set-Offer '1.0.2' '' $false
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $path = Invoke-PackageUpdate Resolve '' $caseCache
        Assert ((Split-Path $path -Leaf) -ceq 'SupportTemplates-1.0.2') 'Legacy layout not selected'
    }
    Test 'Ambiguous flat plus nested package is rejected' {
        Set-Offer '1.0.2' 'SupportTemplates-1.0.2/manifest.json'
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'ambiguous|Ambiguous'
    }
    foreach ($change in @('draft','prerelease','repository','tag','download','duplicate','manifest','full')) {
        Test "Reject invalid release or manifest: $change" {
            switch ($change) {
                draft { $script:release.draft = $true }
                prerelease { $script:release.prerelease = $true }
                repository { $script:release.html_url = 'https://github.com/other/repo/releases/tag/v1.0.2' }
                tag { $script:release.tag_name = 'v1.0.2-canary.1' }
                download { $script:release.assets[1].browser_download_url = 'https://github.com/other/repo/releases/download/v1.0.2/x.zip' }
                duplicate { $script:release.assets += $script:release.assets[1] }
                manifest { $script:manifest.version = '1.0.3' }
                full { $script:manifest.assets[1].variant = 'vencord' }
            }
            Reject { Invoke-PackageUpdate Update '' $caseCache }
            Assert (-not [IO.File]::Exists((Join-Path $caseCache 'selected.json')) -and $installs.Count -eq 0) 'Invalid release accepted'
        }
    }
    Test 'Malformed cached metadata and path traversal cannot dispatch' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $path = Join-Path $caseCache 'selected.json'
        $saved = Read-PackageJson $path
        $saved.archive = '../outside.zip'
        Put $path ($saved | ConvertTo-Json -Depth 30)
        Reject { Invoke-PackageUpdate Install Stable $caseCache } 'cached archive path'
        Put $path '{broken'
        Reject { Invoke-PackageUpdate Install Stable $caseCache }
        Assert ($installs.Count -eq 0) 'Malformed cache dispatched'
    }
    Test 'Redirect policy refuses HTTP, credentials, API redirects and unknown hosts' {
        $asset = Get-PackageDownloadUrl '1.0.2' 'x.zip'
        foreach ($url in @('http://github.com/x', 'https://user:secret@release-assets.githubusercontent.com/x', 'https://evil.example/x', 'https://github.com/other/repo/x')) {
            Reject { Assert-PackageUrl $url $asset $true }
        }
        Reject { Assert-PackageUrl 'https://release-assets.githubusercontent.com/x' "https://api.github.com/repos/$script:PackageRepository/releases/latest" $true }
        Assert-PackageUrl 'https://release-assets.githubusercontent.com/x?signature=fixture' $asset $true
        # Exercise actual transport preflight without issuing a network request.
        Reject { & $realDownload 'http://invalid.example/' 100 } 'Unsafe update URL'
    }
    Test 'No update helper code executes downloaded BAT files' {
        $source = [IO.File]::ReadAllText((Join-Path $bundle 'PackageUpdate.ps1'))
        Assert ($source -notmatch 'cmd(\.exe)?\s+/c|Start-Process|Invoke-Expression') 'Shell execution introduced'
    }
    Write-Output "PASS $passed package updater tests (offline, Windows PowerShell $($PSVersionTable.PSVersion))"
} finally {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $resolved -Leaf) -like 'SupportTemplates-package-tests-*' -and [IO.Directory]::Exists($resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
