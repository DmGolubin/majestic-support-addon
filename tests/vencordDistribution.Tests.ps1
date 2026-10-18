# Run with Windows PowerShell 5.1: powershell -NoProfile -File tests/vencordDistribution.Tests.ps1
# Every resource, package and runtime path is under a fresh TEMP fixture. No Discord is launched.
param([string]$PayloadPackageRoot, [string]$Only = '*')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'distribution/vencord/installer'
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
    $manifest = @{schema=1;product='SupportTemplatesVencord';variant='vencord-full';version=$version;upstreamCommit='32c90633ce6a95d7e56c95479efbb431bacf1eac';files=$files}
    Put "$($f.Package)/manifest.json" ($manifest | ConvertTo-Json -Depth 10)
}
function Fixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('VencordFull-tests-' + [guid]::NewGuid().ToString('N'))
    $fixtures.Add($root)
    $f = [pscustomobject]@{Root=$root;Package="$root/package";Local="$root/localappdata";Resources="$root/localappdata/DiscordCanary/app-1.0.9/resources"}
    Put "$root/.vencord-full-fixture" 'VencordFull TEMP fixture'
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
        $output = & $powershell -NoProfile -ExecutionPolicy Bypass -File "$($f.Package)/VencordFull.ps1" -Action $action -TestRoot $f.Root -LocalAppDataRoot $f.Local @more 2>&1
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
try {
    Test 'install, idempotence, read-only status, uninstall exact bytes and retained settings' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        Run $f Install | Out-Null
        Assert ((Hash "$($f.Resources)/_app.asar") -eq $original) 'backup changed'
        Assert ((Hash "$($f.Resources)/app.asar") -eq (Hash "$($f.Package)/payload/loader.asar")) 'loader missing'
        $config = Get-Content "$($f.Resources)/support-templates-vencord.json" -Raw | ConvertFrom-Json
        Assert ($config.runtime -like '*\channels\canary\versions\0.1.0-canary.1\runtime') 'runtime contract'
        Assert ($null -eq $config.dataDir) 'Existing Vencord data location must not be overridden'
        $dataDir = "$($f.Root)/roaming/Vencord/settings"
        Put "$dataDir/settings.json" '{"keep":true}'
        Run $f Install | Out-Null
        $before = (Get-ChildItem $f.Root -File -Recurse | ForEach-Object { "$($_.FullName):$(Hash $_.FullName)" }) -join "`n"
        Assert ((Run $f Status) -match 'Installed') 'status missing'
        $after = (Get-ChildItem $f.Root -File -Recurse | ForEach-Object { "$($_.FullName):$(Hash $_.FullName)" }) -join "`n"
        Assert ($before -eq $after) 'status mutated files'
        Run $f Uninstall | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'original not restored'
        Assert (-not (Test-Path "$($f.Resources)/support-templates-vencord.json")) 'config retained'
        Assert ([IO.File]::ReadAllText("$dataDir/settings.json") -ceq '{"keep":true}') 'settings changed'
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
                config { Put "$($f.Resources)/support-templates-vencord.json" '{}' }
                state { Put "$($f.Resources)/support-templates-vencord.install.json" '{}' }
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
        foreach ($kind in @('app.asar','_app.asar','support-templates-vencord.json','runtime')) {
            $f = Fixture; Run $f Install | Out-Null
            $target = "$($f.Resources)/$kind"
            if ($kind -eq 'runtime') { $target = "$($f.Local)/SupportTemplatesVencord/channels/canary/versions/0.1.0-canary.1/runtime/patcher.js" }
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
                Assert (Test-Path "$($f.Resources)/.support-templates-vencord-transaction/journal.json") 'status recovered journal'
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
        Run $f Update | Out-Null
        Run $f Rollback | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $oldLoader) 'rollback loader differs'
        $config = Get-Content "$($f.Resources)/support-templates-vencord.json" -Raw | ConvertFrom-Json
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
        Assert (Test-Path "$($f.Resources)/.support-templates-vencord-transaction/journal.json") 'recovery deleted journal'
    }
    Test 'regression malformed journal cannot delete the only original archive' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        $transaction = "$($f.Resources)/.support-templates-vencord-transaction"
        $entries = @()
        foreach ($name in @('_app.asar','support-templates-vencord.json','app.asar','support-templates-vencord.install.json')) {
            $after = $null; if ($name -eq 'app.asar') { $after = $original }
            $entries += @{name=$name;before=$null;after=$after}
        }
        Put "$transaction/journal.json" (@{schema=1;product='SupportTemplatesVencord';variant='vencord-full';channel='canary';resources=[IO.Path]::GetFullPath($f.Resources);files=$entries} | ConvertTo-Json -Depth 10)
        [IO.File]::Copy("$($f.Resources)/app.asar", "$transaction/2.after")
        Run $f Uninstall @() $false | Out-Null
        Assert ((Hash "$($f.Resources)/app.asar") -eq $original) 'malformed journal deleted/changed original'
        Assert (Test-Path "$transaction/2.after") 'malformed journal deleted snapshot'
    }
    Test 'regression journal original identity cannot change between snapshots' {
        $f = Fixture; $original = Hash "$($f.Resources)/app.asar"
        Run $f Install @('-TestCrashAfterStep','1') $false | Out-Null
        $transaction = "$($f.Resources)/.support-templates-vencord-transaction"
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
            $cache = "$($f.Local)/SupportTemplatesVencord/channels/canary/versions/0.1.0-canary.1"
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
        Assert (-not (Test-Path "$($f.Resources)/support-templates-vencord.install.json") -and -not (Test-Path "$second/support-templates-vencord.install.json")) 'old state retained'
        Assert ([IO.File]::ReadAllText("$($f.Local)/Discord/app-1.0.1/resources/app.asar") -eq 'foreign stable fixture') 'uninstall changed other channel'
    }
    Test 'regression repair restores missing runtime while patching a new app version' {
        $f = Fixture; Run $f Install | Out-Null
        Remove-Item -LiteralPath "$($f.Local)/SupportTemplatesVencord/channels/canary/versions/0.1.0-canary.1/runtime/patcher.js"
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
            else { $link = "$($f.Local)/SupportTemplatesVencord" }
            try { New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null }
            catch { Write-Host "SKIP junction creation: $_"; continue }
            try { Run $f Install @() $false | Out-Null }
            finally { [IO.Directory]::Delete($link) }
        }
    }
    Test 'built real payload installs only into a TEMP Discord fixture' {
        if (-not $PayloadPackageRoot) { Write-Host 'SKIP real payload: supply -PayloadPackageRoot to test a built package'; return }
        $source = [IO.Path]::GetFullPath($PayloadPackageRoot)
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
        if (-not $full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $full -Leaf) -notmatch '^VencordFull-tests-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path' }
        if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
    }
}
