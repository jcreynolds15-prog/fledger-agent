<#
  Removes the AP Automation Agent: its scheduled task, and its folder unless
  you choose to keep the settings and logs. Keep this file ASCII.
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'AP Automation Agent')
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AP Automation Agent'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run uninstall.cmd as administrator.' -ForegroundColor Red
  exit 1
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host 'Removed the scheduled task.'
}
Get-Process -Name 'ap-automation-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

if (-not (Test-Path $InstallDir)) { Write-Host 'Uninstalled.' -ForegroundColor Green; exit 0 }

$keep = (Read-Host 'Keep the settings (agent.env) and logs? (Y/n)') -notmatch '^\s*(n|no)\s*$'
if ($keep) {
  Remove-Item -LiteralPath (Join-Path $InstallDir 'ap-automation-agent.exe') -Force -ErrorAction SilentlyContinue
  Write-Host "Uninstalled. Settings and logs are still in $InstallDir" -ForegroundColor Green
  exit 0
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($here -eq (Resolve-Path $InstallDir).Path) {
  # This script runs from the folder being removed: remove it once the script has finished.
  Start-Process -FilePath cmd.exe -ArgumentList "/c timeout /t 3 >nul & rmdir /s /q `"$InstallDir`"" -WindowStyle Hidden
} else {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
}
Write-Host 'Uninstalled, with its settings and logs.' -ForegroundColor Green
