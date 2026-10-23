# Synthetic TEMP only. Import the existing guarded fixture helpers without running its suite.
param([string]$Only = '*')
$selected = $Only
. (Join-Path $PSScriptRoot 'standaloneInstaller.Tests.ps1') -Only 'q18Delivery-no-existing-tests'
$Only = $selected
$passed = 0

function Delivery-Payload($f, [string]$version, [string]$repository = 'owner/releases', [string]$helper = '# synthetic helper, never executed') {
    Renderer-Payload $f $version
    Put "$($f.Package)/payload/runtime/update-helper.ps1" $helper
    Put "$($f.Package)/payload/runtime/update-config.json" (@{schema=1;version=$version;channel='canary';releaseRepository=$repository;manifestAsset='support-templates-update.json';checkIntervalHours=6} | ConvertTo-Json)
    Manifest $f $version
}
function Delivery-Fixture {
    $f = Fixture
    Delivery-Payload $f '0.1.0-canary.6'
    Run $f Install | Out-Null
    $channel = "$($f.Local)/SupportTemplates/channels/canary"
    $f | Add-Member NoteProperty Channel $channel
    $f | Add-Member NoteProperty Base "$channel/versions/0.1.0-canary.6"
    Delivery-Payload $f '0.1.0-canary.7'
    return $f
}
try {
    Test 'q18Delivery current helper/config payload permits a compatible renderer-only update' {
        $f = Delivery-Fixture
        $before = Tree-State $f.Base @('runtime/renderer.js')
        $package = Tree-State $f.Package
        Run $f UpdateRenderer @('-TestRunningTarget') | Out-Null
        Assert ((Tree-State $f.Base @('runtime/renderer.js')) -ceq $before) 'native files or config changed'
        Assert ((Tree-State $f.Package) -ceq $package) 'source package changed'
        Assert ((Get-Content -LiteralPath "$($f.Base)/runtime/renderer.js" -Raw) -match 'canary.7') 'new renderer not activated'
        Assert ((Run $f Status) -match '0.1.0-canary.7') 'overlay missing from status'
    }
    Test 'q18Delivery rejects changed helper without any mutation' {
        $f = Delivery-Fixture
        Delivery-Payload $f '0.1.0-canary.7' 'owner/releases' '# different native helper'
        $before = Tree-State $f.Root
        Run $f UpdateRenderer @('-TestRunningTarget') $false | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'rejected helper change mutated fixture'
    }
    Test 'q18Delivery rejects changed updater policy without any mutation' {
        $f = Delivery-Fixture
        Delivery-Payload $f '0.1.0-canary.7' 'different/releases'
        $before = Tree-State $f.Root
        Run $f UpdateRenderer @('-TestRunningTarget') $false | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'rejected policy change mutated fixture'
    }
    Test 'q18Delivery rejects config version inconsistent with its package without mutation' {
        $f = Delivery-Fixture
        $config = Get-Content -LiteralPath "$($f.Package)/payload/runtime/update-config.json" -Raw | ConvertFrom-Json
        $config.version = '0.1.0-canary.8'
        Put "$($f.Package)/payload/runtime/update-config.json" ($config | ConvertTo-Json)
        Manifest $f '0.1.0-canary.7'
        $before = Tree-State $f.Root
        Run $f UpdateRenderer @('-TestRunningTarget') $false | Out-Null
        Assert ((Tree-State $f.Root) -ceq $before) 'rejected config version mutated fixture'
    }
    Write-Host "$passed q18Delivery renderer fixture groups passed."
} finally {
    foreach ($root in $fixtures) {
        $full = [IO.Path]::GetFullPath($root)
        $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $full.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $full -Leaf) -notmatch '^SupportTemplates-installer-tests-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path' }
        if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
    }
}
