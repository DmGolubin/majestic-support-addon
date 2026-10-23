# Loaded by SupportTemplates.ps1. A hot update changes one renderer file only.
# CSS is embedded in that file so Ctrl+R cannot mix old JS with new CSS.
function Renderer-UpdateRoot([string]$Version) {
    Valid-Version $Version
    Join-Path $script:ChannelRoot ('renderer-updates/' + $Version)
}
function Read-RendererCleanup {
    $path = Join-Path $script:ChannelRoot 'renderer-cleanup.json'
    Safe-Path $path
    if (-not (Exists $path)) { return $null }
    $value = Read-Json $path
    Require ($value.schema -eq 1 -and $value.manifestHash -cmatch '^[a-f0-9]{64}$') 'Invalid renderer cleanup intent'
    Valid-Version $value.version
    if ($null -ne $value.oldVersion) { Valid-Version $value.oldVersion }
    return $value
}
function Complete-RendererCleanup($State) {
    $value = Read-RendererCleanup
    if ($null -eq $value) { return }
    # A rolled-back resource transaction keeps the old UI. A committed one must finish cleanup.
    if ($null -ne $State -and $State.version -ceq $value.version -and $State.manifestHash -ceq $value.manifestHash) {
        if ($null -ne $value.oldVersion) { Restore-RendererOverlay $value.oldVersion }
        if ($value.oldVersion -cne $value.version) { Restore-RendererOverlay $value.version }
    }
    [IO.File]::Delete((Join-Path $script:ChannelRoot 'renderer-cleanup.json'))
}
function Read-RendererOverlay([string]$Version) {
    $root = Renderer-UpdateRoot $Version
    $record = Join-Path $root 'current.json'
    Safe-Path $record
    if (-not (Exists $record)) { return $null }
    $value = Read-Json $record
    Require ($value.schema -eq 1 -and $value.baseVersion -ceq $Version) 'Invalid renderer update record'
    Valid-Version $value.version
    Require ($value.baseManifestHash -cmatch '^[a-f0-9]{64}$') 'Invalid renderer base hash'
    Require ((Hash-File (Join-Path (Version-Path $Version) 'manifest.json')) -ceq $value.baseManifestHash) 'Renderer base manifest changed'
    foreach ($hash in @($value.hash, $value.previousHash, $value.originalHash)) {
        Require ($hash -cmatch '^[a-f0-9]{64}$') 'Invalid renderer hash'
        Require ((Hash-File (Join-Path $root ($hash + '.js'))) -ceq $hash) 'Renderer recovery blob changed'
    }
    $manifest = Read-Json (Join-Path (Version-Path $Version) 'manifest.json')
    Require ($manifest.files.Where({$_.path -ceq 'payload/runtime/renderer.js'})[0].sha256 -ceq $value.originalHash) 'Renderer original hash mismatch'
    return $value
}
function Atomic-RendererFile([string]$Target, [byte[]]$Bytes) {
    Safe-Path $Target
    # Same volume, outside immutable payload trees: an interrupted temp write cannot poison a package.
    $stage = Join-Path $script:ChannelRoot ('.renderer-stage-' + [guid]::NewGuid().ToString('N'))
    Write-New $stage $Bytes
    try {
        if (Exists $Target) { [IO.File]::Replace($stage, $Target, [NullString]::Value) }
        else { [IO.File]::Move($stage, $Target) }
    } finally {
        if (Exists $stage) { [IO.File]::Delete($stage) }
    }
}
function Save-RendererBlob([string]$Root, [byte[]]$Bytes) {
    $hash = Hash-Bytes $Bytes
    $file = Join-Path $Root ($hash + '.js')
    if (Exists $file) { Require ((Hash-File $file) -ceq $hash) 'Renderer blob was modified' }
    else { Atomic-RendererFile $file $Bytes }
    return $hash
}
function Restore-RendererOverlay([string]$Version) {
    $overlay = Read-RendererOverlay $Version
    if ($null -eq $overlay) { return }
    $root = Renderer-UpdateRoot $Version
    $target = Join-Path (Version-Path $Version) 'runtime/renderer.js'
    Require ((Hash-File $target) -cin @($overlay.hash, $overlay.previousHash)) 'Renderer changed; refusing restore'
    # Publish recovery intent before replacing the sole live file.
    $overlay.previousHash = Hash-File $target
    $overlay.hash = $overlay.originalHash
    $overlay.version = $Version
    Atomic-RendererFile (Join-Path $root 'current.json') (Json-Bytes $overlay)
    Atomic-RendererFile $target ([IO.File]::ReadAllBytes((Join-Path $root ($overlay.hash + '.js'))))
    [IO.File]::Delete((Join-Path $root 'current.json'))
}
function Native-Code([string]$Path) {
    $code = $script:Utf8.GetString([IO.File]::ReadAllBytes($Path))
    # The generated first line includes the release label; every executable byte must match.
    return [regex]::Replace($code, '\A// SupportTemplates [^\r\n]+; based on Vencord [a-f0-9]+; upstream updater disabled\.\r?\n', '')
}
function Loader-Identity([string]$Path) {
    Safe-File $Path
    $bytes = [IO.File]::ReadAllBytes($Path)
    Require ($bytes.Length -gt 16 -and [BitConverter]::ToUInt32($bytes, 0) -eq 4) 'Unsupported loader archive'
    $headerSize = [BitConverter]::ToUInt32($bytes, 4)
    $jsonSize = [BitConverter]::ToUInt32($bytes, 12)
    Require ($headerSize -le 8388608 -and $jsonSize -le $headerSize - 8 -and $headerSize + 8 -lt $bytes.Length) 'Invalid loader archive'
    $tree = $script:Utf8.GetString($bytes, 16, $jsonSize) | ConvertFrom-Json
    Require (@($tree.files.PSObject.Properties).Count -eq 2) 'Unsupported loader entries'
    Check-AsarTree $tree ($bytes.Length - $headerSize - 8)
    $entry = Asar-Entry $tree 'index.js'
    $code = $script:Utf8.GetString($bytes, [int]($headerSize + 8 + [long]$entry.offset), [int]$entry.size)
    $entry = Asar-Entry $tree 'package.json'
    $pkg = $script:Utf8.GetString($bytes, [int]($headerSize + 8 + [long]$entry.offset), [int]$entry.size) | ConvertFrom-Json
    Require ($pkg.name -ceq 'support-templates-loader' -and $pkg.main -ceq 'index.js' -and @($pkg.PSObject.Properties).Count -eq 3) 'Unsupported loader metadata'
    Valid-Version $pkg.version
    return $code
}
function Update-Renderer($State) {
    Require ($null -ne $State) 'Install SupportTemplates before updating its renderer'
    $base = Stored-Package $State.version
    Require ((Hash-File (Join-Path $base.Base 'manifest.json')) -ceq $State.manifestHash -and $base.LoaderHash -ceq $State.loaderHash) 'Installed runtime differs from ownership state'
    $package = Read-Package $script:PackageRoot
    Require ($package.Manifest.upstreamCommit -ceq $base.Manifest.upstreamCommit) 'Framework changed; full installation with Discord closed is required'
    foreach ($name in @('patcher.js', 'preload.js')) {
        Require ((Native-Code $base.Files[('payload/runtime/' + $name)]) -ceq (Native-Code $package.Files[('payload/runtime/' + $name)])) "$name changed; full installation with Discord closed is required"
    }
    if ($package.LoaderHash -cne $base.LoaderHash) {
        Require ((Loader-Identity $package.Files['payload/loader.asar']) -ceq (Loader-Identity $base.Files['payload/loader.asar'])) 'Loader changed; full installation with Discord closed is required'
    }
    $baseHelper = $base.Files['payload/runtime/update-helper.ps1']
    $nextHelper = $package.Files['payload/runtime/update-helper.ps1']
    Require (($null -eq $baseHelper -and $null -eq $nextHelper) -or ($null -ne $baseHelper -and $null -ne $nextHelper -and (Hash-File $baseHelper) -ceq (Hash-File $nextHelper))) 'Update helper changed; full installation required'
    $updatePolicies = @()
    foreach ($candidate in @($base, $package)) {
        $file = $candidate.Files['payload/runtime/update-config.json']
        if ($null -eq $file) { $updatePolicies += $null; continue }
        $config = Read-Json $file
        Require ($config.version -ceq $candidate.Manifest.version) 'Updater config version differs from package'
        # The running native updater retains its base version. Every other policy
        # value must agree; changing channels/repositories requires a full install.
        $policy = [ordered]@{}
        foreach ($property in @($config.PSObject.Properties | Sort-Object Name)) {
            if ($property.Name -cne 'version') { $policy[$property.Name] = $property.Value }
        }
        $updatePolicies += ($policy | ConvertTo-Json -Depth 40 -Compress)
    }
    Require ($updatePolicies[0] -ceq $updatePolicies[1]) 'Updater policy changed; full installation required'
    # Fail closed on future native/assets additions even if patcher/preload happen to match.
    $allowed = @('payload/loader.asar','payload/runtime/patcher.js','payload/runtime/patcher.js.map','payload/runtime/preload.js','payload/runtime/preload.js.map','payload/runtime/renderer.js','payload/runtime/renderer.js.map','payload/runtime/renderer.js.LEGAL.txt','payload/runtime/renderer.css','payload/runtime/renderer.css.map','payload/runtime/update-helper.ps1','payload/runtime/update-config.json')
    foreach ($item in @($base.Manifest.files) + @($package.Manifest.files)) { Require ($item.path -cin $allowed) 'Unknown payload layout; full installation required' }
    if (-not $script:Fixture) {
        foreach ($process in @(Get-Process -Name $script:ExeName -ErrorAction SilentlyContinue)) {
            $location = $process.Path
            Require (-not [string]::IsNullOrWhiteSpace($location)) 'Cannot identify running host'
            Require ((Full (Join-Path (Split-Path $location -Parent) 'resources')) -ieq (Full $script:Resources)) 'Running host is a different app version; repair the selected host first'
        }
    }
    $js = $script:Utf8.GetString([IO.File]::ReadAllBytes($package.Files['payload/runtime/renderer.js']))
    $css = $script:Utf8.GetString([IO.File]::ReadAllBytes($package.Files['payload/runtime/renderer.css']))
    $needle = 'VencordNative.native.getRendererCss()'
    Require ([regex]::Matches($js, [regex]::Escape($needle)).Count -eq 1) 'Unsupported renderer CSS entry; full installation required'
    $bytes = $script:Utf8.GetBytes($js.Replace($needle, ('Promise.resolve(' + (ConvertTo-Json -InputObject $css -Compress) + ')')))
    $root = Renderer-UpdateRoot $State.version
    $overlay = Read-RendererOverlay $State.version
    $target = $base.Files['payload/runtime/renderer.js']
    if ($null -ne $overlay -and $overlay.hash -ceq (Hash-Bytes $bytes) -and (Hash-File $target) -ceq $overlay.hash -and $overlay.version -ceq $package.Manifest.version) {
        Write-Output "Renderer already installed and verified: $($overlay.version). Press Ctrl+R in Discord."
        return
    }
    if (-not $PSCmdlet.ShouldProcess($target, "Update renderer to $($package.Manifest.version); apply with Ctrl+R")) { return }
    # Preserve the exact release and its manifest for later full install / diagnostics.
    if ($package.Manifest.version -cne $State.version) { Save-Package $package | Out-Null }
    Ensure-Directory $root
    $originalHash = $base.Manifest.files.Where({$_.path -ceq 'payload/runtime/renderer.js'})[0].sha256
    $previousHash = Save-RendererBlob $root ([IO.File]::ReadAllBytes($target))
    $hash = Save-RendererBlob $root $bytes
    Require ((Hash-File $target) -ceq $previousHash) 'Renderer changed during staging'
    Read-State | Out-Null
    $record = [ordered]@{schema=1;baseVersion=$State.version;baseManifestHash=$State.manifestHash;originalHash=$originalHash;version=$package.Manifest.version;hash=$hash;previousHash=$previousHash}
    # If interrupted here, Status reports pending. Retrying safely finishes the same update.
    Atomic-RendererFile (Join-Path $root 'current.json') (Json-Bytes $record)
    if ($TestCrashAfterStep -eq 1) { throw 'Simulated renderer interruption before activation' }
    Atomic-RendererFile $target $bytes
    Require ((Hash-File $target) -ceq $hash) 'Renderer activation failed verification'
    Write-Output "Renderer update complete: $($package.Manifest.version); native runtime $($State.version) unchanged. Press Ctrl+R in Discord."
}
