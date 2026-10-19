param([int]$Seconds = 600, [int]$Interval = 10, [string]$Output = 'artifacts/memory19/canary-processes.jsonl')
$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$timer = [Diagnostics.Stopwatch]::StartNew()
$samples = 0
while ($timer.Elapsed.TotalSeconds -le $Seconds) {
    $rows = @(Get-Process -Name DiscordCanary -ErrorAction SilentlyContinue | ForEach-Object {
        try { [ordered]@{ pid = $_.Id; cpuSeconds = $_.TotalProcessorTime.TotalSeconds; privateBytes = $_.PrivateMemorySize64; workingSetBytes = $_.WorkingSet64; handles = $_.HandleCount; threads = $_.Threads.Count } } catch { }
    })
    [ordered]@{ elapsedSeconds = $timer.Elapsed.TotalSeconds; timestamp = [DateTime]::UtcNow.ToString('o'); logicalProcessors = [Environment]::ProcessorCount; processes = $rows } |
        ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath $Output -Encoding utf8
    $samples++
    Start-Sleep -Seconds $Interval
}
Write-Output "Recorded $samples read-only process samples to $Output"
