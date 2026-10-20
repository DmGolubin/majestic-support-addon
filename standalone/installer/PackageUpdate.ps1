# Windows PowerShell 5.1. Check/Update never execute downloaded code.
# Install is an explicit, offline action. No token, Node, elevation or runtime mutation.
[CmdletBinding()]
param(
    [ValidateSet('Check', 'Update', 'Resolve', 'Install', 'Repair')][string]$Action = 'Check',
    [ValidateSet('Stable', 'Canary')][string]$Channel,
    [switch]$Console
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
    $budget = 10000; if ($OutputPath) { $budget = 60000 }
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
    [ValidateSet('Install', 'Repair')][string]$NativeAction = 'Install') {
    Assert-Update ($TargetChannel -cin @('Stable', 'Canary')) 'Choose Stable or Canary explicitly'
    $installer = Join-Path $Package 'SupportTemplates.ps1'
    Safe-UpdatePath $installer
    # Separate process prevents the installed script's script-scoped state/functions
    # from clobbering this helper. Argument-array invocation does not parse cmd text.
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -Action $NativeAction -Channel $TargetChannel
    Assert-Update ($LASTEXITCODE -eq 0) 'Native installer failed'
}
function Invoke-PackageUpdate([string]$Operation, [string]$TargetChannel, [string]$Cache) {
    $context = Get-PackageContext
    Safe-UpdatePath $Cache
    if ($Operation -in @('Install', 'Repair')) { Assert-Update ($TargetChannel -cin @('Stable', 'Canary')) 'Choose Stable or Canary explicitly' }
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
        if ($Operation -in @('Resolve', 'Install', 'Repair')) {
            $package = $context.root
            if ($null -ne $selected) { $package = Expand-PackageSelection $selected $Cache }
            if ($Operation -eq 'Resolve') { return $package }
            try { Invoke-PackageInstaller $package $TargetChannel $Operation }
            finally {
                if ($null -ne $selected) { Remove-PackageExtraction (Get-PackageExtractionRoot $package $Cache) $Cache }
            }
            return
        }
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
}
if ($MyInvocation.InvocationName -ne '.') {
    try {
        Assert-Update (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) 'LOCALAPPDATA unavailable'
        $result = Invoke-PackageUpdate $Action $Channel (Join-Path $env:LOCALAPPDATA 'SupportTemplates/installer-updates')
        if ($Console -and $Action -in @('Check', 'Update')) {
            $status = $result | ConvertFrom-Json
            Write-Output ("Версия пакета: {0}. Последняя стабильная: {1}." -f $status.selectedVersion, $status.latestVersion)
            if ($status.updateAvailable) { Write-Output 'Доступно обновление. Выберите обновление пакета в меню, чтобы скачать его.' }
            elseif ($Action -eq 'Update') {
                Write-Output 'Пакет готов. Для установки выберите нужный клиент в меню.'
                Write-Output ('Расположение пакета: ' + $status.packagePath)
            }
            else { Write-Output 'Более новой версии пакета нет.' }
        } else { $result }
    } catch {
        [Console]::Error.WriteLine('Package update failed: ' + $_.Exception.Message)
        exit 1
    }
}
