# PS5.1, fixture-only. The download boundary is mocked; no network or Discord access.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Add-Type -AssemblyName System.IO.Compression
$repo = Split-Path $PSScriptRoot -Parent
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-package-tests-' + [guid]::NewGuid().ToString('N'))
$utf8 = New-Object Text.UTF8Encoding($false)
$passed = 0
$webResponseSource = @'
public sealed class PackageFixtureResponse : System.Net.WebResponse {
    public System.Net.HttpStatusCode StatusCode { get; private set; }
    public PackageFixtureResponse(int status) { StatusCode = (System.Net.HttpStatusCode)status; }
}
'@
Add-Type -TypeDefinition $webResponseSource
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
    $script:nativeChannels = New-Object 'System.Collections.Generic.List[string]'
    $script:nativeReplacements = New-Object 'System.Collections.Generic.List[string]'
    $script:offline = $false; $script:badDownload = $false; $script:installerFails = $false
    $script:expectedInvalidSelection = $null
    $script:networkFailure = $null
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
    $realInstaller = ${function:Invoke-PackageInstaller}
    function Receive-PackageDownload([string]$Url, [long]$Limit, [string]$OutputPath = '') {
        $script:requests.Add($Url)
        if ($null -ne $script:networkFailure) { throw $script:networkFailure }
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
    function Invoke-PackageInstaller([string]$Package, [string]$TargetChannel, [string]$NativeAction = 'Install', [string]$Replacement = '') {
        Assert ($TargetChannel -cin @('Stable','Canary','PTB')) 'Invalid dispatch channel'
        $script:installs.Add($Package)
        $script:nativeActions.Add($NativeAction)
        $script:nativeChannels.Add($TargetChannel)
        $script:nativeReplacements.Add($Replacement)
        Assert ([IO.File]::ReadAllText((Join-Path $Package 'SupportTemplates.ps1')) -like '# fixture*') 'Mutated script reached dispatch'
        if ($script:installerFails) { throw 'Native installer fixture failed' }
        if ($NativeAction -eq 'Inspect') { return (@{channel=$TargetChannel;kind='vencord';canReplace=$true} | ConvertTo-Json -Compress) }
    }

    Test 'Inspect uses selected validated cache offline and cleans extraction before explicit replacement' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $first = Invoke-PackageUpdate Resolve '' $caseCache
        Put (Join-Path $first 'SupportTemplates.ps1') 'MUTATED SCRIPT'
        $script:offline = $true
        $result = Invoke-PackageUpdate Inspect PTB $caseCache | ConvertFrom-Json
        Assert ($result.kind -ceq 'vencord' -and $result.channel -ceq 'PTB' -and $result.canReplace) 'Inspection JSON lost'
        Assert ($installs[0] -cne $bundle -and $installs[0] -cne $first -and -not [IO.Directory]::Exists($installs[0])) 'Inspection did not reverify and clean selected cache'
        Invoke-PackageUpdate Install PTB $caseCache vencord
        Assert (($nativeActions -join ',') -ceq 'Inspect,Install' -and $nativeReplacements[0] -ceq '' -and $nativeReplacements[1] -ceq 'vencord' -and $requests.Count -eq 3) 'Wrong replacement dispatch'
    }
    Test 'Inspect corrupt selected cache fails before native execution' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $selected = Get-PackageSelection $caseCache (Get-PackageContext)
        [IO.File]::WriteAllBytes($selected.archive, [byte[]]@(1,2,3))
        Reject { Invoke-PackageUpdate Inspect Stable $caseCache } 'size mismatch'
        Assert ($installs.Count -eq 0) 'Corrupt cache inspected'
    }
    Test 'Replacement is rejected outside explicit Install and unknown values fail closed' {
        foreach ($operation in @('Inspect','Repair','Update','Check','Resolve')) {
            Reject { Invoke-PackageUpdate $operation Stable $caseCache vencord } 'Replacement requires'
        }
        Reject { Invoke-PackageUpdate Install Stable $caseCache 'unknown' } 'Replacement requires'
        Reject { Invoke-PackageUpdate Inspect '' $caseCache } 'Choose Stable'
        Assert ($installs.Count -eq 0 -and $requests.Count -eq 0) 'Invalid request dispatched'
    }
    Test 'Inspection validates channel kind boolean and bounded plain reason' {
        foreach ($raw in @('{broken','[]','[{"channel":"Stable","kind":"none","canReplace":false}]','{"channel":"Canary","kind":"none","canReplace":false}',
            '{"channel":"Stable","kind":"unknown","canReplace":false}',
            '{"channel":"Stable","kind":"vencord","canReplace":"false"}',
            '{"channel":"Stable","kind":"none","canReplace":true}',
            '{"channel":"Stable","kind":"unsupported","canReplace":false,"reason":"bad\nreason"}')) {
            Reject { ConvertTo-PackageInspection $raw Stable } 'Invalid native inspection'
        }
        foreach ($kind in @('none','supporttemplates','vencord','betterdiscord','unsupported')) {
            $raw = @{channel='Stable';kind=$kind;canReplace=($kind -in @('vencord','betterdiscord'))} | ConvertTo-Json -Compress
            Assert ((ConvertTo-PackageInspection $raw Stable | ConvertFrom-Json).kind -ceq $kind) 'Valid inspection rejected'
        }
    }
    Test 'Real subprocess Inspect never closes and explicit replacement forwards only Install' {
        $installer = Join-Path $bundle 'SupportTemplates.ps1'
        $saved = [IO.File]::ReadAllText($installer)
        try {
            Put $installer @'
param([string]$Action,[string]$Channel,[switch]$CloseDiscord,[string]$ReplaceExisting)
if ($Action -eq 'Inspect') {
    if ($CloseDiscord -or $ReplaceExisting) { exit 7 }
    @{channel=$Channel.ToLowerInvariant();kind='betterdiscord';canReplace=$true} | ConvertTo-Json -Compress
    exit 0
}
if ($Action -ne 'Install' -or $ReplaceExisting -cne 'betterdiscord' -or -not $CloseDiscord) { exit 8 }
exit 0
'@
            $CloseDiscord = $true
            foreach ($consoleMode in @($false,$true)) {
                $Console = $consoleMode
                $rawResult = @(& $realInstaller $bundle Canary Inspect)
                Assert ($rawResult.Count -eq 1 -and $rawResult[0] -notmatch '[\r\n]') 'Inspect did not return one compressed JSON object'
                $result = $rawResult[0] | ConvertFrom-Json
                Assert ($result.kind -ceq 'betterdiscord' -and $result.channel -ceq 'Canary') 'Inspect subprocess output changed'
                & $realInstaller $bundle Canary Install betterdiscord | Out-Null
                Reject { & $realInstaller $bundle Canary Repair betterdiscord } 'Replacement requires'
            }
            Put $installer "param([string]`$Action,[string]`$Channel)`nWrite-Output '{broken'; exit 0"
            Reject { & $realInstaller $bundle Canary Inspect } 'Invalid native inspection'
            Put $installer "param([string]`$Action,[string]`$Channel)`nexit 9"
            Reject { & $realInstaller $bundle Canary Inspect } 'Native installer failed'
        } finally { Put $installer $saved; $Console = $false; $CloseDiscord = $false }
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
        Reject { Invoke-PackageUpdate Install '' $caseCache } 'Choose Stable, Canary or PTB'
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
    Test 'PTB Install and Repair use the selected verified cache without network' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $script:offline = $true
        Invoke-PackageUpdate Install PTB $caseCache
        Invoke-PackageUpdate Repair PTB $caseCache
        Assert (($nativeChannels -join ',') -ceq 'PTB,PTB' -and ($nativeActions -join ',') -ceq 'Install,Repair') 'PTB dispatch changed channel or action'
        Assert ($requests.Count -eq 3 -and $installs.Count -eq 2 -and $installs[0] -cne $bundle -and $installs[1] -cne $bundle) 'PTB did not use cache offline'
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
    Test 'Network failure cooldown survives relaunch state, never reports success, and retries after expiry' {
        $response = New-Object PackageFixtureResponse(404)
        $script:networkFailure = New-Object Net.WebException('HTTP 404 fixture', $null, [Net.WebExceptionStatus]::ProtocolError, $response)
        Reject { Invoke-PackageUpdate Update '' $caseCache } '404'
        $marker = Join-Path $caseCache 'network-unavailable.json'
        Assert ([IO.File]::Exists($marker) -and $requests.Count -eq 1) 'Failure cooldown not persisted'
        $first = [IO.File]::ReadAllText($marker)
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'retry cooldown'
        Assert ($requests.Count -eq 1 -and [IO.File]::ReadAllText($marker) -ceq $first) 'Repeated failure retried or extended cooldown'
        Assert (-not [IO.File]::Exists((Join-Path $caseCache 'selected.json'))) 'Failure established selected/current state'
        $record = Read-PackageJson $marker
        $record.retryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1).ToString('o')
        Put $marker ($record | ConvertTo-Json -Compress)
        $script:networkFailure = $null
        $status = Invoke-PackageUpdate Update '' $caseCache | ConvertFrom-Json
        Assert ($requests.Count -eq 4 -and $status.selectedVersion -ceq '1.0.2') 'Automatic retry did not resume after expiry'
    }
    Test 'Network cooldown never blocks offline install or skips local selection validation' {
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        $script:networkFailure = New-Object Net.WebException('DNS fixture', [Net.WebExceptionStatus]::NameResolutionFailure)
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'DNS'
        Invoke-PackageUpdate Install PTB $caseCache
        Assert ($installs.Count -eq 1 -and $requests.Count -eq 4) 'Cooldown blocked offline install'
        Put (Join-Path $caseCache 'selected.json') '{broken'
        Reject { Invoke-PackageUpdate Install PTB $caseCache }
        Assert ($installs.Count -eq 1) 'Cooldown bypassed malformed selection'
    }
    Test 'Integrity failures do not activate cooldown and invalid long-lived markers are ignored' {
        $script:manifest.assets[0].sha256 = '0' * 64
        Reject { Invoke-PackageUpdate Update '' $caseCache } 'SHA256'
        Assert (-not [IO.File]::Exists((Join-Path $caseCache 'network-unavailable.json'))) 'Integrity failure activated network cooldown'
        Set-Offer
        Put (Join-Path $caseCache 'network-unavailable.json') (@{schema=1;repository=$script:PackageRepository;version='1.0.1';kind='network-unavailable';
            retryAfterUtc=[DateTime]::UtcNow.AddDays(1).ToString('o')} | ConvertTo-Json -Compress)
        Invoke-PackageUpdate Update '' $caseCache | Out-Null
        Assert ($requests.Count -eq 6) 'Invalid cooldown blocked retry'
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
    Test 'Console distinguishes wrapped HTTP404, network failure and verified integrity rejection' {
        $response = New-Object PackageFixtureResponse(404)
        $http = New-Object Net.WebException('HTTP 404 fixture', $null, [Net.WebExceptionStatus]::ProtocolError, $response)
        $wrapped = New-Object InvalidOperationException('Invocation wrapper', $http)
        $unavailable = Get-PackageConsoleError $wrapped
        $network = Get-PackageConsoleError (New-Object Net.WebException('DNS fixture', [Net.WebExceptionStatus]::NameResolutionFailure))
        $timeout = Get-PackageConsoleError (New-Object TimeoutException('Timeout fixture'))
        try {
            $script:manifest.assets[0].sha256 = '0' * 64
            Invoke-PackageUpdate Update '' $caseCache | Out-Null
            throw 'Expected archive rejection'
        } catch { $integrity = Get-PackageConsoleError $_.Exception }
        Assert ($unavailable -ceq 'Публичный выпуск пока недоступен. Обновление не загружено.') 'HTTP404 classification lost'
        Assert ($network -match 'Проверьте интернет' -and $timeout -ceq $network) 'Network classification lost'
        Assert ($integrity -match 'проверку целостности или безопасности') 'Integrity classification lost'
        Assert (($unavailable + $network + $integrity) -notmatch '404|SHA256|fixture|https:|Обновление не требуется') 'Technical details or false success exposed'
    }
    Test 'Console successful startup Update reports only the selected version' {
        $status = Invoke-PackageUpdate Update '' $caseCache | ConvertFrom-Json
        $text = @(Write-PackageConsoleResult $status)
        Assert ($text.Count -eq 1 -and $text[0] -ceq 'Готов к установке пакет версии 1.0.2.') 'Verbose or wrong startup result'
        Assert ($installs.Count -eq 0 -and $requests.Count -eq 3) 'Startup update installed or duplicated requests'
    }
    foreach ($nativeCase in @(
        @{error='Target Discord is running (PID 123); close it before retrying';expected='системном трее'},
        @{error='Foreign modloader bootstrap refused';expected='совместимый плагин'},
        @{error='Foreign backup/config without ownership state refused';expected='другой мод или несовместимая установка'},
        @{error='Replacement cannot downgrade the installed package version';expected='Понижение версии отменено'},
        @{error='ReplaceExisting does not match the current installation';expected='Выберите клиент заново'},
        @{error='Install cannot downgrade the installed version; refresh the package first';expected='Понижение версии отменено'}
    )) {
        Test "Console captures native refusal: $($nativeCase.error)" {
            $installer = Join-Path $bundle 'SupportTemplates.ps1'
            $original = [IO.File]::ReadAllText($installer)
            try {
                # This subprocess runs an inert TEMP fixture, never the real installer.
                Put $installer ("# fixture native refusal`nparam([string]`$Action,[string]`$Channel)`n[Console]::Error.WriteLine('SupportTemplates Lite: " + $nativeCase.error + "'); exit 1")
                $Console = $true
                $captured = New-Object 'System.Collections.Generic.List[string]'
                $failure = $null
                try { & $realInstaller $bundle PTB Install | ForEach-Object { $captured.Add([string]$_) } }
                catch { $failure = $_.Exception }
                Assert ($null -ne $failure -and $captured.Count -eq 0) 'Native failure emitted success or raw output'
                $message = Get-PackageConsoleError $failure
                Assert ($message -match $nativeCase.expected -and $message -notmatch 'PID|bootstrap|cannot downgrade|C:\\') 'Native refusal not translated'
            } finally { Put $installer $original }
        }
    }
    Test 'Console translates native success and preserves PTB/action arguments' {
        $installer = Join-Path $bundle 'SupportTemplates.ps1'
        $original = [IO.File]::ReadAllText($installer)
        try {
            Put $installer "# fixture native success`nparam([string]`$Action,[string]`$Channel)`nif (`$Channel -cne 'PTB' -or `$Action -cne 'Repair') { exit 7 }; Write-Output 'Repair complete: fixture with internal path'; exit 0"
            $Console = $true
            $message = @(& $realInstaller $bundle PTB Repair)
            Assert ($message.Count -eq 1 -and $message[0] -ceq 'SupportTemplates восстановлен. Перезапустите Discord.') 'Native success not translated or wrong dispatch'
        } finally { Put $installer $original }
    }
    Test 'CloseDiscord is forwarded only on explicit request for Install or Repair in CLI and Console' {
        $installer = Join-Path $bundle 'SupportTemplates.ps1'
        $original = [IO.File]::ReadAllText($installer)
        try {
            Put $installer "# fixture switch dispatch`nparam([string]`$Action,[string]`$Channel,[switch]`$CloseDiscord)`nif (-not `$CloseDiscord -or `$Action -notin @('Install','Repair') -or `$Channel -cne 'PTB') { exit 7 }; exit 0"
            $CloseDiscord = $true
            foreach ($mode in @($false,$true)) {
                $Console = $mode
                foreach ($operation in @('Install','Repair')) { & $realInstaller $bundle PTB $operation | Out-Null }
            }
            # The default is opt-in even for the new persistent-console host.
            Put $installer "# fixture default dispatch`nparam([string]`$Action,[string]`$Channel,[switch]`$CloseDiscord)`nif (`$CloseDiscord) { exit 7 }; exit 0"
            $CloseDiscord = $false; $Console = $false
            & $realInstaller $bundle Stable Install | Out-Null
        } finally { Put $installer $original }
    }
    Test 'Unexpected failures retain a bounded sanitized local log and do not suggest closing Discord fixes them' {
        $failure = New-Object InvalidOperationException('Native installer failed')
        $failure.Data['PackageNativeDiagnostic'] = "Unexpected ownership condition`nInvalid ASAR header`nRequired payload missing`nAuthorization: Bearer abc-secret`nCookie: abc-cookie`nbody=abc-body`nToken=abc-token`nLocation C:\Users\PrivateUser\secret.txt`nhttps://example.invalid/?secret=abc-url"
        $failure.Data['PackageNativeExitCode'] = 9
        $failure.Data['PackageConsoleMessage'] = Get-PackageNativeMessage 'Unexpected ownership condition' 9 Install
        $path = $null
        for ($i=0; $i -lt 25; $i++) { $path = Write-PackageDiagnostic $caseCache Install Stable $failure }
        Assert ($path -and (Get-Item -LiteralPath $path).Length -le 32768) 'Diagnostic log missing or unbounded'
        $text = [IO.File]::ReadAllText($path)
        Assert ($text -match 'Unexpected ownership condition' -and $text -match 'Invalid ASAR header' -and $text -match 'Required payload missing' -and $text -match '"nativeExitCode":9') 'Actionable technical reason lost'
        Assert ($text -notmatch 'abc-secret|abc-cookie|abc-body|abc-token|PrivateUser|abc-url|Bearer|Authorization:|https://') 'Sensitive details persisted'
        Assert (@([IO.File]::ReadAllLines($path)).Count -le 16) 'Diagnostic record limit exceeded'
        $failure.Data['PackageDiagnosticPath'] = $path
        $message = Get-PackageConsoleError $failure
        Assert ($message.Contains($path) -and $message -notmatch 'закры|close|Discord') 'Unexpected failure wrongly prescribes closing Discord'
    }
    function Run-ConsoleEntry([bool]$ConsoleMode) {
        # Run the actual top-level catch/exit path in an isolated PS5.1 process.
        # Only its download function is replaced; there is no network or installer.
        $helper = (Join-Path $bundle 'PackageUpdate.ps1').Replace("'", "''")
        $local = (Join-Path $caseCache 'entry-local').Replace("'", "''")
        $consoleArg = ''; if ($ConsoleMode) { $consoleArg = '-Console' }
        $command = @"
`$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding(`$false)
`$env:LOCALAPPDATA = '$local'
. '$helper' -Action Update $consoleArg
Add-Type -TypeDefinition @'
$webResponseSource
'@
function Receive-PackageDownload {
    `$response = New-Object PackageFixtureResponse(404)
    throw (New-Object Net.WebException('HTTP 404 fixture', `$null, [Net.WebExceptionStatus]::ProtocolError, `$response))
}
`$ast = [Management.Automation.Language.Parser]::ParseFile('$helper', [ref]`$null, [ref]`$null)
& ([scriptblock]::Create(`$ast.EndBlock.Statements[-1].Extent.Text))
"@
        $start = New-Object Diagnostics.ProcessStartInfo
        $start.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $start.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = $utf8; $start.StandardErrorEncoding = $utf8
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $start
        try {
            $process.Start() | Out-Null
            $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Console fixture timed out' }
            return [pscustomobject]@{ code=$process.ExitCode; stdout=$stdout.Result; stderr=$stderr.Result }
        } finally { $process.Dispose() }
    }
    Test 'Actual Console entry returns failure for HTTP404 without raw errors or false up-to-date output' {
        $result = Run-ConsoleEntry $true
        Assert ($result.code -eq 1 -and $result.stdout.Trim() -ceq 'Версия установщика: 1.0.1.') 'HTTP404 lost known version or produced false success'
        Assert ($result.stderr.Trim() -ceq 'Публичный выпуск пока недоступен. Обновление не загружено.') "Unexpected console output: $($result.stderr)"
    }
    Test 'Technical CLI keeps original failure details and nonzero exit' {
        $result = Run-ConsoleEntry $false
        Assert ($result.code -eq 1 -and -not $result.stdout.Trim()) 'CLI HTTP404 produced success'
        Assert ($result.stderr -match 'Package update failed: HTTP 404 fixture') 'Technical diagnostics hidden'
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
