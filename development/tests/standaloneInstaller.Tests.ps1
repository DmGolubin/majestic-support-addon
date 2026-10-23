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
function Fixture([switch]$Compact) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-installer-tests-' + [guid]::NewGuid().ToString('N'))
    $fixtures.Add($root)
    $f = [pscustomobject]@{Root=$root;Package="$root/package";Local="$root/localappdata";Resources="$root/localappdata/DiscordCanary/app-1.0.9/resources"}
    if ($Compact) { $f.Package = "$root/package/SupportTemplates" }
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
function Run($f, [string]$action, [string[]]$more = @(), [bool]$success = $true, [switch]$Interactive, [string[]]$Answers = @()) {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $channelArgs = @()
        if (-not $Interactive -and '-Channel' -notin $more) { $channelArgs = @('-Channel', 'Canary') }
        $output = $Answers | & $powershell -NoProfile -ExecutionPolicy Bypass -File "$($f.Package)/SupportTemplates.ps1" -Action $action -TestRoot $f.Root -LocalAppDataRoot $f.Local @channelArgs @more 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($success -and $code -ne 0) { throw "$action failed ($code): $output" }
    if (-not $success -and $code -eq 0) { throw "$action unexpectedly succeeded: $output" }
    return ($output -join "`n")
}
function Ptb-Fixture {
    $f = Fixture
    foreach ($exe in @('Discord', 'DiscordPTB')) {
        $app = "$($f.Local)/$exe/app-1.0.9"
        Put "$app/$exe.exe" 'fixture, never executed'
        [IO.Directory]::CreateDirectory("$app/resources") | Out-Null
        New-Asar "$app/resources/app.asar"
    }
    return $f
}
function Test([string]$name, [scriptblock]$body, [string]$SkipReason) {
    if ($name -notlike $Only) { return }
    if ($SkipReason) { Write-Host "SKIP ${name}: $SkipReason"; return }
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

function Foreign-Fixture($f,[string]$Kind) {
    $original = "$($f.Resources)/_app.asar"
    if ($Kind -eq 'betterdiscord') { $original = "$($f.Resources)/betterdiscord.app.asar" }
    [IO.File]::Move("$($f.Resources)/app.asar",$original)
    if ($Kind -eq 'betterdiscord') {
        Put "$($f.Resources)/app/package.json" '{"name":"discord","main":"index.js"}'
        Put "$($f.Resources)/app/index.js" ('require("'+$f.Root.Replace('\','/')+'/Roaming/BetterDiscord/data/betterdiscord.asar/main.js"); require("../betterdiscord.app.asar");')
    } elseif ($Kind -eq 'vencord') {
        New-Asar "$($f.Resources)/app.asar" ('require('+((($f.Root+'/Roaming/Vencord/dist/patcher.js').Replace('/','\')) | ConvertTo-Json -Compress)+')')
    } else {
        $version='0.1.0-canary.1'
        # Exercise ownership checks with an inert pinned loader in the TEMP copy.
        $bootstrap='module.exports = {fixture: true};'
        $hasher=[Security.Cryptography.SHA256]::Create()
        try { $bootstrapHash=[BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($bootstrap))).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        $migration=[IO.Path]::GetFullPath("$($f.Package)/Migration.ps1")
        Assert ($migration.StartsWith([IO.Path]::GetFullPath($f.Root) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Unsafe fixture validator edit'
        $validator=[IO.File]::ReadAllText($migration)
        $pin=[regex]"-ceq '[a-f0-9]{64}'\) 'Unknown internal Vencord bootstrap'"
        Assert ($pin.Matches($validator).Count -eq 1) 'Expected one bootstrap hash gate'
        Put $migration ($pin.Replace($validator, "-ceq '$bootstrapHash') 'Unknown internal Vencord bootstrap'", 1))
        New-Asar "$($f.Resources)/app.asar" $bootstrap ('{"name":"support-templates-vencord-loader","main":"index.js","version":"'+$version+'"}')
        $base="$($f.Local)/SupportTemplatesVencord/channels/canary/versions/$version"
        $manifest=@{schema=1;product='SupportTemplatesVencord';version=$version;files=@(@{path='payload/loader.asar';sha256=(Hash "$($f.Resources)/app.asar");size=(Get-Item "$($f.Resources)/app.asar").Length})}
        Put "$base/manifest.json" ($manifest | ConvertTo-Json -Depth 8 -Compress)
        $config=@{schema=1;product='SupportTemplatesVencord';channel='canary';runtime=[IO.Path]::GetFullPath("$base/runtime");dataDir=$null}
        Put "$($f.Resources)/support-templates-vencord.json" ($config | ConvertTo-Json -Compress)
        $state=@{schema=1;product='SupportTemplatesVencord';channel='canary';resources=[IO.Path]::GetFullPath($f.Resources);version=$version;manifestHash=(Hash "$base/manifest.json");loaderHash=(Hash "$($f.Resources)/app.asar");originalHash=(Hash $original);originalSize=(Get-Item $original).Length;configHash=(Hash "$($f.Resources)/support-templates-vencord.json")}
        Put "$($f.Resources)/support-templates-vencord.install.json" ($state | ConvertTo-Json -Compress)
    }
    Put "$($f.Root)/Roaming/BetterDiscord/plugins/example.plugin.js" 'external plugin stays unchanged'
    Put "$($f.Root)/Roaming/BetterDiscord/themes/example.css" 'external theme stays unchanged'
    Put "$($f.Root)/Roaming/Vencord/settings/settings.json" '{"keep":true}'
    Put "$($f.Root)/Roaming/discord/Local Storage/session.fixture" 'account sentinel'
}
function Injection-State($f) {
    (@(Get-ChildItem -LiteralPath $f.Resources -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/]\.support-templates-migration' } | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($f.Resources.Length).Replace('\','/')+':'+(Hash $_.FullName) })) -join "`n"
}

try {
    Test 'Migration: Inspect recognizes only verified layouts and is entirely read-only' {
        foreach ($kind in @('vencord','betterdiscord','internal')) {
            $f=Fixture; Foreign-Fixture $f $kind; $before=Tree-State $f.Root
            $inspection=Run $f Inspect @('-Channel','canary','-CloseDiscord','-TestRunningTarget') | ConvertFrom-Json
            $expected=$kind; if ($kind -eq 'internal') { $expected='vencord' }
            Assert ($inspection.channel -ceq 'Canary' -and $inspection.kind -ceq $expected -and $inspection.canReplace) 'Incorrect Inspect contract'
            Assert ((Tree-State $f.Root) -ceq $before) 'Inspect mutated fixture'
            $output=Run $f Install @('-CloseDiscord','-TestRunningTarget') $false
            Assert ($output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) 'Missing opt-in changed files/closed client'
            $wrong='vencord'; if ($expected -eq 'vencord') { $wrong='betterdiscord' }
            $output=Run $f Install @('-ReplaceExisting',$wrong,'-CloseDiscord','-TestRunningTarget') $false
            Assert ($output -match 'does not match' -and $output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) 'Mismatched opt-in changed client'
            $output=Run $f Install @('-ReplaceExisting',$expected,'-CloseDiscord','-TestRunningTarget','-WhatIf')
            Assert ($output -match 'What if' -and $output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) 'Replacement WhatIf changed client'
        }
        $f=Fixture; $before=Tree-State $f.Root
        Assert (((Run $f Inspect | ConvertFrom-Json).kind) -ceq 'none') 'Plain Discord not detected'
        Assert ((Tree-State $f.Root) -ceq $before) 'Plain Inspect wrote'
        Run $f Install | Out-Null
        Assert (((Run $f Inspect | ConvertFrom-Json).kind) -ceq 'supporttemplates') 'Owned install not detected'
    }
    Test 'Migration: replacement backs up injection preserves data and uninstall restores plain Discord' {
        foreach ($kind in @('vencord','betterdiscord','internal')) {
            $f=Fixture; Foreign-Fixture $f $kind; $before=Injection-State $f; $external=Tree-State "$($f.Root)/Roaming"
            $original="$($f.Resources)/_app.asar"; if ($kind -eq 'betterdiscord') { $original="$($f.Resources)/betterdiscord.app.asar" }
            $originalHash=Hash $original; $expected=$kind; if ($kind -eq 'internal') { $expected='vencord' }
            $output=Run $f Install @('-ReplaceExisting',$expected,'-CloseDiscord','-TestRunningTarget','-TestRunningOtherChannel')
            Assert ($output -match 'close simulated' -and $output -match 'Uninstall restores plain Discord') 'Replacement close/backup behavior missing'
            Assert ((Run $f Status) -match 'Installed: SupportTemplates') 'Replacement ownership invalid'
            Assert ((Hash "$($f.Resources)/_app.asar") -ceq $originalHash -and -not (Test-Path "$($f.Resources)/app")) 'Original lost or BD injection remains'
            $backups=@(Get-ChildItem -LiteralPath $f.Resources -Directory -Filter '.support-templates-migration-backup-*')
            Assert ($backups.Count -eq 1) 'Durable backup not retained'
            $restored=@(Get-ChildItem -LiteralPath "$($backups[0].FullName)/before" -File -Recurse | Sort-Object FullName | ForEach-Object { $_.FullName.Substring(($backups[0].FullName+'/before').Length).Replace('\','/')+':'+(Hash $_.FullName) }) -join "`n"
            Assert ($restored -ceq $before) 'Backup is not exact displaced injection'
            Run $f Uninstall | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -ceq $originalHash -and -not (Test-Path "$($f.Resources)/_app.asar") -and -not (Test-Path "$($f.Resources)/betterdiscord.app.asar")) 'Uninstall did not restore plain Discord'
            Assert ((Tree-State "$($f.Root)/Roaming") -ceq $external -and (Test-Path $backups[0].FullName)) 'External user data or backup removed'
        }
    }
    Test 'Migration: invalid package ownership original and bootstrap refuse before close or write' {
        foreach ($bad in @('payload','bootstrap','internal-bootstrap','original','config','manifest','extra','downgrade')) {
            $kind='betterdiscord'; if ($bad -in @('internal-bootstrap','config','manifest','downgrade')) { $kind='internal' }
            $f=Fixture; Foreign-Fixture $f $kind
            switch ($bad) {
                payload { Put "$($f.Package)/payload/runtime/renderer.js" 'tampered' }
                bootstrap { Put "$($f.Resources)/app/index.js" 'require("Vencord"); require("../betterdiscord.app.asar");' }
                internal-bootstrap { New-Asar "$($f.Resources)/app.asar" 'module.exports = {unknown: true};' '{"name":"support-templates-vencord-loader","main":"index.js","version":"0.1.0-canary.1"}' }
                original { Put "$($f.Resources)/betterdiscord.app.asar" 'not an original archive' }
                config { Put "$($f.Resources)/support-templates-vencord.json" '{}' }
                manifest { Put "$($f.Local)/SupportTemplatesVencord/channels/canary/versions/0.1.0-canary.1/manifest.json" '{}' }
                extra { Put "$($f.Resources)/app/unknown.js" 'unknown' }
                downgrade { Manifest $f '0.0.9' }
            }
            $before=Tree-State $f.Root; $expected='betterdiscord'; if ($kind -eq 'internal') { $expected='vencord' }
            $output=Run $f Install @('-ReplaceExisting',$expected,'-CloseDiscord','-TestRunningTarget') $false
            Assert ($output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) "Unsafe $bad was changed/closed"
            if ($bad -notin @('payload','downgrade')) { Assert (((Run $f Inspect | ConvertFrom-Json).kind) -ceq 'unsupported') "Invalid $bad Inspect accepted" }
        }
    }
    Test 'Migration: failures restore displaced bytes and interrupted replacements recover before retry' {
        foreach ($kind in @('vencord','betterdiscord','internal')) {
            foreach ($step in @(1,3,7,9)) {
                $f=Fixture; Foreign-Fixture $f $kind; $before=Injection-State $f; $expected=$kind; if ($kind -eq 'internal') { $expected='vencord' }
                $output=Run $f Install @('-ReplaceExisting',$expected,'-TestFailMigrationAfterStep',[string]$step) $false
                Assert ($output -match 'Simulated migration failure' -and (Injection-State $f) -ceq $before -and -not (Test-Path "$($f.Resources)/.support-templates-migration")) "Failure rollback $kind/$step failed: $output"
                $output=Run $f Install @('-ReplaceExisting',$expected,'-TestCrashMigrationAfterStep',[string]$step) $false
                Assert ($output -match 'Simulated migration crash') 'Crash hook missing'
                $pendingBefore=Tree-State $f.Root
                $inspection=Run $f Inspect | ConvertFrom-Json
                Assert ($inspection.kind -ceq $expected -and $inspection.canReplace -and $inspection.reason) 'Pending replacement blocked UI retry'
                Run $f Install @('-ReplaceExisting',$expected,'-WhatIf','-CloseDiscord','-TestRunningTarget') | Out-Null
                Assert ((Tree-State $f.Root) -ceq $pendingBefore) 'Pending Inspect/WhatIf mutated'
                $output=Run $f Install @('-ReplaceExisting',$expected)
                Assert ($output -match 'Recovered interrupted replacement' -and (Run $f Status) -match 'Installed: SupportTemplates') 'Retry did not recover/install'
            }
        }
    }
    Test 'Migration: corrupted recovery snapshots and foreign current writes fail closed' {
        foreach ($bad in @('snapshot','current','journal')) {
            $f=Fixture; Foreign-Fixture $f 'betterdiscord'
            Run $f Install @('-ReplaceExisting','betterdiscord','-TestCrashMigrationAfterStep','3') $false | Out-Null
            switch ($bad) {
                snapshot { Put "$($f.Resources)/.support-templates-migration/before/app/index.js" 'tampered backup' }
                current { Put "$($f.Resources)/app/index.js" 'foreign current write' }
                journal { $p="$($f.Resources)/.support-templates-migration/journal.json"; $j=Get-Content $p -Raw | ConvertFrom-Json; $j.files[0].name='../outside'; Put $p ($j | ConvertTo-Json -Depth 10) }
            }
            $before=Tree-State $f.Root
            $inspection=Run $f Inspect | ConvertFrom-Json
            Assert ($inspection.kind -ceq 'unsupported' -and -not $inspection.canReplace) 'Corrupt journal exposed replacement'
            $output=Run $f Install @('-ReplaceExisting','betterdiscord','-CloseDiscord','-TestRunningTarget') $false
            Assert ((Tree-State $f.Root) -ceq $before -and $output -notmatch 'close simulated') 'Corrupt recovery changed client'
        }
    }
    Test 'Migration: pending internal replacement validates version before recovery writes' {
        $f=Fixture; Foreign-Fixture $f 'internal'
        Run $f Install @('-ReplaceExisting','vencord','-TestCrashMigrationAfterStep','3') $false | Out-Null
        Manifest $f '0.0.9'
        $before=Tree-State $f.Root
        $output=Run $f Install @('-ReplaceExisting','vencord','-CloseDiscord','-TestRunningTarget') $false
        Assert ($output -match 'cannot downgrade' -and $output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) 'Pending recovery downgraded or wrote before version validation'
        Manifest $f
        $output=Run $f Install @('-ReplaceExisting','vencord')
        Assert ($output -match 'Recovered interrupted replacement' -and (Run $f Status) -match 'Installed: SupportTemplates') 'Valid package could not recover and retry'
    }
    Test 'Migration: retained standalone renderer overlay is restored before foreign replacement' {
        $f=Renderer-Fixture
        Run $f UpdateRenderer | Out-Null
        Run $f Uninstall | Out-Null
        Foreign-Fixture $f 'betterdiscord'
        Renderer-Payload $f '0.1.0-canary.6'
        $before=Tree-State $f.Root
        Run $f Install @('-ReplaceExisting','betterdiscord','-WhatIf','-CloseDiscord','-TestRunningTarget') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'Overlay changed during replacement preview'
        Run $f Install @('-ReplaceExisting','betterdiscord') | Out-Null
        Assert (-not (Test-Path "$($f.Overlay)/current.json") -and (Hash "$($f.Base)/runtime/renderer.js") -ceq $f.OriginalRenderer) 'Replacement reused stale renderer overlay'
        Run $f Status | Out-Null
    }
    Test 'CloseDiscord: only opted-in valid installs close the selected fixture and same-version install stays open' {
        $f = Ptb-Fixture
        $before = Tree-State $f.Root
        $output = Run $f Install @('-Channel','PTB','-TestRunningTarget') $false
        Assert ($output -match 'Target Discord is running' -and $output -notmatch 'close simulated') 'Legacy refusal changed'
        Assert ((Tree-State $f.Root) -ceq $before) 'Legacy refusal wrote files'
        $output = Run $f Install @('-Channel','PTB','-CloseDiscord','-TestRunningTarget','-WhatIf')
        Assert ($output -match 'What if:' -and $output -notmatch 'close simulated') 'WhatIf closed a process'
        Assert ((Tree-State $f.Root) -ceq $before) 'WhatIf wrote files'
        foreach ($channel in @('PTB','Stable','Canary')) {
            $output = Run $f Install @('-Channel',$channel,'-CloseDiscord','-TestRunningTarget','-TestRunningOtherChannel')
            Assert ($output -match 'close simulated' -and $output -match 'Install complete') "$channel close/install failed"
            $before = Tree-State $f.Root
            $output = Run $f Install @('-Channel',$channel,'-CloseDiscord','-TestRunningTarget')
            Assert ($output -match 'Already installed and verified' -and $output -notmatch 'close simulated') 'Same-version no-op closed client'
            Assert ((Tree-State $f.Root) -ceq $before) 'Same-version no-op wrote files'
            $output = Run $f Uninstall @('-Channel',$channel,'-CloseDiscord','-TestRunningTarget','-TestRunningOtherChannel')
            Assert ($output -match 'close simulated' -and $output -match 'Uninstalled all owned') "$channel close/uninstall failed"
        }
    }
    Test 'CloseDiscord: corrupt package foreign full mod and downgrade fail before closing or writing' {
        foreach ($case in @('payload','full-mod','older-running-full-mod','downgrade','same-version-content')) {
            $f = Fixture
            switch ($case) {
                'payload' { Put "$($f.Package)/payload/runtime/patcher.js" 'tampered' }
                'full-mod' {
                    Copy-Item -LiteralPath "$($f.Resources)/app.asar" -Destination "$($f.Resources)/_app.asar"
                    Put "$($f.Resources)/support-templates-vencord.install.json" '{"product":"SupportTemplatesVencord"}'
                    Put "$($f.Resources)/support-templates-vencord.json" '{}'
                }
                'older-running-full-mod' {
                    Copy-Item -LiteralPath "$($f.Resources)/app.asar" -Destination "$($f.Resources)/_app.asar"
                    $next = "$($f.Local)/DiscordCanary/app-1.0.10"
                    Put "$next/DiscordCanary.exe" 'fixture, never executed'
                    [IO.Directory]::CreateDirectory("$next/resources") | Out-Null
                    New-Asar "$next/resources/app.asar"
                }
                'downgrade' { Manifest $f '1.0.3'; Run $f Install | Out-Null; Manifest $f '1.0.2' }
                'same-version-content' {
                    Run $f Install | Out-Null
                    Put "$($f.Package)/payload/runtime/patcher.js" 'different but hashed'
                    Manifest $f
                }
            }
            $before = Tree-State $f.Root
            $output = Run $f Install @('-CloseDiscord','-TestRunningTarget') $false
            Assert ($output -notmatch 'close simulated') "$case closed the client"
            Assert ((Tree-State $f.Root) -ceq $before) "$case changed files"
        }
    }
    Test 'PTB: detection is read-only and requires the matching installed executable' {
        $f = Ptb-Fixture
        $before = Tree-State $f.Root
        $found = Run $f Detect | ConvertFrom-Json
        Assert (($found.Channel -join ',') -ceq 'Stable,Canary,PTB') 'Wrong channel discovery/order'
        Assert ($found[2].Label -ceq 'Discord PTB' -and $found[2].Path -ieq [IO.Path]::GetFullPath("$($f.Local)/DiscordPTB")) 'Wrong PTB detection contract'
        Assert ((Tree-State $f.Root) -ceq $before) 'Detect mutated fixture'
        Rename-Item -LiteralPath "$($f.Local)/DiscordPTB/app-1.0.9/DiscordPTB.exe" -NewName 'missing.exe'
        $found = Run $f Detect | ConvertFrom-Json
        Assert (($found.Channel -join ',') -ceq 'Stable,Canary') 'Incomplete PTB advertised'
    }
    Test 'PTB: install status repair downgrade guard and all-version uninstall stay isolated' {
        $f = Ptb-Fixture
        Manifest $f '1.0.3'
        Run $f Install | Out-Null
        Run $f Install @('-Channel', 'Stable') | Out-Null
        $others = @('Discord', 'DiscordCanary', 'SupportTemplates/channels/stable', 'SupportTemplates/channels/canary')
        $snapshots = @{}
        foreach ($other in $others) { $snapshots[$other] = Tree-State "$($f.Local)/$other" }
        $resources = "$($f.Local)/DiscordPTB/app-1.0.9/resources"
        $original = Hash "$resources/app.asar"
        $before = Tree-State $f.Root
        $failure = Run $f Install @('-Channel', 'PTB', '-TestRunningTarget') $false
        Assert ($failure -match 'Target Discord is running') 'PTB running target was not refused'
        Assert ((Tree-State $f.Root) -ceq $before) 'Running-target refusal changed files'
        Run $f Install @('-Channel', 'PTB', '-TestRunningOtherChannel') | Out-Null
        $state = Get-Content -LiteralPath "$resources/support-templates.install.json" -Raw | ConvertFrom-Json
        $config = Get-Content -LiteralPath "$resources/support-templates.json" -Raw | ConvertFrom-Json
        $ptbRoot = [IO.Path]::GetFullPath("$($f.Local)/SupportTemplates/channels/ptb")
        Assert ($state.channel -ceq 'ptb' -and $config.channel -ceq 'ptb') 'PTB identity lost'
        Assert ($config.dataDir -ieq "$ptbRoot\data" -and $config.runtime -ieq "$ptbRoot\versions\1.0.3\runtime") 'PTB paths not isolated'
        Assert ((Run $f Status @('-Channel', 'PTB')) -match 'Installed: SupportTemplates 1.0.3, ptb') 'PTB status missing'
        $before = Tree-State $f.Root
        Assert ((Run $f Install @('-Channel', 'PTB')) -match 'Already installed and verified: 1.0.3') 'PTB same-version install not verified'
        Assert ((Tree-State $f.Root) -ceq $before) 'PTB same-version install changed files'
        $next = "$($f.Local)/DiscordPTB/app-1.0.10"
        Put "$next/DiscordPTB.exe" 'fixture, never executed'
        [IO.Directory]::CreateDirectory("$next/resources") | Out-Null
        New-Asar "$next/resources/app.asar" 'module.exports = {next: true};'
        $nextOriginal = Hash "$next/resources/app.asar"
        Run $f Repair @('-Channel', 'PTB') | Out-Null
        Assert (Test-Path -LiteralPath "$next/resources/support-templates.install.json") 'Repair did not select newest PTB app'
        Manifest $f '1.0.2'
        $before = Tree-State $f.Root
        Assert ((Run $f Repair @('-Channel', 'PTB') $false) -match 'Repair cannot downgrade') 'PTB downgrade permitted'
        Assert ((Tree-State $f.Root) -ceq $before) 'Downgrade refusal mutated files'
        Run $f Uninstall @('-Channel', 'PTB') | Out-Null
        Assert ((Hash "$resources/app.asar") -ceq $original -and (Hash "$next/resources/app.asar") -ceq $nextOriginal) 'PTB originals not restored'
        Assert (-not (Test-Path -LiteralPath "$resources/support-templates.install.json") -and -not (Test-Path -LiteralPath "$next/resources/support-templates.install.json")) 'PTB ownership remained'
        Assert ((Run $f Status @('-Channel', 'PTB')) -match 'Not installed: ptb') 'PTB uninstall status wrong'
        Assert (Test-Path -LiteralPath "$ptbRoot/data") 'PTB retained data removed'
        foreach ($other in $others) { Assert ((Tree-State "$($f.Local)/$other") -ceq $snapshots[$other]) "PTB mutated $other" }
    }
    Test 'PTB: renderer update and full repair preserve the selected host and other channels' {
        $f = Ptb-Fixture
        Renderer-Payload $f '0.1.0-canary.6'
        Run $f Install @('-Channel', 'PTB') | Out-Null
        $canary = Tree-State "$($f.Local)/DiscordCanary"
        $stable = Tree-State "$($f.Local)/Discord"
        $resources = "$($f.Local)/DiscordPTB/app-1.0.9/resources"
        $native = Hash "$resources/app.asar"
        $ptbRoot = "$($f.Local)/SupportTemplates/channels/ptb"
        Renderer-Payload $f '0.1.0-canary.7'
        Run $f UpdateRenderer @('-Channel', 'PTB', '-TestRunningTarget') | Out-Null
        $overlay = Get-Content -LiteralPath "$ptbRoot/renderer-updates/0.1.0-canary.6/current.json" -Raw | ConvertFrom-Json
        Assert ($overlay.version -ceq '0.1.0-canary.7' -and (Hash "$resources/app.asar") -ceq $native) 'PTB renderer update changed native loader'
        Run $f Repair @('-Channel', 'PTB') | Out-Null
        Assert ((Run $f Status @('-Channel', 'PTB')) -match '0.1.0-canary.7, ptb') 'PTB repair upgrade failed'
        Assert ((Tree-State "$($f.Local)/DiscordCanary") -ceq $canary -and (Tree-State "$($f.Local)/Discord") -ceq $stable) 'PTB renderer/repair touched other hosts'
    }
    Test 'install and repair refuse an older package without changing the installed runtime' {
        $f = Fixture
        Manifest $f '1.0.3'
        Run $f Install | Out-Null
        foreach ($version in @('1.0.2', '1.0.3-canary.9')) {
            Manifest $f $version
            $before = Tree-State $f.Root
            foreach ($action in @('Install', 'Repair')) {
                $errorText = Run $f $action @() $false
                Assert ($errorText -match "$action cannot downgrade the installed version") $errorText
                Assert ((Tree-State $f.Root) -ceq $before) "$action changed runtime with an older package"
            }
        }
    }
    Test 'console: read-only detection returns both supported channels and empty array without a picker' {
        $f = Fixture
        $stable = "$($f.Local)/Discord/app-1.2.3"
        Put "$stable/Discord.exe" 'fixture, never executed'
        [IO.Directory]::CreateDirectory("$stable/resources") | Out-Null
        $before = Tree-State $f.Root
        $found = Run $f Detect | ConvertFrom-Json
        Assert ($found.Count -eq 2 -and $found[0].Channel -eq 'Stable' -and $found[1].Channel -eq 'Canary') 'Detect channels incorrect'
        Assert ((Tree-State $f.Root) -ceq $before) 'Detect wrote files'
        $empty = Fixture
        # Remove only fixture executables to make neither app eligible.
        $exe = [IO.Path]::GetFullPath("$($empty.Local)/DiscordCanary/app-1.0.9/DiscordCanary.exe")
        Assert ($exe.StartsWith([IO.Path]::GetFullPath($empty.Root) + '\')) 'Unsafe fixture executable'
        Remove-Item -LiteralPath $exe
        Assert ((Run $empty Detect).Trim() -eq '[]') 'Empty discovery did not return JSON array'
    }
    Test 'console: install BAT arguments retain the CLI and WhatIf makes no writes' {
        $f = Fixture -Compact
        $wrapper = Join-Path $f.Root 'package'
        Copy-Item -LiteralPath "$installer/install.bat" -Destination $wrapper
        $before = Tree-State $f.Root
        $output = & "$wrapper/install.bat" -Channel Canary -WhatIf -TestRoot $f.Root -LocalAppDataRoot $f.Local 2>&1
        Assert ($LASTEXITCODE -eq 0) "BAT CLI failed: $output"
        Assert (($output -join "`n") -match 'What if:') 'Arguments did not reach CLI'
        Assert ((Tree-State $f.Root) -ceq $before) 'BAT WhatIf changed files'
    }
    Test 'picker: one client still requires selection; cancel writes nothing' {
        $f = Fixture; $before = Tree-State $f.Root
        $output = Run $f Install -Interactive -Answers @('0')
        Assert ($output -match 'Discord Canary' -and $output -match 'Cancelled') 'single client picker/cancel missing'
        Assert ((Tree-State $f.Root) -ceq $before) 'cancel changed files'
    }
    Test 'picker: ordinary Discord alone can be selected' {
        $f = Fixture
        $from = [IO.Path]::GetFullPath("$($f.Local)/DiscordCanary")
        $to = [IO.Path]::GetFullPath("$($f.Local)/Discord")
        $boundary = [IO.Path]::GetFullPath($f.Root).TrimEnd('\') + '\'
        Assert ($from.StartsWith($boundary) -and $to.StartsWith($boundary)) 'Client move must stay in the fixture'
        Move-Item -LiteralPath "$($f.Local)/DiscordCanary" -Destination "$($f.Local)/Discord"
        Rename-Item -LiteralPath "$($f.Local)/Discord/app-1.0.9/DiscordCanary.exe" -NewName 'Discord.exe'
        $output = Run $f Install -Interactive -Answers @('1')
        Assert ($output -match 'Selected: Discord \(Stable\)') 'stable selection not shown'
        Assert (Test-Path -LiteralPath "$($f.Local)/Discord/app-1.0.9/resources/support-templates.json") 'stable not installed'
        Assert (-not (Test-Path -LiteralPath "$($f.Local)/SupportTemplates/channels/canary")) 'canary cache created'
    }
    Test 'picker: both clients, invalid choice then Stable, Canary untouched' {
        $f = Fixture
        $stable = "$($f.Local)/Discord/app-1.0.8/resources"
        [IO.Directory]::CreateDirectory($stable) | Out-Null
        Put "$($f.Local)/Discord/app-1.0.8/Discord.exe" 'fixture, never executed'
        New-Asar "$stable/app.asar"
        $canaryBefore = Tree-State "$($f.Local)/DiscordCanary"
        $output = Run $f Install -Interactive -Answers @('bad', '99', '1')
        Assert ($output -match 'Discord \(Stable\)' -and $output -match 'Discord Canary' -and $output -match 'Invalid selection') 'two-client menu missing'
        Assert (Test-Path -LiteralPath "$stable/support-templates.json") 'stable not installed'
        Assert ((Tree-State "$($f.Local)/DiscordCanary") -ceq $canaryBefore) 'unselected client changed'
        $output = Run $f Uninstall -Interactive -Answers @('1')
        Assert (-not (Test-Path -LiteralPath "$stable/support-templates.json")) 'picker uninstall targeted wrong client'
    }
    Test 'picker: empty input cancels and explicit Channel bypasses menu' {
        $f = Fixture; $before = Tree-State $f.Root
        $output = Run $f Install -Interactive -Answers @('')
        Assert ($output -match 'Cancelled' -and (Tree-State $f.Root) -ceq $before) 'empty choice must cancel without writes'
        $output = Run $f Install
        Assert ($output -notmatch 'Select Discord') 'explicit channel prompted'
        Assert (Test-Path -LiteralPath "$($f.Resources)/support-templates.json") 'explicit install failed'
    }
    Test 'picker: both clients, Canary selection leaves Stable untouched' {
        $f = Fixture
        $stable = "$($f.Local)/Discord/app-1.0.8/resources"
        [IO.Directory]::CreateDirectory($stable) | Out-Null
        Put "$($f.Local)/Discord/app-1.0.8/Discord.exe" 'fixture, never executed'
        New-Asar "$stable/app.asar"
        $before = Tree-State "$($f.Local)/Discord"
        $output = Run $f Install -Interactive -Answers @('2')
        Assert ($output -match 'Selected: Discord Canary') 'second selection did not select Canary'
        Assert (Test-Path -LiteralPath "$($f.Resources)/support-templates.json") 'Canary not installed'
        Assert ((Tree-State "$($f.Local)/Discord") -ceq $before) 'unselected Stable changed'
    }
    Test 'picker: no supported installation fails without creating files' {
        $f = Fixture
        Rename-Item -LiteralPath "$($f.Local)/DiscordCanary/app-1.0.9/DiscordCanary.exe" -NewName 'missing.exe'
        $before = Tree-State $f.Root
        $output = Run $f Install -Interactive -success $false
        Assert ($output -match 'No supported Discord installation' -and (Tree-State $f.Root) -ceq $before) 'missing client discovery wrote files or misleading error'
    }
    Test 'picker: selected running target and foreign loaders still fail without writes' {
        foreach ($kind in @('running', 'foreign')) {
            $f = Fixture
            $more = @('-TestRunningTarget')
            $reason = 'Target Discord is running'
            if ($kind -eq 'foreign') {
                New-Asar "$($f.Resources)/app.asar" 'require("betterdiscord");'
                $more = @()
                $reason = 'Foreign modloader'
            }
            $before = Tree-State $f.Root
            $output = Run $f Install $more $false -Interactive -Answers @('1')
            Assert ($output -match $reason) "$kind guard failed after selection: $output"
            Assert ((Tree-State $f.Root) -ceq $before) "$kind rejection changed files"
        }
    }
    Test 'picker: WhatIf and Status select a client without writing' {
        $f = Fixture; $before = Tree-State $f.Root
        $output = Run $f Install @('-WhatIf', '-TestRunningOtherChannel') -Interactive -Answers @('1')
        Assert ($output -match 'SupportTemplates' -and $output -match 'What if') 'SupportTemplates preview not shown'
        Assert ((Tree-State $f.Root) -ceq $before) 'WhatIf wrote files'
        Run $f Status -Interactive -Answers @('1') | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'Status wrote files'
    }
    Test 'picker: fixture validation precedes discovery' {
        $f = Fixture
        Put "$($f.Root)/.support-templates-fixture" 'wrong marker'
        $before = Tree-State $f.Root
        $output = Run $f Install -success $false -Interactive -Answers @('1')
        Assert ($output -match 'Missing fixture marker' -and $output -notmatch 'Select Discord') 'discovery ran before fixture validation'
        Assert ((Tree-State $f.Root) -ceq $before) 'invalid fixture changed files'
    }
    Test 'picker: redirected client is refused before selection' {
        $f = Fixture
        $link = "$($f.Local)/Discord"
        try { New-Item -ItemType Junction -Path $link -Target "$($f.Local)/DiscordCanary" -ErrorAction Stop | Out-Null }
        catch { Write-Host "SKIP junction creation: $_"; return }
        try {
            $before = Tree-State $f.Root
            $output = Run $f Install -success $false -Interactive -Answers @('1')
            Assert ($output -match 'Reparse path refused' -and $output -notmatch 'Select Discord') 'redirect discovery guard missing'
            Assert ((Tree-State $f.Root) -ceq $before) 'redirect rejection changed files'
        }
        finally { [IO.Directory]::Delete($link) }
    }
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
    Test 'regression install restores missing owned runtime before reporting success' {
        foreach ($missing in @('runtime/patcher.js','manifest.json','whole-cache')) {
            $f = Fixture
            Run $f Install | Out-Null
            $cache = "$($f.Local)/SupportTemplates/channels/canary/versions/0.1.0-canary.1"
            $source = $cache; if ($missing -ne 'whole-cache') { $source = "$cache/$missing" }
            Assert ([IO.Path]::GetFullPath($source).StartsWith([IO.Path]::GetFullPath($f.Root) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Unsafe cache fixture move'
            Move-Item -LiteralPath $source -Destination "$($f.Root)/cache.saved"
            $before = Tree-State $f.Root
            $status = Run $f Status @() $false
            Assert ($status -notmatch '(?m)^Installed: SupportTemplates') 'Incomplete runtime was reported as installed'
            $output = Run $f Install @('-CloseDiscord','-TestRunningTarget','-WhatIf')
            Assert ($output -notmatch 'close simulated|Already installed and verified' -and (Tree-State $f.Root) -ceq $before) 'Missing-cache preview mutated or claimed success'
            $output = Run $f Install @('-CloseDiscord','-TestRunningTarget')
            Assert ($output -match 'close simulated' -and $output -match 'Repaired missing runtime cache files') 'Install did not restore missing runtime'
            Assert ((Hash "$cache/runtime/patcher.js") -eq (Hash "$($f.Package)/payload/runtime/patcher.js")) 'Restored runtime differs from the verified package'
            Run $f Status | Out-Null
        }
        foreach ($damage in @('changed','foreign')) {
            $f = Fixture; Run $f Install | Out-Null
            $cache = "$($f.Local)/SupportTemplates/channels/canary/versions/0.1.0-canary.1"
            if ($damage -eq 'changed') { Put "$cache/runtime/patcher.js" 'changed bytes' }
            else { Put "$cache/runtime/unknown.js" 'foreign bytes' }
            $before = Tree-State $f.Root
            $output = Run $f Install @('-CloseDiscord','-TestRunningTarget') $false
            Assert ($output -notmatch 'close simulated' -and (Tree-State $f.Root) -ceq $before) 'Unsafe cache repair closed Discord or changed files'
        }
    }
    Test 'regression physical runtime paths reject hidden filesystem redirection' {
        $f = Fixture
        $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $installer 'SupportTemplates.ps1'), [ref]$null, [ref]$null)
        foreach ($name in @('Require','Full','Get-PhysicalFilePath','Assert-SharedRuntimeFile')) {
            $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
            . ([scriptblock]::Create($fn.Extent.Text))
        }
        $file = "$($f.Package)/manifest.json"
        Assert-SharedRuntimeFile $file
        Assert ((Full (Get-PhysicalFilePath $file)) -ieq (Full $file)) 'Physical TEMP file path differs'
        function Get-PhysicalFilePath([string]$Path) { return "$($f.Root)/redirected/manifest.json" }
        $caught = $null
        try { Assert-SharedRuntimeFile $file } catch { $caught = $_.Exception.Message }
        Assert ($caught -match 'Runtime storage is redirected' -and $caught -match 'Expected:' -and $caught -match 'Actual:') 'Hidden runtime redirect was accepted or unexplained'
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
            $command = '""{0}\status.bat" -Channel Canary -TestRoot "{1}" -LocalAppDataRoot "{2}""' -f $f.Package, $f.Root, $f.Local
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
    Test 'built real payload replaces verified Vencord BetterDiscord and internal full Vencord in TEMP only' {
        $source = [IO.Path]::GetFullPath($PayloadPackageRoot)
        if (Test-Path -LiteralPath (Join-Path $source 'SupportTemplates')) { $source = Join-Path $source 'SupportTemplates' }
        Assert ($source.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) 'Built payload must be in TEMP'
        foreach ($kind in @('vencord','betterdiscord','internal')) {
            $f = Fixture
            $fixturePayload = [IO.Path]::GetFullPath("$($f.Package)/payload")
            Assert ($fixturePayload.StartsWith([IO.Path]::GetFullPath($f.Root) + '\', [StringComparison]::OrdinalIgnoreCase)) 'Unsafe payload replacement'
            Remove-Item -LiteralPath $fixturePayload -Recurse -Force
            Copy-Item -LiteralPath "$source/payload" -Destination $fixturePayload -Recurse
            Copy-Item -LiteralPath "$source/manifest.json" -Destination "$($f.Package)/manifest.json" -Force
            $original = Hash "$($f.Resources)/app.asar"
            Foreign-Fixture $f $kind
            $external = Tree-State "$($f.Root)/Roaming"
            $expected = $kind; if ($kind -eq 'internal') { $expected = 'vencord' }
            $inspection = Run $f Inspect | ConvertFrom-Json
            Assert ($inspection.kind -ceq $expected -and $inspection.canReplace) 'Built replacement preflight failed'
            Run $f Install @('-ReplaceExisting',$expected) | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -ceq (Hash "$source/payload/loader.asar")) 'Real replacement loader differs'
            Run $f Status | Out-Null
            Run $f Uninstall | Out-Null
            Assert ((Hash "$($f.Resources)/app.asar") -ceq $original -and -not (Test-Path "$($f.Resources)/app")) 'Real replacement uninstall did not restore plain Discord'
            Assert (@(Get-ChildItem -LiteralPath $f.Resources -Directory -Filter '.support-templates-migration-backup-*').Count -eq 1) 'Real replacement lost backup'
            Assert ((Tree-State "$($f.Root)/Roaming") -ceq $external) 'Real replacement changed external mod/account data'
        }
    } -SkipReason $(if (-not $PayloadPackageRoot) { 'Supply -PayloadPackageRoot to test a built replacement package' })
    Test 'built real payload installs only into a TEMP Discord fixture' {
        $source = [IO.Path]::GetFullPath($PayloadPackageRoot)
        if (Test-Path -LiteralPath (Join-Path $source 'SupportTemplates')) { $source = Join-Path $source 'SupportTemplates' }
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
    } -SkipReason $(if (-not $PayloadPackageRoot) { 'Supply -PayloadPackageRoot to test a built package' })
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
