# Explicit foreign-loader migration. Never evaluates JavaScript or touches external mod data.
# Active journal recovery restores the displaced installation. Successful journals are retained
# as .support-templates-migration-backup-* for deliberate offline recovery; normal Uninstall
# restores plain Discord, NOT the displaced mod. No automatic replay of completed backups.
$script:MigrationNames = @('_app.asar','support-templates.json','app.asar','support-templates.install.json',
    'support-templates-vencord.json','support-templates-vencord.install.json','betterdiscord.app.asar','app/package.json','app/index.js')
$script:ReplacementApproval = $null

function Read-InjectionAsar([string]$Path) {
    Safe-File $Path
    Require ((Get-Item -LiteralPath $Path).Length -le 1048576) 'Unknown loader ASAR size'
    $stream = [IO.File]::OpenRead($Path); $reader = New-Object IO.BinaryReader($stream)
    try {
        $a=$reader.ReadUInt32(); $h=$reader.ReadUInt32(); $p=$reader.ReadUInt32(); $n=$reader.ReadUInt32()
        Require ($a -eq 4 -and $h -ge 8 -and $h -le 65536 -and $p -eq ($h-4) -and $n -gt 0 -and $n -le ($h-8) -and ($h-8-$n) -le 3 -and ($h % 4) -eq 0 -and ($h+8) -lt $stream.Length) 'Unknown loader ASAR header'
        $tree = $script:Utf8.GetString($reader.ReadBytes($n)) | ConvertFrom-Json
        Check-AsarTree $tree ($stream.Length-$h-8)
        Require (@($tree.files.PSObject.Properties).Count -eq 2) 'Unknown loader ASAR entries'
        $result = @{}; $ranges = @()
        foreach ($name in @('package.json','index.js')) {
            $entry = Asar-Entry $tree $name
            Require ($entry.size -gt 0 -and $entry.size -le 65536 -and $null -ne $entry.PSObject.Properties['offset'] -and $null -eq $entry.PSObject.Properties['unpacked']) 'Invalid loader entry'
            $stream.Position = $h+8+[long]$entry.offset
            $result[$name] = $script:Utf8.GetString($reader.ReadBytes($entry.size))
            $ranges += [pscustomobject]@{Start=[long]$entry.offset;End=([long]$entry.offset+[long]$entry.size)}
        }
        $ranges = @($ranges | Sort-Object Start)
        Require ($ranges[0].Start -eq 0 -and $ranges[0].End -eq $ranges[1].Start -and $ranges[1].End -eq ($stream.Length-$h-8)) 'Overlapping or trailing loader contents'
        return $result
    } finally { $reader.Dispose(); $stream.Dispose() }
}
function Injection-Text([string]$Path) {
    Safe-File $Path
    Require ((Get-Item -LiteralPath $Path).Length -le 65536) 'Unknown injection file size'
    return $script:Utf8.GetString([IO.File]::ReadAllBytes($Path))
}
function Check-InjectionDirectory([string]$Base) {
    $app = Join-Path $Base 'app'
    Safe-Path $app
    if (-not (Exists $app)) { return }
    Safe-Directory $app
    foreach ($entry in Get-ChildItem -LiteralPath $app -Force) {
        Safe-File $entry.FullName
        Require ($entry.Name -cin @('package.json','index.js')) 'Unknown resources/app contents'
    }
}
function Read-ForeignInjection([string]$Base, [string]$ManifestProof) {
    Safe-Directory $Base
    Check-InjectionDirectory $Base
    foreach ($name in $script:MigrationNames) { Safe-Path (Join-Path $Base $name) }
    foreach ($name in @('support-templates.json','support-templates.install.json','.support-templates-transaction','.support-templates-vencord-transaction')) {
        Require (-not (Exists (Join-Path $Base $name))) 'Conflicting ownership or unfinished transaction'
    }
    $kind = 'vencord'; $proof = $null; $ownedVersion = $null
    if (Exists (Join-Path $Base 'app')) {
        foreach ($name in @('app.asar','_app.asar','support-templates-vencord.json','support-templates-vencord.install.json')) {
            Require (-not (Exists (Join-Path $Base $name))) 'Ambiguous BetterDiscord layout'
        }
        $pkg = (Injection-Text (Join-Path $Base 'app/package.json')) | ConvertFrom-Json
        Require ($pkg.name -ceq 'discord' -and $pkg.main -ceq 'index.js' -and @($pkg.PSObject.Properties).Count -eq 2) 'Unknown BetterDiscord package'
        $js = Injection-Text (Join-Path $Base 'app/index.js')
        $match = [regex]::Match($js, '^\s*require\(("(?:[^"\\\r\n]|\\["\\/])+")\);\s*require\("\.\./betterdiscord\.app\.asar"\);\s*$')
        Require $match.Success 'Unknown BetterDiscord bootstrap'
        $external = ($match.Groups[1].Value | ConvertFrom-Json).Replace('/','\')
        Require ($external -match '^[A-Za-z]:\\.+\\BetterDiscord\\data\\betterdiscord\.asar\\main\.js$') 'Unknown BetterDiscord loader path'
        Safe-Path $external
        $original = 'betterdiscord.app.asar'; $kind = 'betterdiscord'
    } else {
        Require (-not (Exists (Join-Path $Base 'betterdiscord.app.asar'))) 'Conflicting BetterDiscord backup'
        $loader = Read-InjectionAsar (Join-Path $Base 'app.asar')
        $pkg = $loader['package.json'] | ConvertFrom-Json
        Require ($pkg.main -ceq 'index.js') 'Unknown Vencord entry point'
        $original = '_app.asar'
        if ($pkg.name -ceq 'support-templates-vencord-loader') {
            # Pin the complete known internal bootstrap, not a substring marker.
            Require ((Hash-Bytes $script:Utf8.GetBytes(($loader['index.js'] -replace "`r`n", "`n"))) -ceq '303f3df518630ce85ea087c9557021e6e9f578286c7277811dc2e003974e41a1') 'Unknown internal Vencord bootstrap'
            $state = Read-Json (Join-Path $Base 'support-templates-vencord.install.json')
            $config = Read-Json (Join-Path $Base 'support-templates-vencord.json')
            Require ($state.schema -eq 1 -and $state.product -ceq 'SupportTemplatesVencord' -and $state.channel -ceq $script:ChannelName -and $state.resources -ieq $script:Resources) 'Invalid full Vencord ownership'
            Valid-Version $state.version
            Require ($pkg.version -ceq $state.version) 'Full Vencord loader version mismatch'
            foreach ($hash in @($state.loaderHash,$state.configHash,$state.originalHash,$state.manifestHash)) { Require ($hash -cmatch '^[a-f0-9]{64}$') 'Invalid full Vencord hash' }
            Require ((Hash-File (Join-Path $Base 'app.asar')) -ceq $state.loaderHash -and (Hash-File (Join-Path $Base 'support-templates-vencord.json')) -ceq $state.configHash -and (Hash-File (Join-Path $Base '_app.asar')) -ceq $state.originalHash -and (Get-Item -LiteralPath (Join-Path $Base '_app.asar')).Length -eq $state.originalSize) 'Full Vencord ownership hashes differ'
            $runtime = Join-Path $script:LocalRoot ('SupportTemplatesVencord/channels/' + $script:ChannelName + '/versions/' + $state.version + '/runtime')
            Require ($config.schema -eq 1 -and $config.product -ceq 'SupportTemplatesVencord' -and $config.channel -ceq $script:ChannelName -and $config.runtime -ieq $runtime -and $null -eq $config.dataDir) 'Full Vencord configuration identity differs'
            $proof = $ManifestProof
            if (-not $proof) { $proof = Join-Path (Split-Path $runtime -Parent) 'manifest.json' }
            Require ((Hash-File $proof) -ceq $state.manifestHash) 'Full Vencord manifest hash differs'
            $manifest = Read-Json $proof
            $loaders = @($manifest.files | Where-Object { $_.path -ceq 'payload/loader.asar' })
            Require ($manifest.schema -eq 1 -and $manifest.product -ceq 'SupportTemplatesVencord' -and $manifest.version -ceq $state.version -and $loaders.Count -eq 1 -and $loaders[0].sha256 -ceq $state.loaderHash -and $loaders[0].size -eq (Get-Item -LiteralPath (Join-Path $Base 'app.asar')).Length) 'Full Vencord manifest identity differs'
            $ownedVersion = $state.version
        } else {
            Require ($pkg.name -ceq 'discord' -and @($pkg.PSObject.Properties).Count -eq 2) 'Unknown Vencord package'
            foreach ($name in @('support-templates-vencord.json','support-templates-vencord.install.json')) { Require (-not (Exists (Join-Path $Base $name))) 'Conflicting full Vencord ownership' }
            $match = [regex]::Match($loader['index.js'], '^require\(("(?:[^"\\\r\n]|\\["\\/])+")\)$')
            Require $match.Success 'Unknown standard Vencord bootstrap'
            $external = ($match.Groups[1].Value | ConvertFrom-Json).Replace('/','\')
            Require ($external -match '^[A-Za-z]:\\.+\\(?:Vencord|VencordData)\\dist\\patcher\.js$') 'Unknown standard Vencord patcher path'
            Safe-Path $external
        }
    }
    Check-OriginalAsar (Join-Path $Base $original)
    return [pscustomobject]@{Kind=$kind;Original=$original;ManifestProof=$proof;Version=$ownedVersion}
}
function Inspect-Installation {
    try {
        if (Exists $script:Migration) {
            $pending=Check-Migration
            return [ordered]@{channel=$Channel;kind=$pending.kind;canReplace=$true;reason='Замена прервана. Закройте Discord и подтвердите замену повторно для восстановления и продолжения.'}
        }
        Require (-not (Exists $script:Transaction)) 'Interrupted installation requires recovery with Discord closed'
        if (Exists (Join-Path $script:Resources 'support-templates.install.json')) {
            Read-State | Out-Null
            return [ordered]@{channel=$Channel;kind='supporttemplates';canReplace=$false}
        }
        $foreign = @('app','_app.asar','betterdiscord.app.asar','support-templates-vencord.json','support-templates-vencord.install.json','support-templates.json') | Where-Object { Exists (Join-Path $script:Resources $_) }
        if (@($foreign).Count -eq 0) {
            Read-State | Out-Null
            return [ordered]@{channel=$Channel;kind='none';canReplace=$false}
        }
        $found = Read-ForeignInjection $script:Resources
        return [ordered]@{channel=$Channel;kind=$found.Kind;canReplace=$true}
    } catch { return [ordered]@{channel=$Channel;kind='unsupported';canReplace=$false;reason='Обнаружена неизвестная или повреждённая установка. Безопасная автоматическая замена недоступна.'} }
}
function Migration-Fingerprint {
    Check-InjectionDirectory $script:Resources
    $result = @{}
    foreach ($name in $script:MigrationNames) { $result[$name] = Current-Hash (Join-Path $script:Resources $name) }
    return $result
}
function Check-MigrationApproval {
    Require ($null -ne $script:ReplacementApproval -and $script:Resources -ieq $script:ReplacementApproval.Resources) 'Replacement approval belongs to another app version'
    $found = Read-ForeignInjection $script:Resources
    Require ($found.Kind -ceq $ReplaceExisting) 'Replacement type changed'
    $current = Migration-Fingerprint
    foreach ($name in $script:MigrationNames) { Require ($current[$name] -ceq $script:ReplacementApproval.Files[$name]) 'Injection changed after replacement approval' }
}
function Check-Migration {
    Safe-Directory $script:Migration
    Require (-not (Exists $script:Transaction)) 'Conflicting resource and migration transactions'
    $journal = Read-Json (Join-Path $script:Migration 'journal.json')
    Require ($journal.schema -eq 1 -and $journal.product -ceq 'SupportTemplatesMigration' -and $journal.channel -ceq $script:ChannelName -and $journal.resources -ieq $script:Resources -and $journal.kind -cin @('vencord','betterdiscord')) 'Foreign migration journal'
    Require ($journal.files.Count -eq $script:MigrationNames.Count) 'Invalid migration file count'
    $allowed = @{'journal.json'=$true}
    if ($null -ne $journal.proofHash) {
        Require ($journal.proofHash -cmatch '^[a-f0-9]{64}$' -and (Hash-File (Join-Path $script:Migration 'proof.json')) -ceq $journal.proofHash) 'Migration ownership proof corrupted'
        $allowed['proof.json']=$true
    }
    Check-InjectionDirectory $script:Resources
    for ($i=0; $i -lt $script:MigrationNames.Count; $i++) {
        $entry=$journal.files[$i]
        Require ($entry.name -ceq $script:MigrationNames[$i]) 'Invalid migration target'
        foreach ($side in @('before','after')) {
            if ($null -ne $entry.$side) {
                Require ($entry.$side -cmatch '^[a-f0-9]{64}$') 'Invalid migration hash'
                $rel="$side/$($entry.name)"; $allowed[$rel]=$true
                Require ((Hash-File (Join-Path $script:Migration $rel)) -ceq $entry.$side) 'Migration snapshot corrupted'
            }
        }
        $current=Current-Hash (Join-Path $script:Resources $entry.name)
        Require ($current -ceq $entry.before -or $current -ceq $entry.after) "Foreign modification during replacement: $($entry.name)"
        $swap="$i.swap"
        if (Exists (Join-Path $script:Migration $swap)) {
            $hash=Hash-File (Join-Path $script:Migration $swap)
            Require ($hash -ceq $entry.before -or $hash -ceq $entry.after) 'Foreign migration swap'
            $allowed[$swap]=$true
        }
    }
    foreach ($file in @(Tree-Files $script:Migration)) {
        $relative=$file.Substring($script:Migration.Length+1).Replace('\','/')
        Require ($allowed.ContainsKey($relative)) 'Unknown migration backup file'
    }
    $proof=$null; if ($null -ne $journal.proofHash) { $proof=Join-Path $script:Migration 'proof.json' }
    $before=Read-ForeignInjection (Join-Path $script:Migration 'before') $proof
    Require ($before.Kind -ceq $journal.kind) 'Migration kind differs from backup'
    $after=Join-Path $script:Migration 'after'
    $state=Read-Json (Join-Path $after 'support-templates.install.json')
    Check-OwnedFiles $state (Join-Path $after 'app.asar') (Join-Path $after '_app.asar') (Join-Path $after 'support-templates.json')
    Require ($null -eq $state.previousVersion -and (Hash-File (Join-Path $script:Migration ('before/'+$before.Original))) -ceq $state.originalHash) 'Migration changed original archive or invented history'
    for ($i=4; $i -lt $script:MigrationNames.Count; $i++) { Require ($null -eq $journal.files[$i].after) 'Migration retains foreign injection' }
    return $journal
}
function Apply-Migration($Journal,[string]$Side) {
    Check-TargetStopped
    Check-Migration | Out-Null
    $step=0
    for ($i=0; $i -lt $script:MigrationNames.Count; $i++) {
        $entry=$Journal.files[$i]; $target=Join-Path $script:Resources $entry.name; $wanted=$entry.$Side
        Check-TargetStopped
        $current=Current-Hash $target
        Require ($current -ceq $entry.before -or $current -ceq $entry.after) 'Migration target changed before write'
        if ($current -cne $wanted) {
            if ($null -eq $wanted) { [IO.File]::Delete($target) }
            else {
                $bytes=[IO.File]::ReadAllBytes((Join-Path $script:Migration "$Side/$($entry.name)"))
                Require ((Hash-Bytes $bytes) -ceq $wanted) 'Migration snapshot changed before write'
                $swap=Join-Path $script:Migration "$i.swap"
                if (Exists $swap) {
                    $hash=Hash-File $swap
                    Require ($hash -ceq $entry.before -or $hash -ceq $entry.after) 'Migration swap changed'
                    [IO.File]::Delete($swap)
                }
                Write-New $swap $bytes
                Ensure-Directory (Split-Path $target -Parent)
                Safe-Path $target
                if (Exists $target) { [IO.File]::Replace($swap,$target,[NullString]::Value) }
                else { [IO.File]::Move($swap,$target) }
            }
        }
        $step++
        if ($Side -eq 'after') {
            if ($TestCrashMigrationAfterStep -eq $step) { $script:SimulatedCrash=$true; throw "Simulated migration crash $step" }
            if ($TestFailMigrationAfterStep -eq $step) { throw "Simulated migration failure $step" }
        }
    }
    if ($Side -eq 'after' -and (Exists (Join-Path $script:Resources 'app'))) {
        Check-InjectionDirectory $script:Resources
        [IO.Directory]::Delete((Join-Path $script:Resources 'app')) # Must be empty; never recursive.
    }
}
function Finish-Migration($Journal,[string]$Side) {
    Check-Migration | Out-Null
    foreach ($entry in $Journal.files) { Require ((Current-Hash (Join-Path $script:Resources $entry.name)) -ceq $entry.$Side) 'Migration final state changed' }
    $backup=Join-Path $script:Resources ('.support-templates-migration-backup-'+[guid]::NewGuid().ToString('N'))
    Safe-Path $backup
    [IO.Directory]::Move($script:Migration,$backup) # Commit point; retained for explicit offline recovery.
    Write-Output "Replacement backup retained: $backup. Uninstall restores plain Discord; it does not reactivate the previous mod."
}
function Recover-Migration {
    $journal=Check-Migration
    Apply-Migration $journal 'before'
    Finish-Migration $journal 'before'
    Write-Output 'Recovered interrupted replacement: the displaced mod has been restored. Retry explicit replacement when ready.'
}
function Install-Replacement {
    Require ($Action -eq 'Install') 'ReplaceExisting is supported only for Install'
    Require (-not (Exists $script:Migration) -and -not (Exists $script:Transaction)) 'Recover pending installation before replacement'
    $found=Read-ForeignInjection $script:Resources
    Require ($found.Kind -ceq $ReplaceExisting) 'ReplaceExisting does not match the current installation'
    $script:ReplacementApproval=[pscustomobject]@{Resources=$script:Resources;Files=(Migration-Fingerprint)}
    $package=Read-ClosePreflight $null
    if ($null -ne $found.Version) { Require ((Compare-PackageVersion $package.Manifest.version $found.Version) -ge 0) 'Replacement cannot downgrade the installed package version' }
    Check-MigrationApproval
    if (-not $PSCmdlet.ShouldProcess($script:Resources,"Replace $ReplaceExisting with SupportTemplates; retain recovery backup and external mod settings")) { return }
    if ($CloseDiscord) { if (-not (Close-TargetDiscord)) { return } } else { Check-TargetStopped }
    Check-MigrationApproval
    # This cache is not the foreign host's runtime. Finish any retained standalone
    # overlay restore while the whole selected channel is stopped, before publishing
    # the replacement. Restore-RendererOverlay has its own durable retry record.
    Restore-RendererOverlay $package.Manifest.version
    $package=Save-Package $package
    Ensure-Directory (Join-Path $script:ChannelRoot 'data')
    $original=[IO.File]::ReadAllBytes((Join-Path $script:Resources $found.Original))
    $config=Json-Bytes (Make-Config $package.Manifest.version)
    $newState=[ordered]@{schema=1;product='SupportTemplates';channel=$script:ChannelName;resources=$script:Resources;version=$package.Manifest.version;previousVersion=$null;previousManifestHash=$null;previousLoaderHash=$null;loaderHash=$package.LoaderHash;manifestHash=(Hash-File (Join-Path $package.Base 'manifest.json'));originalHash=(Hash-Bytes $original);originalSize=$original.Length;configHash=(Hash-Bytes $config)}
    $after=@{'_app.asar'=$original;'app.asar'=[IO.File]::ReadAllBytes($package.Files['payload/loader.asar']);'support-templates.json'=$config;'support-templates.install.json'=(Json-Bytes $newState)}
    $stage=Join-Path $script:Resources ('.support-templates-migration-prepare-'+[guid]::NewGuid().ToString('N'))
    Ensure-Directory $stage
    $entries=@()
    foreach ($name in $script:MigrationNames) {
        $entry=[ordered]@{name=$name;before=$null;after=$null}
        foreach ($side in @('before','after')) {
            $bytes=$null
            if ($side -eq 'before' -and (Exists (Join-Path $script:Resources $name))) { $bytes=[IO.File]::ReadAllBytes((Join-Path $script:Resources $name)) }
            if ($side -eq 'after') { $bytes=$after[$name] }
            if ($null -ne $bytes) {
                $entry[$side]=Hash-Bytes $bytes
                $copy=Join-Path $stage "$side/$name"; Ensure-Directory (Split-Path $copy -Parent); Write-New $copy $bytes
            }
        }
        Require ($entry.before -ceq $script:ReplacementApproval.Files[$name]) 'Injection changed during backup'
        $entries += $entry
    }
    $proofHash=$null
    if ($found.ManifestProof) {
        $bytes=[IO.File]::ReadAllBytes($found.ManifestProof); $proofHash=Hash-Bytes $bytes
        Write-New (Join-Path $stage 'proof.json') $bytes
    }
    Write-New (Join-Path $stage 'journal.json') (Json-Bytes ([ordered]@{schema=1;product='SupportTemplatesMigration';channel=$script:ChannelName;resources=$script:Resources;kind=$found.Kind;proofHash=$proofHash;files=$entries}))
    Check-MigrationApproval
    [IO.Directory]::Move($stage,$script:Migration)
    try {
        $journal=Check-Migration
        Apply-Migration $journal 'after'
        Finish-Migration $journal 'after'
    } catch {
        $failure=$_
        if (-not $script:SimulatedCrash -and (Exists $script:Migration)) {
            try { Recover-Migration } catch { Write-Warning "Recovery stopped safely; retain the migration journal: $_" }
        }
        throw $failure
    }
    Write-Output "Install complete: SupportTemplates $($package.Manifest.version) ($script:ChannelName). External mod data retained. Restart Discord when ready."
}
