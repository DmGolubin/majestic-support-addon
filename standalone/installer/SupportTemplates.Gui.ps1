# Windows PowerShell 5.1 / WPF. Launch with -STA; no elevation or downloads.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'InstallerGui.psm1') -Force
    $gui = New-InstallerGui -PackageRoot $PSScriptRoot
    $gui.Window.ShowDialog() | Out-Null
} catch {
    Add-Type -AssemblyName PresentationFramework
    [Windows.MessageBox]::Show([string]$_.Exception.Message, 'SupportTemplates Lite', 'OK', 'Error') | Out-Null
    exit 1
}
