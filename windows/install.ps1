<#
  Installs or updates the AP Automation Agent.

  - Copies ap-automation-agent.exe to C:\Program Files\AP Automation Agent
  - Writes agent.env there the first time (asking for the settings), readable
    only by administrators and SYSTEM because it holds SyteLine passwords
  - Checks the settings (ap-automation-agent.exe --test)
  - Registers the "AP Automation Agent" scheduled task: starts with Windows,
    runs as SYSTEM, and starts the agent again if it stops

  Running it again with a newer package updates the agent and keeps agent.env.
  Keep this file ASCII: Windows PowerShell 5.1 reads scripts as ANSI.
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'AP Automation Agent')
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AP Automation Agent'
$ExeName = 'ap-automation-agent.exe'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Ask([string]$Prompt, [string]$Default = '') {
  $shown = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
  $value = Read-Host $shown
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value.Trim()
}

function Yes([string]$Prompt) {
  return (Read-Host "$Prompt (y/N)") -match '^\s*(y|yes)\s*$'
}

# A value agent.env reads back exactly, whatever characters a password holds.
function Quote([string]$Value) {
  if ($Value -notmatch "'") { return "'$Value'" }
  if ($Value -notmatch '"') { return '"' + $Value + '"' }
  return '`' + $Value + '`'
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Write-Settings([string]$Path) {
  Say ''
  Say 'Settings for the agent. They are saved on this server only.' Cyan
  Say 'The agent key is in AP Automation: Connectors > Infor SyteLine > Configure > On-site agent.'
  $key = ''
  while (-not $key) { $key = Ask 'Agent key' }

  Say ''
  Say 'How should the agent reach SyteLine?'
  Say '  I = through SyteLine''s IDO web service (recommended: SyteLine''s own rules and security apply)'
  Say '  S = straight from its SQL database (reading only)'
  $useIdo = (Ask 'IDO service (I) or SQL database (S)?' 'I') -notmatch '^\s*s'

  $lines = @(
    '# AP Automation Agent settings. See agent.env.example for every option.',
    "AGENT_KEY=$(Quote $key)",
    'SERVER_URL=https://ap-automation.co.uk'
  )

  if ($useIdo) {
    Say ''
    Say 'The IDO service is on the SyteLine web (utility) server, at /IDORequestService/IDOWebService.asmx.'
    $url = Ask 'IDO service address' "http://$env:COMPUTERNAME/IDORequestService/IDOWebService.asmx"
    $config = ''
    while (-not $config) { $config = Ask 'SyteLine configuration to sign in to (as on the SyteLine sign-in screen)' }
    $user = ''
    while (-not $user) { $user = Ask 'SyteLine user for AP Automation (needs the SyteLineAutomation module)' }
    $password = Read-Secret 'Its password'
    Say ''
    Say 'AP Automation can also create vouchers in SyteLine through the IDO service. Leave this'
    Say 'off until posting has been tried against a pilot or test configuration.'
    $vouchers = Yes 'Allow AP Automation to create vouchers in SyteLine?'
    $lines += @(
      '',
      "IDO_URL=$(Quote $url)",
      "IDO_CONFIG=$(Quote $config)",
      "IDO_USER=$(Quote $user)",
      "IDO_PASSWORD=$(Quote $password)",
      'IDO_TLS_INSECURE=false',
      '',
      "ALLOW_VOUCHERS=$(if ($vouchers) { 'true' } else { 'false' })"
    )
  } else {
    Say ''
    $server = Ask 'SQL Server holding the SyteLine database (NAME, or NAME\INSTANCE)' $env:COMPUTERNAME
    $port = Ask 'SQL Server port (blank for the usual 1433, or a named instance found automatically)'
    $database = ''
    while (-not $database) { $database = Ask 'SyteLine application database name' }
    $site = Ask 'SyteLine site (blank if the database holds one site)'
    Say ''
    $windows = (Ask 'Sign in to SQL Server with a SQL login (S) or a Windows account (W)?' 'S') -match '^\s*w'
    $domain = ''
    if ($windows) {
      $domain = Ask 'Windows domain' $env:USERDOMAIN
      $user = Ask 'Windows user name (without the domain)'
    } else {
      $user = Ask 'SQL login name'
    }
    $password = Read-Secret 'Password'
    $lines += @(
      '',
      "MSSQL_SERVER=$(Quote $server)",
      "MSSQL_PORT=$port",
      "MSSQL_DATABASE=$(Quote $database)",
      "MSSQL_USER=$(Quote $user)",
      "MSSQL_PASSWORD=$(Quote $password)",
      "MSSQL_DOMAIN=$(Quote $domain)",
      "MSSQL_SITE=$(Quote $site)",
      'MSSQL_ENCRYPT=false',
      'MSSQL_LEGACY_TLS=false',
      '',
      'ALLOW_VOUCHERS=false'
    )
  }

  Say ''
  $proxy = Ask 'Proxy this server uses for the internet, e.g. http://proxy:8080 (blank if none)'
  $lines += @("PROXY_URL=$(Quote $proxy)", 'LOG_LEVEL=info')

  # UTF-8 without a byte-order mark, which would end up in the first setting's name.
  [IO.File]::WriteAllText($Path, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'Run install.cmd as administrator (right-click it, Run as administrator).' Red
  exit 1
}
if (-not [Environment]::Is64BitOperatingSystem) {
  Say 'The agent needs 64-bit Windows.' Red
  exit 1
}
if ([Environment]::OSVersion.Version.Build -lt 14393) {
  Say 'The agent needs Windows Server 2016 / Windows 10 or later. It does not have to run on a' Red
  Say 'SyteLine server itself: install it on any newer server that can reach SyteLine.' Red
  exit 1
}
if (-not (Test-Path (Join-Path $Here $ExeName))) {
  Say "$ExeName is not next to this script. Unzip the whole package first, then run install.cmd from it." Red
  exit 1
}

Say 'AP Automation Agent - install' Cyan
Say "Folder: $InstallDir"

# Stop a running copy so its files can be replaced.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Say 'Stopping the running agent...'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-Process -Name 'ap-automation-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($file in @($ExeName, 'agent.env.example', 'README.txt', 'uninstall.cmd', 'uninstall.ps1')) {
  Copy-Item -LiteralPath (Join-Path $Here $file) -Destination $InstallDir -Force
}
# Files from a downloaded zip carry "came from the internet" marks.
Get-ChildItem -LiteralPath $InstallDir -File | Unblock-File

$envFile = Join-Path $InstallDir 'agent.env'
if (Test-Path $envFile) {
  Say "Keeping the settings in $envFile"
} elseif (Test-Path (Join-Path $Here 'agent.env')) {
  Copy-Item -LiteralPath (Join-Path $Here 'agent.env') -Destination $envFile
  Say 'Using the agent.env from the package folder.'
} else {
  Write-Settings $envFile
}
# Administrators and SYSTEM only: it holds passwords. (SIDs, so any language of Windows works.)
& icacls.exe $envFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null

$exe = Join-Path $InstallDir $ExeName
while ($true) {
  Say ''
  Say 'Checking the settings...' Cyan
  & $exe --test
  if ($LASTEXITCODE -eq 0) { break }
  Say ''
  Say "Some checks failed. You can change the settings now, or edit $envFile later." Yellow
  if (Yes 'Enter the settings again?') { Write-Settings $envFile; continue }
  if (-not (Yes 'Install anyway, and fix the settings later?')) {
    Say 'Not installed. Run install.cmd again when ready; the settings entered are kept.' Yellow
    exit 1
  }
  break
}

$action = New-ScheduledTaskAction -Execute $exe -Argument '--service' -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$runAs = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $runAs -Settings $settings -Force `
  -Description 'Connects Infor SyteLine to AP Automation (outbound HTTPS only). Settings and logs: C:\Program Files\AP Automation Agent' | Out-Null
Start-ScheduledTask -TaskName $TaskName

Say ''
Say 'Starting...'
Start-Sleep -Seconds 8
$log = Get-ChildItem -LiteralPath (Join-Path $InstallDir 'logs') -Filter 'agent-*.log' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime | Select-Object -Last 1
if ($log) { Get-Content -LiteralPath $log.FullName -Tail 8 | ForEach-Object { Say "  $_" } }

Say ''
Say 'Installed. The agent starts with Windows and runs in the background.' Green
Say 'In AP Automation, Connectors > Infor SyteLine shows it as connected; then press Test and Sync.'
Say "Logs: $(Join-Path $InstallDir 'logs')"
