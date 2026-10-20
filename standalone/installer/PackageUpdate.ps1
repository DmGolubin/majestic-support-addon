# Windows PowerShell 5.1. Check/Update never execute downloaded code.
# Install/Repair are explicit offline actions; closing the selected client is opt-in.
# No token, Node, elevation or background installation.
[CmdletBinding()]
param(
    [ValidateSet('Check', 'Update', 'Resolve', 'Inspect', 'Install', 'Repair')][string]$Action = 'Check',
    [ValidateSet('Stable', 'Canary', 'PTB')][string]$Channel,
    [switch]$Console,
    [switch]$CloseDiscord,
    [ValidateSet('', 'vencord', 'betterdiscord')][string]$ReplaceExisting = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
. (Join-Path $PSScriptRoot 'payload/runtime/update-helper.ps1')
$script:PackageUpdaterRoot = $PSScriptRoot
$script:PackageRepository = 'DmGolubin/majestic-support-addon'
$script:PackageManifestName = 'support-templates-update.json'
$script:PackageUtf8 = New-Object Text.UTF8Encoding($false, $true)

function Read-PackageJson([string]$Path, [long]$Limit = 1048576) {
    Safe-UpdatePath $Path
    Assert-Update ((Get-Item -LiteralPath $Path).Length -le $Limit) 'Package metadata too large'
    return ([IO.File]::ReadAllText($Path, $script:PackageUtf8) | ConvertFrom-Json)
}
function Assert-PackageVersion([string]$Version) {
    Assert-Update ($Version.Length -le 100 -and $Version -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') 'Stable package version required'
}
function Get-PackageContext {
    $root = $script:PackageUpdaterRoot
    Safe-UpdatePath $root
    $manifest = Read-PackageJson (Join-Path $root 'manifest.json')
    $config = Read-PackageJson (Join-Path $root 'payload/runtime/update-config.json')
    Assert-PackageVersion $manifest.version
    Assert-Update ($manifest.schema -eq 1 -and $manifest.product -ceq 'SupportTemplates') 'Invalid bundled package'
    Assert-Update ($config.schema -eq 1 -and $config.version -ceq $manifest.version -and $config.channel -ceq 'stable' -and
        $config.releaseRepository -ceq $script:PackageRepository -and $config.manifestAsset -ceq $script:PackageManifestName) 'Invalid package update configuration'
    Assert-Update ([IO.File]::Exists((Join-Path $root 'SupportTemplates.ps1'))) 'Bundled installer missing'
    return [pscustomobject]@{ root = $root; version = $manifest.version; repository = $config.releaseRepository }
}
function Assert-PackageUrl([string]$Url, [string]$Original, [bool]$Redirected) {
    $uri = [uri]$Url
    Assert-Update ($uri.IsAbsoluteUri -and $uri.Scheme -ceq 'https' -and $uri.IsDefaultPort -and
        -not $uri.UserInfo -and -not $uri.Fragment) 'Unsafe update URL'
    if ($Url -ceq $Original) { return }
    # GitHub asset redirects only; API redirects or cross-repository redirects fail closed.
    $source = [uri]$Original
    Assert-Update ($Redirected -and $source.Host -ceq 'github.com' -and
        $uri.Host -cin @('release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com')) 'Unexpected update redirect'
}
function Receive-PackageDownload([string]$Url, [long]$Limit, [string]$OutputPath = '') {
    # Redirects and streamed bytes share a wall-clock budget. No ambient credentials.
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $budget = 4000; if ($OutputPath) { $budget = 60000 }
    $original = $Url
    $oldTls = [Net.ServicePointManager]::SecurityProtocol
    $output = $null; $response = $null; $request = $null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        for ($redirect = 0; $redirect -le 5; $redirect++) {
            Assert-PackageUrl $Url $original ($redirect -gt 0)
            Assert-Update ($clock.ElapsedMilliseconds -lt $budget) 'Update request timed out'
            $request = [Net.HttpWebRequest]::Create($Url)
            $request.AllowAutoRedirect = $false
            $request.UseDefaultCredentials = $false
            $request.Credentials = $null
            $request.Timeout = [int]($budget - $clock.ElapsedMilliseconds)
            $request.ReadWriteTimeout = [Math]::Min(5000, $request.Timeout)
            $request.UserAgent = 'SupportTemplates-PackageUpdater/1'
            $request.Accept = 'application/json, application/octet-stream'
            $request.Headers['Accept-Encoding'] = 'identity'
            $connecting = $request.BeginGetResponse($null, $null)
            try {
                Assert-Update ($connecting.AsyncWaitHandle.WaitOne([Math]::Max(1, [int]($budget - $clock.ElapsedMilliseconds)))) 'Update request timed out'
                $response = $request.EndGetResponse($connecting)
            } finally { $connecting.AsyncWaitHandle.Close() }
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                Assert-Update ($redirect -lt 5 -and $response.Headers['Location']) 'Update redirect limit'
                $Url = (New-Object Uri([uri]$Url, $response.Headers['Location'])).AbsoluteUri
                $response.Dispose(); $response = $null
                continue
            }
            Assert-Update ($status -eq 200) 'Update download unavailable'
            Assert-Update (-not $response.ContentEncoding -or $response.ContentEncoding -ceq 'identity') 'Encoded update refused'
            Assert-Update ($response.ContentLength -le $Limit) 'Update download too large'
            if ($OutputPath) {
                Safe-UpdatePath $OutputPath
                $output = New-Object IO.FileStream($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            } else { $output = New-Object IO.MemoryStream }
            $inputStream = $response.GetResponseStream()
            try {
                $buffer = New-Object byte[] 65536
                [long]$total = 0
                while ($true) {
                    Assert-Update ($clock.ElapsedMilliseconds -lt $budget) 'Update request timed out'
                    $inputStream.ReadTimeout = [int][Math]::Min(5000, $budget - $clock.ElapsedMilliseconds)
                    $count = $inputStream.Read($buffer, 0, $buffer.Length)
                    if ($count -eq 0) { break }
                    $total += $count
                    Assert-Update ($total -le $Limit) 'Update download too large'
                    $output.Write($buffer, 0, $count)
                }
                Assert-Update ($response.ContentLength -lt 0 -or $total -eq $response.ContentLength) 'Truncated update download'
                if ($OutputPath) { $output.Flush($true) } else { return ,$output.ToArray() }
                return
            } finally { $inputStream.Dispose() }
        }
        throw 'Update redirect limit'
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $output) { $output.Dispose() }
        if ($null -ne $request) { $request.Abort() }
        [Net.ServicePointManager]::SecurityProtocol = $oldTls
    }
}
function Get-PackageDownloadUrl([string]$Version, [string]$Name) {
    return "https://github.com/$script:PackageRepository/releases/download/v$Version/$Name"
}
function Assert-PackageRelease($Release) {
    Assert-Update ($Release.draft -is [bool] -and -not $Release.draft -and
        $Release.prerelease -is [bool] -and -not $Release.prerelease -and $Release.published_at) 'Published stable release required'
    $version = [string]$Release.tag_name
    Assert-Update ($version.StartsWith('v', [StringComparison]::Ordinal)) 'Invalid release tag'
    $version = $version.Substring(1); Assert-PackageVersion $version
    Assert-Update ($Release.html_url -ceq "https://github.com/$script:PackageRepository/releases/tag/v$version") 'Release repository mismatch'
    Assert-Update ($Release.assets -is [array] -and $Release.assets.Count -le 100) 'Invalid release assets'
    return $version
}
function Get-PackageReleaseAsset($Release, [string]$Version, [string]$Name, [long]$Limit) {
    $assets = @($Release.assets | Where-Object { $_.name -ceq $Name })
    Assert-Update ($assets.Count -eq 1) 'Required release asset missing or duplicate'
    $asset = $assets[0]
    Assert-Update ($asset.state -ceq 'uploaded' -and $asset.size -is [ValueType] -and
        $asset.size -gt 0 -and $asset.size -le $Limit -and [Math]::Floor($asset.size) -eq $asset.size -and
        $asset.browser_download_url -ceq (Get-PackageDownloadUrl $Version $Name)) 'Invalid release asset'
    return $asset
}
function Assert-PackageOffer($Release, $Manifest) {
    $version = Assert-PackageRelease $Release
    Assert-Update ($Manifest.schema -eq 1 -and $Manifest.product -ceq 'SupportTemplates' -and
        $Manifest.repository -ceq $script:PackageRepository -and $Manifest.channel -ceq 'stable' -and
        $Manifest.version -ceq $version) 'Update manifest identity mismatch'
    Assert-Update ($Manifest.assets -is [array] -and $Manifest.assets.Count -eq 2) 'Expected two public variants'
    foreach ($variant in @('standalone', 'betterdiscord')) {
        $entries = @($Manifest.assets | Where-Object { $_.variant -ceq $variant })
        Assert-Update ($entries.Count -eq 1) 'Invalid public variants'
    }
    $asset = @($Manifest.assets | Where-Object { $_.variant -ceq 'standalone' })[0]
    Assert-Update ($asset.name -ceq "SupportTemplates-standalone-$version.zip" -and $asset.platform -ceq 'win32' -and
        $asset.kind -ceq 'native' -and $asset.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid standalone archive'
    $remote = Get-PackageReleaseAsset $Release $version $asset.name 268435456
    Assert-Update ($asset.size -eq $remote.size) 'Archive size metadata mismatch'
    return [pscustomobject]@{ version = $version; size = $remote.size; sha256 = $asset.sha256; url = $remote.browser_download_url }
}
function Get-PackageOffer {
    $bytes = Receive-PackageDownload "https://api.github.com/repos/$script:PackageRepository/releases/latest" 1048576
    $release = $script:PackageUtf8.GetString($bytes) | ConvertFrom-Json
    $version = Assert-PackageRelease $release
    $remote = Get-PackageReleaseAsset $release $version $script:PackageManifestName 1048576
    $bytes = Receive-PackageDownload $remote.browser_download_url $remote.size
    Assert-Update ($bytes.Length -eq $remote.size) 'Manifest size mismatch'
    $manifest = $script:PackageUtf8.GetString($bytes) | ConvertFrom-Json
    $offer = Assert-PackageOffer $release $manifest
    return [pscustomobject]@{ release = $release; manifest = $manifest; offer = $offer }
}
function Get-PackageSelection([string]$Cache, $Context) {
    $path = Join-Path $Cache 'selected.json'
    Safe-UpdatePath $path
    if (-not [IO.File]::Exists($path)) {
        Assert-Update (-not (Test-Path -LiteralPath $path)) 'Invalid cached selection file'
        return $null
    }
    $saved = Read-PackageJson $path 2097152
    Assert-Update ($saved.schema -eq 1) 'Invalid cached selection'
    $offer = Assert-PackageOffer $saved.release $saved.manifest
    Assert-Update ($saved.archive -ceq ($offer.sha256 + '.zip')) 'Invalid cached archive path'
    if ((Compare-UpdateVersion $offer.version $Context.version) -le 0) { return $null }
    return [pscustomobject]@{ offer = $offer; archive = (Join-Path $Cache $saved.archive) }
}
function Expand-PackageSelection($Selection, [string]$Cache) {
    $request = [pscustomobject]@{ version = $Selection.offer.version; size = $Selection.offer.size;
        sha256 = $Selection.offer.sha256; assetPath = $Selection.archive }
    # Always rehash and use a fresh extraction. Never trust a previous extracted script.
    $destination = Join-Path $Cache ('resolve-' + [guid]::NewGuid().ToString('N'))
    try { return Expand-VerifiedUpdate $request $destination }
    catch { Remove-PackageExtraction $destination $Cache; throw }
}
function Remove-PackageExtraction([string]$Directory, [string]$Cache) {
    $directoryPath = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $cachePath = [IO.Path]::GetFullPath($Cache).TrimEnd('\')
    Assert-Update ([IO.Path]::GetDirectoryName($directoryPath) -ieq $cachePath -and
        [IO.Path]::GetFileName($directoryPath) -cmatch '^resolve-[a-f0-9]{32}$') 'Cleanup outside package cache refused'
    Safe-UpdatePath $directoryPath
    if ([IO.Directory]::Exists($directoryPath)) {
        # Extraction rejects links; recheck before recursive cleanup as well.
        foreach ($entry in Get-ChildItem -LiteralPath $directoryPath -Force -Recurse) {
            Assert-Update (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Redirected cleanup refused'
        }
        Remove-Item -LiteralPath $directoryPath -Recurse -Force
    }
}
function Get-PackageExtractionRoot([string]$Package, [string]$Cache) {
    $cursor = [IO.Path]::GetFullPath($Package)
    Assert-Update (Under-Update $cursor $Cache) 'Package outside extraction cache'
    while ([IO.Path]::GetDirectoryName($cursor) -ine [IO.Path]::GetFullPath($Cache).TrimEnd('\')) {
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    Assert-Update ([IO.Path]::GetFileName($cursor) -cmatch '^resolve-[a-f0-9]{32}$') 'Invalid extraction root'
    return $cursor
}
function Save-PackageArchive($Offer, [string]$Cache) {
    $archive = [IO.Path]::GetFullPath((Join-Path $Cache ($Offer.sha256 + '.zip')))
    Assert-Update ([IO.Path]::GetDirectoryName($archive) -ieq [IO.Path]::GetFullPath($Cache).TrimEnd('\') -and
        [IO.Path]::GetFileName($archive) -cmatch '^[a-f0-9]{64}\.zip$') 'Archive outside package cache'
    Safe-UpdatePath $archive
    if ([IO.File]::Exists($archive)) {
        if ((Get-Item -LiteralPath $archive).Length -eq $Offer.size -and (Update-Hash $archive) -ceq $Offer.sha256) { return $archive }
        # Only this exact corrupt hash-named regular file is removed. The durable
        # selected metadata remains untouched if the replacement download fails.
        [IO.File]::Delete($archive)
    }
    $temporary = Join-Path $Cache ('download-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Receive-PackageDownload $Offer.url $Offer.size $temporary
        Assert-Update ((Get-Item -LiteralPath $temporary).Length -eq $Offer.size -and
            (Update-Hash $temporary) -ceq $Offer.sha256) 'Archive size or SHA256 mismatch'
        [IO.File]::Move($temporary, $archive)
        return $archive
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Invoke-PackageInstaller([string]$Package, [string]$TargetChannel,
    [ValidateSet('Inspect', 'Install', 'Repair')][string]$NativeAction = 'Install', [string]$Replacement = '') {
    Assert-Update ($TargetChannel -cin @('Stable', 'Canary', 'PTB')) 'Choose Stable, Canary or PTB explicitly'
    Assert-Update ($Replacement -ceq '' -or ($NativeAction -ceq 'Install' -and $Replacement -cin @('vencord', 'betterdiscord'))) 'Replacement requires explicit Install and a known mod'
    $installer = Join-Path $Package 'SupportTemplates.ps1'
    Safe-UpdatePath $installer
    $nativeOptions = @()
    if ($CloseDiscord -and $NativeAction -in @('Install', 'Repair')) { $nativeOptions += '-CloseDiscord' }
    if ($Replacement) { $nativeOptions += @('-ReplaceExisting', $Replacement) }
    # Separate process prevents the installed script's script-scoped state/functions
    # from clobbering this helper. Argument-array invocation does not parse cmd text.
    if (-not $Console -and $NativeAction -ne 'Inspect') {
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -Action $NativeAction -Channel $TargetChannel @nativeOptions
        Assert-Update ($LASTEXITCODE -eq 0) 'Native installer failed'
        return
    }
    # Keep only a bounded tail for known native diagnostics. In Console mode
    # neither stderr nor English/path-bearing native output reaches the menu.
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $truncated = $false
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -Action $NativeAction -Channel $TargetChannel @nativeOptions 2>&1 | ForEach-Object {
            $line = [string]$_
            if ($line.Length -gt 512) { $truncated = $true; $line = $line.Substring(0, 512) }
            $lines.Add($line)
            if ($lines.Count -gt 16) { $truncated = $true; $lines.RemoveAt(0) }
        }
        $nativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $message = Get-PackageNativeMessage ($lines -join "`n") $nativeExit $NativeAction
    if ($nativeExit -ne 0) {
        $failure = New-Object InvalidOperationException('Native installer failed')
        $failure.Data['PackageConsoleMessage'] = $message
        $failure.Data['PackageNativeDiagnostic'] = ($lines -join "`n")
        $failure.Data['PackageNativeExitCode'] = $nativeExit
        throw $failure
    }
    if ($NativeAction -eq 'Inspect') {
        Assert-Update (-not $truncated) 'Invalid native inspection: output too large'
        return ConvertTo-PackageInspection ($lines -join "`n") $TargetChannel
    }
    Write-Output $message
}
function ConvertTo-PackageInspection([string]$Raw, [string]$TargetChannel) {
    try {
        Assert-Update ($Raw.Length -le 8192 -and $Raw.TrimStart().StartsWith('{')) 'Invalid native inspection object'
        $value = ConvertFrom-Json -InputObject $Raw
        Assert-Update ($value -is [pscustomobject]) 'Invalid native inspection object'
        Assert-Update ($value.channel -is [string] -and $value.channel -ieq $TargetChannel -and $value.kind -cin @('none','supporttemplates','vencord','betterdiscord','unsupported') -and $value.canReplace -is [bool]) 'Invalid native inspection identity'
        Assert-Update (-not $value.canReplace -or $value.kind -cin @('vencord','betterdiscord')) 'Invalid native inspection replacement'
        $result = [ordered]@{channel=$TargetChannel;kind=$value.kind;canReplace=$value.canReplace}
        if ($null -ne $value.PSObject.Properties['reason']) {
            Assert-Update ($value.reason -is [string] -and $value.reason.Length -le 400 -and $value.reason -notmatch '[\x00-\x1f\x7f]') 'Invalid native inspection reason'
            $result.reason = $value.reason
        }
        return $result | ConvertTo-Json -Compress
    } catch { throw (New-Object InvalidOperationException('Invalid native inspection result', $_.Exception)) }
}
function Invoke-PackageUpdate([ValidateSet('Check', 'Update', 'Resolve', 'Inspect', 'Install', 'Repair')][string]$Operation, [string]$TargetChannel, [string]$Cache, [string]$Replacement = '') {
    $context = $null
    try {
    Assert-Update ($Replacement -ceq '' -or ($Operation -ceq 'Install' -and $Replacement -cin @('vencord', 'betterdiscord'))) 'Replacement requires explicit Install and a known mod'
    $context = Get-PackageContext
    if ($Console -and $Operation -eq 'Update') {
        # Direct console output stays separate from the structured JSON result.
        [Console]::WriteLine("Версия установщика: {0}.", $context.version)
    }
    Safe-UpdatePath $Cache
    if ($Operation -in @('Inspect', 'Install', 'Repair')) { Assert-Update ($TargetChannel -cin @('Stable', 'Canary', 'PTB')) 'Choose Stable, Canary or PTB explicitly' }
    # Serialize Update/Resolve/Install across BAT windows without touching runtime locks.
    [IO.Directory]::CreateDirectory($Cache) | Out-Null
    $lockPath = Join-Path $Cache '.lock'; Safe-UpdatePath $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $invalidSelection = $null
    try {
        try { $selected = Get-PackageSelection $Cache $context }
        catch {
            if ($Operation -ne 'Update') { throw }
            $path = [IO.Path]::GetFullPath((Join-Path $Cache 'selected.json'))
            Assert-Update ([IO.Path]::GetDirectoryName($path) -ieq [IO.Path]::GetFullPath($Cache).TrimEnd('\')) 'Selection outside package cache'
            Safe-UpdatePath $path
            Assert-Update ([IO.File]::Exists($path)) 'Invalid cached selection is not a regular file'
            $invalidSelection = Join-Path $Cache ('selected-invalid-' + [guid]::NewGuid().ToString('N') + '.json')
            # Keep the invalid record in place through download and verification.
            # Even a hard process kill must leave Install/Repair fail-closed.
            $selected = $null
        }
        $current = $context.version
        if ($null -ne $selected) { $current = $selected.offer.version }
        if ($Operation -in @('Resolve', 'Inspect', 'Install', 'Repair')) {
            $package = $context.root
            if ($null -ne $selected) { $package = Expand-PackageSelection $selected $Cache }
            if ($Operation -eq 'Resolve') { return $package }
            try { Invoke-PackageInstaller $package $TargetChannel $Operation $Replacement }
            finally {
                if ($null -ne $selected) { Remove-PackageExtraction (Get-PackageExtractionRoot $package $Cache) $Cache }
            }
            return
        }
        Assert-PackageNetworkReady $Cache $context.version
        $remote = Get-PackageOffer
        $newer = (Compare-UpdateVersion $remote.offer.version $current) -gt 0
        if ($null -ne $invalidSelection) {
            Assert-Update ((Compare-UpdateVersion $remote.offer.version $current) -ge 0) 'Cannot recover cache from an older release'
            $newer = $true # Explicit recovery verifies a trusted package even at the bundled version.
        }
        $verifiedPackage = $null
        if ($Operation -eq 'Update' -and $newer) {
            $archiveName = $remote.offer.sha256 + '.zip'
            $archive = Save-PackageArchive $remote.offer $Cache
            $candidate = [pscustomobject]@{ offer = $remote.offer; archive = $archive }
            $extracted = Expand-PackageSelection $candidate $Cache
            Remove-PackageExtraction (Get-PackageExtractionRoot $extracted $Cache) $Cache
            $verifiedPackage = $archive
            $selection = @{ schema = 1; release = $remote.release; manifest = $remote.manifest; archive = $archiveName } | ConvertTo-Json -Depth 30 -Compress
            $temporary = Join-Path $Cache ('selection-' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [IO.File]::WriteAllText($temporary, $selection, $script:PackageUtf8)
                $path = Join-Path $Cache 'selected.json'; Safe-UpdatePath $path
                if ([IO.File]::Exists($path)) {
                    if ($null -ne $invalidSelection) { [IO.File]::Copy($path, $invalidSelection, $false) }
                    [IO.File]::Replace($temporary, $path, [System.Management.Automation.Language.NullString]::Value)
                }
                else { [IO.File]::Move($temporary, $path) }
            } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
            $current = $remote.offer.version
        }
        if ($Operation -eq 'Update' -and -not $newer) {
            $verifiedPackage = $context.root
            if ($null -ne $selected) {
                $selected.archive = Save-PackageArchive $selected.offer $Cache
                $extracted = Expand-PackageSelection $selected $Cache
                Remove-PackageExtraction (Get-PackageExtractionRoot $extracted $Cache) $Cache
                $verifiedPackage = $selected.archive
            }
        }
        return [ordered]@{ schema = 1; action = $Operation; bundledVersion = $context.version; selectedVersion = $current;
            latestVersion = $remote.offer.version; updateAvailable = ((Compare-UpdateVersion $remote.offer.version $current) -gt 0);
            packagePath = $verifiedPackage } | ConvertTo-Json -Compress
    } finally { $lock.Dispose() }
    } catch {
        $failure = $_.Exception
        $network = Get-PackageNetworkFailure $failure
        if ($Operation -in @('Check', 'Update') -and $null -ne $context -and $network -and -not $failure.Data.Contains('PackageCooldownActive')) {
            try {
                $record = @{schema=1;repository=$script:PackageRepository;version=$context.version;kind=$network;
                    retryAfterUtc=[DateTime]::UtcNow.AddSeconds(60).ToString('o')} | ConvertTo-Json -Compress
                Write-PackageLocalFile $Cache 'network-unavailable.json' $record
            } catch { } # A cache-write failure must not replace the original error.
        }
        if (-not $failure.Data.Contains('PackageCooldownActive')) {
            $diagnostic = Write-PackageDiagnostic $Cache $Operation $TargetChannel $failure
            if ($diagnostic) { $failure.Data['PackageDiagnosticPath'] = $diagnostic }
        }
        throw
    }
}
function Get-PackageNetworkFailure([Exception]$Failure) {
    for ($cursor = $Failure; $null -ne $cursor; $cursor = $cursor.InnerException) {
        if ($cursor.Data.Contains('PackageNetworkKind')) { return [string]$cursor.Data['PackageNetworkKind'] }
        if ($cursor -is [Net.WebException]) {
            if ($null -ne $cursor.Response -and $null -ne $cursor.Response.PSObject.Properties['StatusCode']) {
                if ([int]$cursor.Response.StatusCode -in @(401,403,404)) { return 'public-unavailable' }
                return 'server-unavailable'
            }
            return 'network-unavailable'
        }
        if ($cursor -is [TimeoutException] -or $cursor.Message -match 'Update request timed out') { return 'network-unavailable' }
    }
    return $null
}
function Write-PackageLocalFile([string]$Cache, [string]$Name, [string]$Text) {
    Assert-Update ($Name -cin @('network-unavailable.json', 'installer-diagnostics.log')) 'Invalid local diagnostic filename'
    Safe-UpdatePath $Cache
    [IO.Directory]::CreateDirectory($Cache) | Out-Null
    $path = Join-Path $Cache $Name; Safe-UpdatePath $path
    $temporary = Join-Path $Cache ('diagnostic-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Text, $script:PackageUtf8)
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Assert-PackageNetworkReady([string]$Cache, [string]$Version) {
    # A short failure-only cooldown survives BAT relaunches. Corrupt/old markers
    # never establish success or prevent future checks.
    $record = $null; $active = $false
    try {
        $path = Join-Path $Cache 'network-unavailable.json'
        Safe-UpdatePath $path
        if (-not [IO.File]::Exists($path)) { return }
        $record = Read-PackageJson $path 2048
        $expiry = [DateTime]::Parse($record.retryAfterUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $remaining = ($expiry - [DateTime]::UtcNow).TotalSeconds
        $active = $record.schema -eq 1 -and $record.repository -ceq $script:PackageRepository -and $record.version -ceq $Version -and
            $record.kind -cin @('public-unavailable','server-unavailable','network-unavailable') -and $remaining -gt 0 -and $remaining -le 60
    } catch { return }
    if ($active) {
        $failure = New-Object InvalidOperationException('Update unavailable: network retry cooldown (up to 60 seconds)')
        $failure.Data['PackageNetworkKind'] = $record.kind
        $failure.Data['PackageCooldownActive'] = $true
        $failure.Data['PackageConsoleMessage'] = 'Проверка обновлений временно отложена после сбоя соединения. Повторите попытку через минуту.'
        throw $failure
    }
}
function ConvertTo-PackageDiagnosticText([string]$Text) {
    # Persist controlled native messages, never headers, URL queries, credentials
    # or profile paths. No exception stack/body/response object is serialized.
    $text = $Text
    $text = [regex]::Replace($text, '(?im)^.*(?:authorization|cookie|token|password|secret|api[-_]?key|(?:request|response|http)[ -]?(?:headers?|body|payload)|\b(?:headers?|body|payload)\s*[:=]).*$','[sensitive diagnostic omitted]')
    $text = [regex]::Replace($text, '(?i)(?:https?://|[a-z]:[\\/]|\\\\)[^\r\n]*', '[location omitted]')
    $text = [regex]::Replace($text, '(?m)^\s*\+.*$|^\s*At .*$', '')
    $text = [regex]::Replace($text, '[\x00-\x08\x0b\x0c\x0e-\x1f]', '')
    if ($text.Length -gt 4096) { $text = $text.Substring($text.Length - 4096) }
    return $text.Trim()
}
function Write-PackageDiagnostic([string]$Cache, [string]$Operation, [string]$TargetChannel, [Exception]$Failure) {
    try {
        $path = Join-Path $Cache 'installer-diagnostics.log'
        Safe-UpdatePath $path
        $entries = @()
        if ([IO.File]::Exists($path) -and (Get-Item -LiteralPath $path).Length -le 32768) {
            $entries = @([IO.File]::ReadAllLines($path, $script:PackageUtf8) | Select-Object -Last 15)
        }
        $record = [ordered]@{at=[DateTime]::UtcNow.ToString('o');action=$Operation;channel=$(if ($TargetChannel -cin @('Stable','Canary','PTB')) { $TargetChannel } else { '' });
            errorType=$Failure.GetType().FullName;message=(ConvertTo-PackageDiagnosticText $Failure.Message)}
        if ($Failure.Data.Contains('PackageNativeDiagnostic')) {
            $record.nativeExitCode = $Failure.Data['PackageNativeExitCode']
            $record.native = ConvertTo-PackageDiagnosticText $Failure.Data['PackageNativeDiagnostic']
        }
        $entries += ($record | ConvertTo-Json -Compress)
        $text = ($entries -join "`n") + "`n"
        while ($entries.Count -gt 1 -and $script:PackageUtf8.GetByteCount($text) -gt 32768) {
            $entries = @($entries | Select-Object -Skip 1); $text = ($entries -join "`n") + "`n"
        }
        Assert-Update ($script:PackageUtf8.GetByteCount($text) -le 32768) 'Diagnostic entry too large'
        Write-PackageLocalFile $Cache 'installer-diagnostics.log' $text
        return $path
    } catch { return $null } # Logging must never hide the operation failure.
}
function Get-PackageNativeMessage([string]$Output, [int]$ExitCode, [string]$NativeAction) {
    if ($NativeAction -eq 'Inspect') { return 'Не удалось проверить выбранный Discord. Установка не начата.' }
    if ($ExitCode -eq 0) {
        if ($Output -match 'Already installed and verified') { return 'SupportTemplates уже установлен и проверен.' }
        if ($NativeAction -eq 'Repair') { return 'SupportTemplates восстановлен. Перезапустите Discord.' }
        return 'SupportTemplates установлен. Перезапустите Discord.'
    }
    if ($Output -match 'Target Discord is running|close the target Discord|close it before retrying') {
        return 'Полностью закройте выбранный Discord, включая значок в системном трее, и повторите установку.'
    }
    if ($Output -match 'Foreign modloader|Foreign resources/app directory|Foreign backup/config without ownership state refused') {
        return 'В клиенте обнаружен другой мод или несовместимая установка. Для Vencord или BetterDiscord используйте совместимый плагин SupportTemplates.'
    }
    if ($Output -match 'Replacement type changed|ReplaceExisting does not match|Injection changed|Foreign modification during replacement|Replacement approval belongs') {
        return 'Установка Discord изменилась после проверки. Замена отменена. Выберите клиент заново.'
    }
    if ($Output -match 'Interrupted replacement|Pending replacement|Recover pending installation') {
        return 'Предыдущая замена не завершена. Закройте Discord и повторно подтвердите замену выбранного мода.'
    }
    if ($Output -match 'cannot downgrade the installed (package )?version') {
        return 'Установлена более новая версия SupportTemplates. Понижение версии отменено.'
    }
    if ($Output -match 'No supported Discord installation found|No supported app-SEMVER directory') {
        return 'Выбранный клиент Discord не найден. Сначала установите его и повторите попытку.'
    }
    return 'Не удалось завершить установку SupportTemplates. Для выяснения причины нужен журнал установщика.'
}
function Get-PackageConsoleError([Exception]$Failure) {
    if ($Failure.Message -match 'Invalid native inspection') { return 'Не удалось проверить выбранный Discord. Установка не начата.' }
    # EndGetResponse is wrapped in MethodInvocationException by PowerShell.
    # Inspect typed inner exceptions instead of relying on localized HTTP text.
    $cursor = $Failure
    while ($null -ne $cursor) {
        if ($cursor.Data.Contains('PackageConsoleMessage')) {
            $message = [string]$cursor.Data['PackageConsoleMessage']
            if ($message -match 'нужен журнал' -and $cursor.Data.Contains('PackageDiagnosticPath')) {
                $message += ' Журнал: ' + [string]$cursor.Data['PackageDiagnosticPath']
            }
            return $message
        }
        if ($cursor -is [Net.WebException]) {
            $response = $cursor.Response
            if ($null -ne $response -and $null -ne $response.PSObject.Properties['StatusCode']) {
                $status = [int]$response.StatusCode
                if ($status -in @(401, 403, 404)) {
                    return 'Публичный выпуск пока недоступен. Обновление не загружено.'
                }
                return 'Сервер обновлений временно недоступен. Повторите попытку позже.'
            }
            return 'Не удалось подключиться к серверу обновлений. Проверьте интернет и повторите попытку позже.'
        }
        if ($cursor -is [TimeoutException] -or $cursor.Message -match 'Update request timed out') {
            return 'Не удалось подключиться к серверу обновлений. Проверьте интернет и повторите попытку позже.'
        }
        $cursor = $cursor.InnerException
    }
    # These diagnostics originate in the local validator/extractor, never remote
    # response prose. Do not expose paths, URLs, stack traces or raw error text.
    if ($Failure.ToString() -match 'SHA256|archive|manifest|metadata|selection|package version|bundled package|update configuration|release (tag|asset|repository)|public variants|stable release|update URL|update redirect|Encoded update|download too large|size mismatch|Truncated update|ConvertFrom-Json|Invalid JSON') {
        return 'Пакет не прошёл проверку целостности или безопасности. Установка не начата. Повторите загрузку.'
    }
    $message = 'Не удалось подготовить пакет. Для выяснения причины нужен журнал установщика.'
    if ($Failure.Data.Contains('PackageDiagnosticPath')) { $message += ' Журнал: ' + [string]$Failure.Data['PackageDiagnosticPath'] }
    return $message
}
function Write-PackageConsoleResult($Status) {
    if ($Status.action -eq 'Update') {
        Write-Output ("Готов к установке пакет версии {0}." -f $Status.selectedVersion)
    } else {
        Write-Output ("Выбран пакет версии {0}." -f $Status.selectedVersion)
        if ($Status.updateAvailable) { Write-Output ("Доступна версия {0}." -f $Status.latestVersion) }
        else { Write-Output 'Обновление не требуется.' }
    }
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Assert-Update (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) 'LOCALAPPDATA unavailable'
        $result = Invoke-PackageUpdate $Action $Channel (Join-Path $env:LOCALAPPDATA 'SupportTemplates/installer-updates') $ReplaceExisting
        if ($Console -and $Action -in @('Check', 'Update')) {
            Write-PackageConsoleResult ($result | ConvertFrom-Json)
        } else { $result }
    } catch {
        if ($Console) { [Console]::Error.WriteLine((Get-PackageConsoleError $_.Exception)) }
        else { [Console]::Error.WriteLine('Package update failed: ' + $_.Exception.Message) }
        exit 1
    }
}
