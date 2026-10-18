# Run with Windows PowerShell 5.1: powershell -NoProfile -File tests/standaloneInstaller.Tests.ps1
# Every resource, package and runtime path is under a fresh TEMP fixture. No Discord is launched.
param([string]$PayloadPackageRoot, [string]$Only = '*')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'standalone/installer'
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$fixtures = New-Object 'System.Collections.Generic.List[string]'
$passed = 0

function Assert($condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Put([string]$path, [string]$text) {
    [IO.Directory]::CreateDirectory((Split-Path $path -Parent)) | Out-Null
    [IO.File]::WriteAllText($path, $text, $utf8)
}
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function New-Asar([string]$path, [string]$mainText = 'module.exports = {};', [string]$packageText = '{"name":"discord","main":"index.js"}') {
    $pkg = $utf8.GetBytes($packageText)
    $js = $utf8.GetBytes($mainText)
    $table = @{ files = @{ 'package.json' = @{size=$pkg.Length;offset='0'}; 'index.js' = @{size=$js.Length;offset=[string]$pkg.Length} } } | ConvertTo-Json -Depth 10 -Compress
    $header = $utf8.GetBytes($table)
    $padded = [int]([Math]::Ceiling(($header.Length + 4) / 4.0) * 4)
    $stream = New-Object IO.MemoryStream
    $writer = New-Object IO.BinaryWriter($stream)
    $writer.Write([uint32]4); $writer.Write([uint32]($padded + 4))
    $writer.Write([uint32]$padded); $writer.Write([uint32]$header.Length)
    $writer.Write($header)
    for ($i = $header.Length + 4; $i -lt $padded; $i++) { $writer.Write([byte]0) }
    $writer.Write($pkg); $writer.Write($js)
    [IO.File]::WriteAllBytes($path, $stream.ToArray())
    $writer.Dispose(); $stream.Dispose()
}
function Manifest($f, [string]$version = '0.1.0-canary.1') {
    $files = @(Get-ChildItem -LiteralPath "$($f.Package)/payload" -File -Recurse | ForEach-Object {
        @{path=$_.FullName.Substring($f.Package.Length + 1).Replace('\','/');sha256=(Hash $_.FullName);size=$_.Length}
    })
    $manifest = @{schema=1;product='SupportTemplates';version=$version;upstreamCommit=('a' * 40);files=$files}
    Put "$($f.Package)/manifest.json" ($manifest | ConvertTo-Json -Depth 10)
}
function Fixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-installer-tests-' + [guid]::NewGuid().ToString('N'))
    $fixtures.Add($root)
    $f = [pscustomobject]@{Root=$root;Package="$root/package";Local="$root/localappdata";Resources="$root/localappdata/DiscordCanary/app-1.0.9/resources"}
    Put "$root/.support-templates-fixture" 'SupportTemplates installer TEMP fixture'
    [IO.Directory]::CreateDirectory($f.Resources) | Out-Null
    Put "$root/localappdata/DiscordCanary/app-1.0.9/DiscordCanary.exe" 'fixture, never executed'
    New-Asar "$($f.Resources)/app.asar"
    [IO.Directory]::CreateDirectory($f.Package) | Out-Null
    Copy-Item -Path "$installer/*" -Destination $f.Package -Recurse
    Put "$($f.Package)/payload/loader.asar" 'fixture loader bytes'
    foreach ($name in @('patcher.js','preload.js','renderer.js','renderer.css')) { Put "$($f.Package)/payload/runtime/$name" "fixture $name" }
    Manifest $f
    return $f
}
function Run($f, [string]$action, [string[]]$more = @(), [bool]$success = $true) {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $powershell -NoProfile -ExecutionPolicy Bypass -File "$($f.Package)/SupportTemplates.ps1" -Action $action -TestRoot $f.Root -LocalAppDataRoot $f.Local @more 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($success -and $code -ne 0) { throw "$action failed ($code): $output" }
    if (-not $success -and $code -eq 0) { throw "$action unexpectedly succeeded: $output" }
    return ($output -join "`n")
}
function Test([string]$name, [scriptblock]$body) {
    if ($name -notlike $Only) { return }
    & $body
    $script:passed++
    Write-Host "PASS $name"
}

# Include paths, content and write times: a no-op must not rewrite an identical file or leave staging directories.
function Tree-State([string]$root, [string[]]$exclude = @()) {
    (@(Get-ChildItem -LiteralPath $root -Force -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring([IO.Path]::GetFullPath($root).TrimEnd('\').Length + 1).Replace('\','/')
        if ($relative -notin $exclude) {
            if ($_.PSIsContainer) { "D:$relative" }
            else { "F:$relative`:$(Hash $_.FullName):$($_.LastWriteTimeUtc.Ticks)" }
        }
    })) -join "`n"
}
function Renderer-Payload($f, [string]$version) {
    $banner = "// SupportTemplates $version; based on Vencord $('a' * 40); upstream updater disabled.`n"
    foreach ($name in @('patcher.js','preload.js')) {
        # Only the first generated banner may be stripped; this second line is part of native identity.
        Put "$($f.Package)/payload/runtime/$name" ($banner + "// SupportTemplates native invariant`nmodule.exports = {fixture: true};`n")
    }
    Put "$($f.Package)/payload/runtime/renderer.js" ($banner + "globalThis.fixtureVersion = '$version';`nVencordNative.native.getRendererCss().then(css => { globalThis.fixtureCss = css; });`n")
    Put "$($f.Package)/payload/runtime/renderer.css" ('.fixture::before { content: "' + $version + ' \\ embedded"; }' + "`n.fixture { color: #f37fa3; }`n")
    Manifest $f $version
}
function Renderer-Fixture([switch]$AsarLoader) {
    $f = Fixture
    if ($AsarLoader) {
        New-Asar "$($f.Package)/payload/loader.asar" 'module.exports = {fixtureLoader: true};' '{"name":"support-templates-loader","main":"index.js","version":"0.1.0-canary.6"}'
    }
    Renderer-Payload $f '0.1.0-canary.6'
    Run $f Install | Out-Null
    $channel = "$($f.Local)/SupportTemplates/channels/canary"
    $f | Add-Member NoteProperty Channel $channel
    $f | Add-Member NoteProperty Base "$channel/versions/0.1.0-canary.6"
    $f | Add-Member NoteProperty Overlay "$channel/renderer-updates/0.1.0-canary.6"
    $f | Add-Member NoteProperty OriginalRenderer (Hash "$($f.Base)/runtime/renderer.js")
    Renderer-Payload $f '0.1.0-canary.7'
    return $f
}
function Assert-RendererRecord($f, [string]$version, [string]$previousHash) {
    $record = Get-Content -LiteralPath "$($f.Overlay)/current.json" -Raw | ConvertFrom-Json
    Assert ($record.schema -eq 1 -and $record.baseVersion -ceq '0.1.0-canary.6') 'overlay base/schema incorrect'
    Assert ($record.version -ceq $version) 'overlay release incorrect'
    Assert ($record.baseManifestHash -ceq (Hash "$($f.Base)/manifest.json")) 'overlay base manifest changed'
    Assert ($record.originalHash -ceq $f.OriginalRenderer) 'overlay lost original renderer identity'
    Assert ($record.previousHash -ceq $previousHash) 'overlay previous renderer identity incorrect'
    Assert ($record.hash -ceq (Hash "$($f.Base)/runtime/renderer.js")) 'overlay does not describe live renderer'
    foreach ($hash in @($record.originalHash, $record.previousHash, $record.hash)) {
        Assert ((Hash "$($f.Overlay)/$hash.js") -ceq $hash) 'renderer recovery blob does not match its name'
    }
}

try {
    Test 'renderer update while running embeds CSS and changes only the active renderer in the base runtime' {
        $f = Renderer-Fixture
        $resources = Tree-State $f.Resources
        $base = Tree-State $f.Base @('runtime/renderer.js')
        $package = Tree-State $f.Package
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Assert ((Tree-State $f.Resources) -ceq $resources) 'renderer update changed loader, backup or ownership/config sidecars'
        Assert ((Tree-State $f.Base @('runtime/renderer.js')) -ceq $base) 'renderer update changed base native/CSS/manifest bytes'
        Assert ((Tree-State $f.Package) -ceq $package) 'renderer update changed its source package'
        $css = [IO.File]::ReadAllText("$($f.Package)/payload/runtime/renderer.css")
        $source = [IO.File]::ReadAllText("$($f.Package)/payload/runtime/renderer.js")
        $expected = $source.Replace('VencordNative.native.getRendererCss()', ('Promise.resolve(' + (ConvertTo-Json -InputObject $css -Compress) + ')'))
        Assert ([IO.File]::ReadAllText("$($f.Base)/runtime/renderer.js") -ceq $expected) 'renderer did not embed exact escaped release CSS'
        Assert-RendererRecord $f '0.1.0-canary.7' $f.OriginalRenderer
        $staged = "$($f.Channel)/versions/0.1.0-canary.7"
        Assert ((Hash "$staged/manifest.json") -ceq (Hash "$($f.Package)/manifest.json")) 'staged release manifest changed'
        foreach ($file in Get-ChildItem -LiteralPath "$($f.Package)/payload" -File -Recurse) {
            $relative = $file.FullName.Substring([IO.Path]::GetFullPath("$($f.Package)/payload").Length + 1)
            Assert ((Hash (Join-Path $staged $relative)) -ceq (Hash $file.FullName)) "staged release payload changed: $relative"
        }
    }
    Test 'renderer update status is read-only and repeated activation is idempotent' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        $before = Tree-State $f.Root
        $status = Run $f Status @('-TestRunningTarget')
        Assert ($status -match 'Installed: SupportTemplates 0\.1\.0-canary\.6') 'status lost base runtime version'
        Assert ($status -match 'Renderer: 0\.1\.0-canary\.7') 'status lost renderer version'
        Run $f Status | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'renderer status wrote files'
        Assert ((Run $f UpdateRenderer @('-TestRunningTarget')) -match 'already installed and verified') 'renderer no-op not reported'
        Assert ((Tree-State $f.Root) -ceq $before) 'idempotent renderer update wrote files'
    }
    Test 'renderer update accepts loader package version changes with identical index.js' {
        $f = Renderer-Fixture -AsarLoader
        New-Asar "$($f.Package)/payload/loader.asar" 'module.exports = {fixtureLoader: true};' '{"name":"support-templates-loader","main":"index.js","version":"0.1.0-canary.7"}'
        Manifest $f '0.1.0-canary.7'
        $installedLoader = Hash "$($f.Resources)/app.asar"
        Assert ($installedLoader -cne (Hash "$($f.Package)/payload/loader.asar")) 'loader metadata fixture bytes did not change'
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -ceq $installedLoader) 'renderer update replaced loader'
        Assert-RendererRecord $f '0.1.0-canary.7' $f.OriginalRenderer
    }
    Test 'renderer update rejects native, loader and nonleading banner changes without mutation' {
        foreach ($kind in @('patcher','preload','second-banner','loader','upstream')) {
            $f = Renderer-Fixture -AsarLoader
            switch ($kind) {
                patcher { Add-Content -LiteralPath "$($f.Package)/payload/runtime/patcher.js" -Value 'module.exports.changed = true;' }
                preload { Add-Content -LiteralPath "$($f.Package)/payload/runtime/preload.js" -Value 'module.exports.changed = true;' }
                second-banner {
                    $path = "$($f.Package)/payload/runtime/patcher.js"
                    Put $path ([IO.File]::ReadAllText($path).Replace('// SupportTemplates native invariant', '// SupportTemplates native CHANGED'))
                }
                loader { New-Asar "$($f.Package)/payload/loader.asar" 'module.exports = {fixtureLoader: false};' '{"name":"support-templates-loader","main":"index.js","version":"0.1.0-canary.7"}' }
            }
            Manifest $f '0.1.0-canary.7'
            if ($kind -eq 'upstream') {
                $manifest = Get-Content -LiteralPath "$($f.Package)/manifest.json" -Raw | ConvertFrom-Json
                $manifest.upstreamCommit = 'b' * 40
                Put "$($f.Package)/manifest.json" ($manifest | ConvertTo-Json -Depth 10)
            }
            $before = Tree-State $f.Root
            $errorText = Run $f UpdateRenderer @('-TestRunningTarget') $false
            $reason = switch ($kind) {
                preload { 'preload\.js changed' }
                loader { 'Loader changed' }
                upstream { 'Framework changed' }
                default { 'patcher\.js changed' }
            }
            Assert ($errorText -match $reason) "$kind failed for an unrelated reason: $errorText"
            Assert ((Tree-State $f.Root) -ceq $before) "$kind incompatibility mutated files"
        }
    }
    Test 'renderer update requires exactly one native CSS expression' {
        foreach ($count in @(0,2)) {
            $f = Renderer-Fixture
            Put "$($f.Package)/payload/runtime/renderer.js" ("globalThis.fixture = true;`n" + ('VencordNative.native.getRendererCss();' * $count))
            Manifest $f '0.1.0-canary.7'
            $before = Tree-State $f.Root
            $errorText = Run $f UpdateRenderer @('-TestRunningTarget') $false
            Assert ($errorText -match 'renderer CSS entry') "CSS expression count failed for an unrelated reason: $errorText"
            Assert ((Tree-State $f.Root) -ceq $before) "$count CSS expressions mutated files"
        }
    }
    Test 'renderer update sequential releases preserve original and immutable staged packages' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        $previous = Hash "$($f.Base)/runtime/renderer.js"
        $staged = Tree-State "$($f.Channel)/versions/0.1.0-canary.7"
        $base = Tree-State $f.Base @('runtime/renderer.js')
        Renderer-Payload $f '0.1.0-canary.8'
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Assert-RendererRecord $f '0.1.0-canary.8' $previous
        Assert ((Tree-State "$($f.Channel)/versions/0.1.0-canary.7") -ceq $staged) 'second update mutated staged .7 release'
        Assert ((Tree-State $f.Base @('runtime/renderer.js')) -ceq $base) 'second update mutated base runtime'
        Assert ((Run $f Status) -match 'Renderer: 0\.1\.0-canary\.8') 'second renderer version not reported'
    }
    Test 'renderer update WhatIf makes no writes before or after an overlay' {
        $f = Renderer-Fixture
        $before = Tree-State $f.Root
        Run $f UpdateRenderer @('-TestRunningTarget','-WhatIf') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'initial renderer WhatIf wrote files'
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Renderer-Payload $f '0.1.0-canary.8'
        $before = Tree-State $f.Root
        Run $f UpdateRenderer @('-TestRunningTarget','-WhatIf') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'subsequent renderer WhatIf wrote files'
        Run $f Install @('-WhatIf') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'normal install WhatIf restored or changed overlay'
    }
    Test 'renderer update refuses tampered live renderer before or after activation' {
        foreach ($activated in @($false,$true)) {
            $f = Renderer-Fixture
            if ($activated) { Run $f UpdateRenderer | Out-Null; Renderer-Payload $f '0.1.0-canary.8' }
            Put "$($f.Base)/runtime/renderer.js" 'foreign renderer replacement'
            $before = Tree-State $f.Root
            Run $f UpdateRenderer @('-TestRunningTarget') $false | Out-Null
            Run $f Status @() $false | Out-Null
            if ($activated) { Run $f Install @() $false | Out-Null }
            Assert ((Tree-State $f.Root) -ceq $before) 'tampered renderer was overwritten or staged over'
        }
    }
    Test 'renderer update interruption reports pending without writes and retry activates safely' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget','-TestCrashAfterStep','1') $false | Out-Null
        Assert ((Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'crash hook replaced renderer before journal-only boundary'
        Assert (Test-Path -LiteralPath "$($f.Overlay)/current.json") 'interrupted renderer journal missing'
        $before = Tree-State $f.Root
        Assert ((Run $f Status) -match 'Pending renderer update') 'interruption not reported as pending'
        Assert ((Tree-State $f.Root) -ceq $before) 'pending renderer status performed recovery'
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Assert-RendererRecord $f '0.1.0-canary.7' $f.OriginalRenderer
        Assert ((Run $f Status) -match 'Renderer: 0\.1\.0-canary\.7') 'retry did not finish activation'
    }
    Test 'renderer update full install afterward restores base and installs immutable staged release' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        $before = Tree-State $f.Root
        Run $f Install @('-TestRunningTarget') $false | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'running full install mutated renderer overlay'
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'full install did not restore original base renderer'
        Assert (-not (Test-Path -LiteralPath "$($f.Overlay)/current.json")) 'full install retained active overlay record'
        $config = Get-Content -LiteralPath "$($f.Resources)/support-templates.json" -Raw | ConvertFrom-Json
        Assert ($config.runtime -like '*\0.1.0-canary.7\runtime') 'full install did not select .7 runtime'
        Assert ((Hash "$($config.runtime)/renderer.js") -ceq (Hash "$($f.Package)/payload/runtime/renderer.js")) 'full install used transformed renderer in staged release'
        Run $f Status | Out-Null
        Run $f Rollback | Out-Null
        Assert ((Run $f Status) -match 'Installed: SupportTemplates 0\.1\.0-canary\.6') 'rollback after full install failed'
    }
    Test 'renderer update stopped repair and rollback restore the base overlay' {
        foreach ($action in @('Repair','Rollback')) {
            $f = Fixture
            Renderer-Payload $f '0.1.0-canary.5'; Run $f Install | Out-Null
            Renderer-Payload $f '0.1.0-canary.6'; Run $f Install | Out-Null
            $channel = "$($f.Local)/SupportTemplates/channels/canary"
            $base = "$channel/versions/0.1.0-canary.6"
            $original = Hash "$base/runtime/renderer.js"
            Renderer-Payload $f '0.1.0-canary.7'; Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
            $before = Tree-State $f.Root
            Run $f $action @('-TestRunningTarget') $false | Out-Null
            Assert ((Tree-State $f.Root) -ceq $before) "running $action restored overlay"
            Run $f $action | Out-Null
            Assert ((Hash "$base/runtime/renderer.js") -ceq $original) "$action did not restore base renderer"
            Assert (-not (Test-Path -LiteralPath "$channel/renderer-updates/0.1.0-canary.6/current.json")) "$action retained overlay record"
            Run $f Status | Out-Null
        }
    }
    Test 'renderer update same-version install preserves overlay and altered package rejection does not restore it' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Renderer-Payload $f '0.1.0-canary.6'
        $before = Tree-State $f.Root
        Run $f Install | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'same-version install changed the valid renderer overlay'
        Assert ((Run $f Status) -match 'Renderer: 0\.1\.0-canary\.7') 'same-version install deactivated overlay'
        Add-Content -LiteralPath "$($f.Package)/payload/runtime/renderer.js" -Value 'globalThis.alteredPackage = true;'
        Manifest $f '0.1.0-canary.6'
        $before = Tree-State $f.Root
        foreach ($action in @('Install','Repair')) {
            $errorText = Run $f $action @() $false
            Assert ($errorText -match 'Same version has different package content') "$action failed for an unrelated reason: $errorText"
            Assert ((Tree-State $f.Root) -ceq $before) "rejected same-version $action changed overlay"
        }
    }
    Test 'renderer update failed full install transaction preserves active overlay' {
        foreach ($step in 1..4) {
            $f = Renderer-Fixture
            Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
            $base = Tree-State $f.Base
            $overlay = Tree-State $f.Overlay
            $owned = @{}
            foreach ($name in @('app.asar','_app.asar','support-templates.json','support-templates.install.json')) {
                $owned[$name] = Hash "$($f.Resources)/$name"
            }
            $errorText = Run $f Install @('-TestFailAfterStep',"$step") $false
            Assert ($errorText -match "Simulated write failure after step $step") "install failed for an unrelated reason: $errorText"
            Assert ((Tree-State $f.Base) -ceq $base) "failed install step $step changed base runtime/active renderer"
            Assert ((Tree-State $f.Overlay) -ceq $overlay) "failed install step $step changed overlay record/blobs"
            foreach ($name in $owned.Keys) {
                Assert ((Hash "$($f.Resources)/$name") -ceq $owned[$name]) "failed install step $step did not restore $name"
            }
            Assert ((Run $f Status) -match 'Renderer: 0\.1\.0-canary\.7') "failed install step $step deactivated overlay"
            if ($step -eq 4) {
                $before = Tree-State $f.Root
                Assert ((Run $f Status) -match 'Pending full-install renderer cleanup') 'failed full install lost cleanup intent'
                Assert ((Run $f UpdateRenderer @('-TestRunningTarget') $false) -match 'Finish the interrupted full installation') 'renderer update ignored unfinished full operation'
                Assert ((Tree-State $f.Root) -ceq $before) 'status or refused update changed cleanup intent'
                Renderer-Payload $f '0.1.0-canary.6'
                Run $f Install | Out-Null
                Assert (-not (Test-Path -LiteralPath "$($f.Channel)/renderer-cleanup.json")) 'rolled-back cleanup intent was not discarded'
                Assert ((Tree-State $f.Base) -ceq $base) 'discarding rolled-back intent restored active overlay'
                Assert ((Tree-State $f.Overlay) -ceq $overlay) 'discarding rolled-back intent changed overlay journal'
                Renderer-Payload $f '0.1.0-canary.7'
            }
            Run $f Install | Out-Null
            Assert ((Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'successful retry did not restore base'
        }
    }
    Test 'renderer update uninstall retains overlay cache and reinstalling base restores original renderer' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        $base = Tree-State $f.Base
        $overlay = Tree-State $f.Overlay
        $originalApp = Hash "$($f.Resources)/_app.asar"
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -ceq $originalApp) 'uninstall did not restore Discord archive'
        Assert ((Tree-State $f.Base) -ceq $base) 'uninstall modified retained renderer cache'
        Assert ((Tree-State $f.Overlay) -ceq $overlay) 'uninstall modified retained overlay record/blobs'
        Renderer-Payload $f '0.1.0-canary.6'
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'reinstall of .6 did not restore original renderer'
        Assert (-not (Test-Path -LiteralPath "$($f.Overlay)/current.json")) 'reinstall retained stale active overlay'
        $status = Run $f Status
        Assert ($status -match 'Installed: SupportTemplates 0\.1\.0-canary\.6') 'reinstall selected wrong runtime'
        Assert ($status -notmatch 'Renderer: 0\.1\.0-canary\.7') 'reinstall reported stale renderer'
    }
    Test 'renderer update committed full-install cleanup resumes read-only status and stopped retry' {
        $f = Renderer-Fixture
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Run $f Install @('-TestCrashAfterStep','4') $false | Out-Null
        # All resource writes committed; move the fixture journal aside to model a crash immediately
        # after normal transaction cleanup and before renderer cleanup. Never touch a real installation.
        $source = [IO.Path]::GetFullPath("$($f.Resources)/.support-templates-transaction")
        $saved = [IO.Path]::GetFullPath("$($f.Root)/committed-journal.saved")
        $boundary = [IO.Path]::GetFullPath($f.Root).TrimEnd('\') + '\'
        Assert ($source.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase) -and $saved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) 'Unsafe committed journal fixture move'
        Move-Item -LiteralPath $source -Destination $saved
        $before = Tree-State $f.Root
        $status = Run $f Status
        Assert ($status -match 'Installed: SupportTemplates 0\.1\.0-canary\.7' -and $status -match 'Pending full-install renderer cleanup') 'committed cleanup status incorrect'
        Assert ((Run $f UpdateRenderer @('-TestRunningTarget') $false) -match 'Finish the interrupted full installation') 'update ignored committed cleanup intent'
        Run $f Install @('-TestRunningTarget') $false | Out-Null
        Run $f Install @('-WhatIf') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'read-only or running operations completed pending cleanup'
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'retry did not restore old base after committed full install'
        Assert (-not (Test-Path -LiteralPath "$($f.Overlay)/current.json")) 'retry retained old active overlay'
        Assert (-not (Test-Path -LiteralPath "$($f.Channel)/renderer-cleanup.json")) 'retry retained completed cleanup intent'
        Assert ((Run $f Status) -notmatch 'Pending') 'retry still reports pending cleanup'
    }
    Test 'install, idempotence, read-only status, uninstall exact bytes and retained settings' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Resources)/_app.asar") -eq $original) 'backup changed'
        Assert ((Hash "$($f.Resources)/app.asar") -eq (Hash "$($f.Package)/payload/loader.asar")) 'loader missing'
        $config = Get-Content "$($f.Resources)/support-templates.json" -Raw | ConvertFrom-Json
        Assert ($config.runtime -like '*\channels\canary\versions\0.1.0-canary.1\runtime') 'runtime contract'
        Assert ($config.dataDir -like '*\channels\canary\data') 'data contract'
        Put "$($config.dataDir)/settings.json" '{"keep":true}'
        Run $f Install | Out-Null
        $before = (Get-ChildItem $f.Root -File -Recurse | ForEach-Object { "$($_.FullName):$(Hash $_.FullName)" }) -join "`n"
        Assert ((Run $f Status) -match 'Installed') 'status missing'
        $after = (Get-ChildItem $f.Root -File -Recurse | ForEach-Object { "$($_.FullName):$(Hash $_.FullName)" }) -join "`n"
        Assert ($before -eq $after) 'status mutated files'
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'original not restored'
        Assert (-not (Test-Path "$($f.Resources)/support-templates.json")) 'config retained'
        Assert (Test-Path "$($config.dataDir)/settings.json") 'settings deleted'
        Run $f Uninstall | Out-Null
    }
    Test 'WhatIf performs no writes' {
        $f = Fixture
        $before = @(Get-ChildItem $f.Root -Recurse).Count
        Run $f Install @('-WhatIf') | Out-Null
        Assert (@(Get-ChildItem $f.Root -Recurse).Count -eq $before) 'WhatIf wrote files'
    }
    Test 'manifest missing, extra, size, hash and traversal rejection' {
        foreach ($kind in @('missing','extra','size','hash','traversal','duplicate','reserved')) {
            $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
            $m = Get-Content "$($f.Package)/manifest.json" -Raw | ConvertFrom-Json
            switch ($kind) {
                missing { Remove-Item "$($f.Package)/payload/runtime/preload.js" }
                extra { Put "$($f.Package)/payload/runtime/extra.js" 'extra' }
                size { $m.files[0].size++ }
                hash { $m.files[0].sha256 = '0' * 64 }
                traversal { $m.files[0].path = 'payload/../escape' }
                duplicate { $m.files += $m.files[0] }
                reserved { $m.files[0].path = 'payload/runtime/CON.txt' }
            }
            Put "$($f.Package)/manifest.json" ($m | ConvertTo-Json -Depth 10)
            Run $f Install @() $false | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $original) "$kind changed original"
        }
    }
    Test 'running target denial before mutation; other channel allowed' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        Run $f Install @('-TestRunningTarget') $false | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'running denial changed original'
        Run $f Install @('-TestRunningOtherChannel') | Out-Null
        Run $f Uninstall @('-TestRunningTarget') $false | Out-Null
    }
    Test 'foreign mods, unknown ASAR and sidecars rejected' {
        foreach ($kind in @('backup','appdir','config','state','asar','modloader','asar-modloader')) {
            $f = Fixture
            switch ($kind) {
                backup { Put "$($f.Resources)/_app.asar" 'foreign' }
                appdir { [IO.Directory]::CreateDirectory("$($f.Resources)/app") | Out-Null }
                config { Put "$($f.Resources)/support-templates.json" '{}' }
                state { Put "$($f.Resources)/support-templates.install.json" '{}' }
                asar { Put "$($f.Resources)/app.asar" 'unknown' }
                modloader { Put "$($f.Resources)/app.asar" 'Vencord' }
                asar-modloader { New-Asar "$($f.Resources)/app.asar" 'require("vencord");' }
            }
            $before = Hash "$($f.Resources)/app.asar"
            Run $f Install @() $false | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $before) "$kind overwritten"
        }
    }
    Test 'installed loader, backup, config and runtime tamper fail closed' {
        foreach ($kind in @('app.asar','_app.asar','support-templates.json','runtime')) {
            $f = Fixture; Run $f Install | Out-Null
            $target = "$($f.Resources)/$kind"
            if ($kind -eq 'runtime') { $target = "$($f.Local)/SupportTemplates/channels/canary/versions/0.1.0-canary.1/runtime/patcher.js" }
            Put $target 'tampered'
            Run $f Repair @() $false | Out-Null
            if ($kind -eq 'runtime') { Run $f Uninstall | Out-Null }
            else { Run $f Uninstall @() $false | Out-Null }
            Assert ([IO.File]::ReadAllText($target) -eq 'tampered') 'tampered file overwritten'
        }
    }
    Test 'write failures roll back at every install step' {
        foreach ($step in 1..4) {
            $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
            Run $f Install @('-TestFailAfterStep',"$step") $false | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $original) "failure step $step did not restore"
            Run $f Install | Out-Null
            Run $f Uninstall | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'retry restore failed'
        }
    }
    Test 'real Windows sharing violation leaves the original recoverable' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        $held = [IO.File]::Open("$($f.Resources)/app.asar", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { Run $f Install @() $false | Out-Null }
        finally { $held.Dispose() }
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'locked original changed'
        Run $f Install | Out-Null
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'sharing violation retry did not restore'
    }
    Test 'interrupted install and uninstall recover on next mutation; status stays read-only' {
        foreach ($action in @('Install','Uninstall')) {
            foreach ($step in 1..4) {
                $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
                if ($action -eq 'Uninstall') { Run $f Install | Out-Null }
                Run $f $action @('-TestCrashAfterStep',"$step") $false | Out-Null
                Assert ((Run $f Status) -match 'Pending') 'pending journal not reported'
                Assert (Test-Path "$($f.Resources)/.support-templates-transaction/journal.json") 'status recovered journal'
                Run $f Uninstall | Out-Null
                Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'crash recovery lost original'
            }
        }
    }
    Test 'rollback previous runtime and loader' {
        $f = Fixture; Run $f Install | Out-Null
        $oldLoader = Hash "$($f.Resources)/app.asar"
        Put "$($f.Package)/payload/loader.asar" 'new loader'
        Put "$($f.Package)/payload/runtime/patcher.js" 'new patcher'
        Manifest $f '0.1.0-canary.2'
        Run $f Install | Out-Null
        Run $f Rollback | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $oldLoader) 'rollback loader differs'
        $config = Get-Content "$($f.Resources)/support-templates.json" -Raw | ConvertFrom-Json
        Assert ($config.runtime -like '*\0.1.0-canary.1\runtime') 'rollback runtime differs'
    }
    Test 'failed uninstall restores the installed state at every step' {
        foreach ($step in 1..4) {
            $f = Fixture; Run $f Install | Out-Null
            $loader = Hash "$($f.Resources)/app.asar"; $backup = Hash "$($f.Resources)/_app.asar"
            Run $f Uninstall @('-TestFailAfterStep',"$step") $false | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $loader) 'failed uninstall lost loader'
            Assert ((Hash "$($f.Resources)/_app.asar") -eq $backup) 'failed uninstall lost backup'
            Assert ((Run $f Status) -match 'Installed') 'failed uninstall not fully recovered'
        }
    }
    Test 'interrupted runtime upgrade recovers the previous version' {
        foreach ($step in 1..4) {
            $f = Fixture; Run $f Install | Out-Null
            $oldLoader = Hash "$($f.Resources)/app.asar"; $original = Hash "$($f.Resources)/_app.asar"
            Put "$($f.Package)/payload/loader.asar" 'new loader'
            Manifest $f '0.1.0-canary.2'
            Run $f Install @('-TestCrashAfterStep',"$step") $false | Out-Null
            # Rollback triggers recovery first. No older runtime exists in the recovered state.
            Run $f Rollback @() $false | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $oldLoader) 'upgrade recovery lost previous loader'
            Assert ((Hash "$($f.Resources)/_app.asar") -eq $original) 'upgrade recovery changed backup'
            Assert ((Run $f Status) -match '0.1.0-canary.1') 'upgrade recovery version incorrect'
        }
    }
    Test 'pending recovery refuses foreign modification before writing any target' {
        $f = Fixture
        Run $f Install @('-TestCrashAfterStep','3') $false | Out-Null
        Put "$($f.Resources)/app.asar" 'foreign replacement while interrupted'
        $backup = Hash "$($f.Resources)/_app.asar"
        Run $f Repair @() $false | Out-Null
        Assert ([IO.File]::ReadAllText("$($f.Resources)/app.asar") -eq 'foreign replacement while interrupted') 'recovery overwrote unknown app'
        Assert ((Hash "$($f.Resources)/_app.asar") -eq $backup) 'recovery altered backup'
        Assert (Test-Path "$($f.Resources)/.support-templates-transaction/journal.json") 'recovery deleted journal'
    }
    Test 'regression malformed journal cannot delete the only original archive' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        $transaction = "$($f.Resources)/.support-templates-transaction"
        $entries = @()
        foreach ($name in @('_app.asar','support-templates.json','app.asar','support-templates.install.json')) {
            $after = $null; if ($name -eq 'app.asar') { $after = $original }
            $entries += @{name=$name;before=$null;after=$after}
        }
        Put "$transaction/journal.json" (@{schema=1;product='SupportTemplates';channel='canary';resources=[IO.Path]::GetFullPath($f.Resources);files=$entries} | ConvertTo-Json -Depth 10)
        [IO.File]::Copy("$($f.Resources)/app.asar", "$transaction/2.after")
        Run $f Uninstall @() $false | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'malformed journal deleted/changed original'
        Assert (Test-Path "$transaction/2.after") 'malformed journal deleted snapshot'
    }
    Test 'regression journal original identity cannot change between snapshots' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        Run $f Install @('-TestCrashAfterStep','1') $false | Out-Null
        $transaction = "$($f.Resources)/.support-templates-transaction"
        $journal = Get-Content "$transaction/journal.json" -Raw | ConvertFrom-Json
        New-Asar "$transaction/2.before" 'module.exports = {different: true};'
        $journal.files[2].before = Hash "$transaction/2.before"
        Put "$transaction/journal.json" ($journal | ConvertTo-Json -Depth 10)
        # Make the live original match the forged before hash so ordinary per-file checks pass.
        [IO.File]::Copy("$transaction/2.before", "$($f.Resources)/app.asar", $true)
        $changed = Hash "$($f.Resources)/app.asar"
        Run $f Uninstall @() $false | Out-Null
        Assert ((Hash "$($f.Resources)/_app.asar") -eq $original) 'journal identity mismatch destroyed original backup'
        Assert ((Hash "$($f.Resources)/app.asar") -eq $changed) 'journal identity mismatch wrote a target'
    }
    Test 'regression missing runtime can be repaired or uninstalled independently' {
        foreach ($missing in @('runtime/patcher.js','manifest.json','whole-cache')) {
            $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
            Run $f Install | Out-Null
            $cache = "$($f.Local)/SupportTemplates/channels/canary/versions/0.1.0-canary.1"
            # Move only an explicitly bounded fixture path; keep bytes for comparison.
            $source = $cache; if ($missing -ne 'whole-cache') { $source = "$cache/$missing" }
            Assert ([IO.Path]::GetFullPath($source).StartsWith([IO.Path]::GetFullPath($f.Root) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Unsafe cache fixture move'
            Move-Item -LiteralPath $source -Destination "$($f.Root)/cache.saved"
            Run $f Repair | Out-Null
            Assert ((Hash "$cache/runtime/patcher.js") -eq (Hash "$($f.Package)/payload/runtime/patcher.js")) 'missing runtime not restored'
            Run $f Status | Out-Null
            Remove-Item -LiteralPath "$cache/runtime/patcher.js"
            Run $f Uninstall | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'missing cache prevented original restore'
        }
    }
    Test 'regression uninstall restores all owned versions and leaves the other channel alone' {
        $f = Fixture; $firstOriginal = Hash "$($f.Resources)/app.asar"
        Run $f Install | Out-Null
        $second = "$($f.Local)/DiscordCanary/app-1.0.10/resources"
        [IO.Directory]::CreateDirectory($second) | Out-Null
        New-Asar "$second/app.asar" 'module.exports = {version: 10};'
        Put "$($f.Local)/DiscordCanary/app-1.0.10/DiscordCanary.exe" 'fixture'
        $secondOriginal = Hash "$second/app.asar"
        Run $f Repair | Out-Null
        # A newer unpatched version must not hide the two old owned installations.
        $third = "$($f.Local)/DiscordCanary/app-1.0.11/resources"
        [IO.Directory]::CreateDirectory($third) | Out-Null
        New-Asar "$third/app.asar"; Put "$($f.Local)/DiscordCanary/app-1.0.11/DiscordCanary.exe" 'fixture'
        Put "$($f.Local)/Discord/app-1.0.1/resources/app.asar" 'foreign stable fixture'
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $firstOriginal) 'oldest owned version remained patched'
        Assert ((Hash "$second/app.asar") -eq $secondOriginal) 'second owned version remained patched'
        Assert (-not (Test-Path "$($f.Resources)/support-templates.install.json") -and -not (Test-Path "$second/support-templates.install.json")) 'old state retained'
        Assert ([IO.File]::ReadAllText("$($f.Local)/Discord/app-1.0.1/resources/app.asar") -eq 'foreign stable fixture') 'uninstall changed other channel'
    }
    Test 'regression repair restores missing runtime while patching a new app version' {
        $f = Fixture; Run $f Install | Out-Null
        Remove-Item -LiteralPath "$($f.Local)/SupportTemplates/channels/canary/versions/0.1.0-canary.1/runtime/patcher.js"
        $next = "$($f.Local)/DiscordCanary/app-1.0.10/resources"
        [IO.Directory]::CreateDirectory($next) | Out-Null
        New-Asar "$next/app.asar"; Put "$($f.Local)/DiscordCanary/app-1.0.10/DiscordCanary.exe" 'fixture'
        Run $f Repair | Out-Null
        Run $f Status | Out-Null
        Run $f Uninstall | Out-Null
    }
    Test 'batch wrappers preserve success and failure exit codes' {
        $f = Fixture
        $savedPause = $env:SUPPORT_TEMPLATES_NO_PAUSE
        $savedPreference = $ErrorActionPreference
        $env:SUPPORT_TEMPLATES_NO_PAUSE = '1'
        $ErrorActionPreference = 'Continue'
        try {
            $command = '""{0}\status.bat" -TestRoot "{1}" -LocalAppDataRoot "{2}""' -f $f.Package, $f.Root, $f.Local
            $output = & $env:ComSpec /d /s /c $command 2>&1
            Assert ($LASTEXITCODE -eq 0) "batch status failed: $output"
            Put "$($f.Resources)/app.asar" 'unknown archive'
            $output = & $env:ComSpec /d /s /c $command 2>&1
            Assert ($LASTEXITCODE -eq 1) "batch did not preserve failure: $output"
        }
        finally { $env:SUPPORT_TEMPLATES_NO_PAUSE = $savedPause; $ErrorActionPreference = $savedPreference }
    }
    Test 'latest numeric app version and repair after Discord update' {
        $f = Fixture; Run $f Install | Out-Null
        $next = "$($f.Local)/DiscordCanary/app-1.0.10/resources"
        [IO.Directory]::CreateDirectory($next) | Out-Null
        New-Asar "$next/app.asar"; Put "$($f.Local)/DiscordCanary/app-1.0.10/DiscordCanary.exe" 'fixture'
        $original = Hash "$next/app.asar"
        Run $f Repair | Out-Null
        Assert ((Hash "$next/_app.asar") -eq $original) 'repair selected wrong version'
    }
    Test 'Stable is explicit and isolated in TEMP' {
        $f = Fixture
        $stable = "$($f.Local)/Discord/app-1.0.1/resources"
        [IO.Directory]::CreateDirectory($stable) | Out-Null
        New-Asar "$stable/app.asar"; Put "$($f.Local)/Discord/app-1.0.1/Discord.exe" 'fixture'
        $canary = Hash "$($f.Resources)/app.asar"
        Run $f Install @('-Channel','Stable') | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $canary) 'Stable touched Canary'
        Run $f Uninstall @('-Channel','Stable') | Out-Null
    }
    Test 'test-root escape denied' {
        $f = Fixture
        Run $f Install @('-LocalAppDataRoot',"$($f.Root)/elsewhere") $false | Out-Null
    }
    Test 'junction payload refused when junction creation is available' {
        $f = Fixture
        Put "$($f.Root)/external/file.js" 'external'
        try { New-Item -ItemType Junction -Path "$($f.Package)/payload/runtime/linked" -Target "$($f.Root)/external" -ErrorAction Stop | Out-Null }
        catch { Write-Host "SKIP junction creation: $_"; return }
        try { Run $f Install @() $false | Out-Null }
        finally { [IO.Directory]::Delete("$($f.Package)/payload/runtime/linked") }
    }
    Test 'junction resources and runtime store refused when available' {
        foreach ($kind in @('resources','store')) {
            $f = Fixture
            $target = "$($f.Root)/external"
            [IO.Directory]::CreateDirectory($target) | Out-Null
            if ($kind -eq 'resources') {
                $link = $f.Resources
                Move-Item -LiteralPath "$link/app.asar" -Destination "$target/app.asar"
                [IO.Directory]::Delete($link)
            }
            else { $link = "$($f.Local)/SupportTemplates" }
            try { New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null }
            catch { Write-Host "SKIP junction creation: $_"; continue }
            try { Run $f Install @() $false | Out-Null }
            finally { [IO.Directory]::Delete($link) }
        }
    }
    Test 'built real payload installs only into a TEMP Discord fixture' {
        if (-not $PayloadPackageRoot) { Write-Host 'SKIP real payload: supply -PayloadPackageRoot to test a built package'; return }
        $source = [IO.Path]::GetFullPath($PayloadPackageRoot)
        Assert ($source.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) 'Built payload must be in TEMP'
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        $fixturePayload = [IO.Path]::GetFullPath("$($f.Package)/payload")
        Assert ($fixturePayload.StartsWith([IO.Path]::GetFullPath($f.Root) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Unsafe payload replacement'
        Remove-Item -LiteralPath $fixturePayload -Recurse -Force
        Copy-Item -LiteralPath "$source/payload" -Destination $fixturePayload -Recurse
        Copy-Item -LiteralPath "$source/manifest.json" -Destination "$($f.Package)/manifest.json" -Force
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq (Hash "$source/payload/loader.asar")) 'real loader copy differs'
        Run $f Status | Out-Null
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'real payload fixture original restore failed'
    }
    Write-Host "$passed installer fixture groups passed on PowerShell $($PSVersionTable.PSVersion)."
}
finally {
    foreach ($root in $fixtures) {
        $full = [IO.Path]::GetFullPath($root)
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $full -Leaf) -notmatch '^SupportTemplates-installer-tests-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path' }
        if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
    }
}
