param([ValidateRange(1, 2147483647)][int]$Seconds = 600, [ValidateRange(1, 2147483647)][int]$Interval = 10, [string]$Output = 'artifacts/memory19/canary-processes.jsonl')
$ErrorActionPreference = 'Stop'
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Refusing to append to prior process evidence; choose a new output file' }
$directory = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$timer = [Diagnostics.Stopwatch]::StartNew()
$samples = 0
while ($timer.Elapsed.TotalSeconds -le $Seconds) {
    $sampleErrors = [Collections.Generic.List[string]]::new()
    $rows = @(Get-Process -Name DiscordCanary -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $row = [ordered]@{ pid = $_.Id; cpuSeconds = $_.TotalProcessorTime.TotalSeconds; privateBytes = $_.PrivateMemorySize64; workingSetBytes = $_.WorkingSet64; handles = $_.HandleCount; threads = $_.Threads.Count }
            if ($row.Values -contains $null) { throw 'Process metrics unavailable' }
            $row
        } catch { $sampleErrors.Add('process_metrics_unavailable') }
    })
    [ordered]@{ elapsedSeconds = $timer.Elapsed.TotalSeconds; timestamp = [DateTime]::UtcNow.ToString('o'); logicalProcessors = [Environment]::ProcessorCount; processes = $rows; errors = @($sampleErrors.ToArray()) } |
        ConvertTo-Json -Depth 5 -Compress | Add-Content -LiteralPath $Output -Encoding utf8
    $samples++
    Start-Sleep -Seconds $Interval
}
Write-Output "Recorded $samples read-only process samples to $Output"
