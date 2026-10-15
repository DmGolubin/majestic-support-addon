$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$pythonExe = (Get-Command python).Source
foreach ($service in @(@{ Port = 47833; Script = 'demo-panel.py' }, @{ Port = 47834; Script = 'roadmap-server.py' })) {
    $listener = Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        Write-Host "Port $($service.Port) already listening; leaving it untouched."
        continue
    }
    $scriptPath = Join-Path $PSScriptRoot $service.Script
    Start-Process -FilePath $pythonExe -ArgumentList ('"' + $scriptPath + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden
}
Write-Host 'Meeting: http://127.0.0.1:47834/meeting/'
Write-Host 'Roadmap: http://127.0.0.1:47834/roadmap/'
Write-Host 'Start login from the plugin; the confirmation link is created for that attempt.'
