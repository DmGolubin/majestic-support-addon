# Execute the production close functions against in-memory process doubles only.
# No process enumeration, filesystem writes, real window calls or PID-based kills.
[CmdletBinding(SupportsShouldProcess=$true)]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../standalone/installer/SupportTemplates.ps1'), [ref]$null, [ref]$null)
$names = @('Require','Full','Under','Get-TargetProcesses','Read-LiveProcessPath','Check-TargetStopped','Confirm-ClosePath','Confirm-CloseProcess','Close-TargetDiscord')
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($definition.Name -in $names) { . ([scriptblock]::Create($definition.Extent.Text)) }
}
$script:Fixture = $false
$script:ExeName = 'DiscordPTB'
$script:DiscordRoot = 'C:\Fixture\Local\DiscordPTB'
$script:ForeignPath = ''
$script:Spawned = $null
$script:Queries = 0
$passed = 0
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Reject([scriptblock]$body, $pattern) {
    $caught = $false
    try { & $body | Out-Null } catch { $caught = $true; Assert ($_.Exception.Message -match $pattern) "Wrong failure: $_" }
    Assert $caught 'Expected rejection'
}
# All OS boundaries are doubles. A new unexpected dependency must fail the test.
function Safe-File($Path) { Assert ($Path -like 'C:\Fixture\*') 'Unexpected filesystem path' }
function Check-CloseHostOwnership($Path) { if ($Path -eq $script:ForeignPath) { throw 'Foreign ownership fixture' } }
function Get-Process {
    param($Name, $ErrorAction)
    $script:Queries++
    if ($script:Queries -gt 1 -and $null -ne $script:Spawned) { return $script:Spawned }
    return @($script:Processes | Where-Object { -not $_.HasExited })
}
function Process([string]$Mode = 'graceful', [string]$Path = 'C:\Fixture\Local\DiscordPTB\app-1.0.9\DiscordPTB.exe', [string]$Name = 'DiscordPTB') {
    $p = [pscustomobject]@{Path=$Path;ProcessName=$Name;Id=123;Handle=[IntPtr]123;StartTime=[DateTime]::UtcNow;HasExited=$false;Mode=$Mode;
        Events=(New-Object 'System.Collections.Generic.List[string]')}
    $p | Add-Member ScriptMethod Refresh { }
    $p | Add-Member ScriptMethod CloseMainWindow {
        $this.Events.Add('graceful')
        if ($this.Mode -eq 'graceful') { $this.HasExited = $true }
        if ($this.Mode -eq 'changed') { $this.StartTime = $this.StartTime.AddSeconds(1) }
        return $true
    }
    $p | Add-Member ScriptMethod Kill {
        $this.Events.Add('kill')
        if ($this.Mode -eq 'denied') { throw 'Access denied fixture' }
        if ($this.Mode -ne 'stuck') { $this.HasExited = $true }
    }
    $p | Add-Member ScriptMethod Dispose { $this.Events.Add('dispose') }
    return $p
}
function Invoke-Close {
    [CmdletBinding(SupportsShouldProcess=$true)]
    param()
    Close-TargetDiscord
}
function Test($Name, [scriptblock]$Body) {
    $script:Processes = @(); $script:ForeignPath = ''; $script:Spawned = $null; $script:Queries = 0
    & $Body
    $script:passed++
    Write-Output "PASS $Name"
}
Test 'graceful exit skips kill and ignores other channels and same-name external installations' {
    $selected = Process
    $other = Process 'stay' 'C:\Fixture\Local\DiscordCanary\app-1.0.9\DiscordCanary.exe' 'DiscordCanary'
    $external = Process 'stay' 'C:\Fixture\OtherUser\DiscordPTB\app-1.0.9\DiscordPTB.exe'
    $script:Processes = @($selected,$other,$external)
    Assert (Invoke-Close) 'Close failed'
    Assert (($selected.Events -join ',') -eq 'graceful,dispose') 'Unexpected selected calls'
    Assert ($other.Events.Count -eq 0 -and ($external.Events -join ',') -eq 'dispose') 'Unrelated process controlled'
}
Test 'forced exit acts on the retained object after the grace period' {
    $p = Process 'stay'; $script:Processes = @($p)
    Assert (Invoke-Close) 'Close failed'
    Assert (($p.Events -join ',') -eq 'graceful,kill,dispose') 'Wrong close sequence'
}
Test 'all paths and ownership validate before any close call' {
    foreach ($bad in @('', 'C:\Fixture\Local\DiscordPTB\Update.exe', 'C:\Fixture\Local\DiscordPTB\app-1.0.9\child\DiscordPTB.exe')) {
        $p = Process; $invalid = Process 'stay' $bad
        $script:Processes = @($p,$invalid); $script:Queries = 0
        Reject { Invoke-Close } 'path|close refused'
        Assert ($p.Events -notcontains 'graceful' -and $invalid.Events -notcontains 'kill') 'Invalid path reached close'
    }
    $p = Process; $script:Processes = @($p); $script:ForeignPath = $p.Path
    Reject { Invoke-Close } 'Foreign ownership'
    Assert ($p.Events -notcontains 'graceful') 'Foreign host closed'
}
Test 'identity change between graceful and forced phases refuses kill' {
    $p = Process 'changed'; $script:Processes = @($p)
    Reject { Invoke-Close } 'identity changed'
    Assert ($p.Events -contains 'graceful' -and $p.Events -notcontains 'kill') 'Changed process killed'
}
Test 'kill failure and unresponsive process both fail closed within a bounded wait' {
    foreach ($mode in @('denied','stuck')) {
        $p = Process $mode; $script:Processes = @($p); $script:Queries = 0
        $clock = [Diagnostics.Stopwatch]::StartNew()
        Reject { Invoke-Close } 'Access denied|did not stop'
        Assert ($clock.ElapsedMilliseconds -lt 7000 -and $p.Events -contains 'dispose') 'Unbounded close or leaked handle'
    }
}
Test 'a newly spawned process causes refusal instead of an unvalidated kill' {
    $p = Process; $script:Processes = @($p); $script:Spawned = Process 'stay'
    Reject { Invoke-Close } 'Target Discord is running'
    Assert ($script:Spawned.Events.Count -eq 0) 'New process controlled'
}
function Exit-OnPathRead($Process, [int]$Read = 1) {
    $Process | Add-Member NoteProperty OriginalPath $Process.Path
    $Process | Add-Member NoteProperty PathReads 0
    $Process | Add-Member NoteProperty ExitOnRead $Read
    $Process | Add-Member ScriptProperty Path {
        $this.PathReads++
        if ($this.PathReads -ge $this.ExitOnRead) { $this.HasExited = $true; return $null }
        return $this.OriginalPath
    } -Force
}
Test 'process exiting during initial path lookup does not prevent installation' {
    $p = Process; Exit-OnPathRead $p
    $script:Processes = @($p)
    Assert (Invoke-Close) 'A process that already exited blocked installation'
    Assert (($p.Events -join ',') -eq 'dispose') 'Exited process controlled'
}
Test 'process exiting during identity revalidation is not closed again' {
    $p = Process; Exit-OnPathRead $p 2
    $script:Processes = @($p)
    Assert (Invoke-Close) 'Exit during identity check blocked installation'
    Assert (($p.Events -join ',') -eq 'dispose') 'Exited process controlled'
}
Test 'final stopped check ignores only confirmed exited processes' {
    $p = Process; $script:Processes = @($p)
    $script:Spawned = Process; Exit-OnPathRead $script:Spawned
    Assert (Invoke-Close) 'Final snapshot exit blocked installation'
    Assert ($script:Spawned.Events -notcontains 'kill') 'Final snapshot process killed'
}
Test 'live process with unreadable path still blocks the final stopped check' {
    $p = Process 'stay' ''; $script:Processes = @($p)
    Reject { Check-TargetStopped } 'Cannot establish target process path'
}
Test 'WhatIf invokes neither graceful close nor kill' {
    $p = Process; $script:Processes = @($p)
    Assert (-not (Invoke-Close -WhatIf)) 'WhatIf reported a completed close'
    Assert (($p.Events -join ',') -eq 'dispose') 'WhatIf controlled a process'
}
Write-Output "Passed $passed native close process-double tests."
