#Requires -Version 5.1
<#
.SYNOPSIS
    Установка постоянного Windows-автозапуска для Amina Bridge

.DESCRIPTION
    Создаёт единый bootstrap `Amina-Bridge`, который:
    1. Поднимает `lms daemon up`
    2. Поднимает `lms server start`
    3. Запускает `tunnel.ps1`

    Сначала пытается установить Task Scheduler-задачу.
    Если Windows не даёт создать задачу, автоматически ставит shortcut в Startup folder.

.EXAMPLE
    .\autostart\install-windows.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$AMINA_DIR = Split-Path -Parent $SCRIPT_DIR
$BRIDGE_PS1 = Join-Path $SCRIPT_DIR 'start-windows-logon.ps1'
$BRIDGE_BAT = Join-Path $SCRIPT_DIR 'amina-bridge.bat'
$ENV_FILE = Join-Path $AMINA_DIR '.env'
$STARTUP_DIR = [Environment]::GetFolderPath('Startup')
$STARTUP_SHORTCUT = Join-Path $STARTUP_DIR 'Amina Bridge.lnk'
$TASK_NAME = 'Amina-Bridge'

function Write-Step  { param([string]$Msg) Write-Host "  -> $Msg" -ForegroundColor Green }
function Write-Info  { param([string]$Msg) Write-Host "  $Msg" -ForegroundColor Cyan }
function Write-Warn2 { param([string]$Msg) Write-Host "  [!] $Msg" -ForegroundColor Yellow }

function Remove-TaskIfExists {
    param([string]$TaskName)

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Warn2 "Existing task '$TaskName' removed"
    }
}

function Remove-StartupShortcutIfExists {
    if (Test-Path $STARTUP_SHORTCUT) {
        Remove-Item $STARTUP_SHORTCUT -Force -ErrorAction SilentlyContinue
        Write-Warn2 "Existing startup shortcut removed: $STARTUP_SHORTCUT"
    }
}

function Test-LocalEnvHasTunnelToken {
    if (-not (Test-Path $ENV_FILE)) {
        return $false
    }

    $match = Select-String -Path $ENV_FILE -Pattern '^LMSTUDIO_TUNNEL_TOKEN=' -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $match
}

function Install-StartupShortcut {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($STARTUP_SHORTCUT)
    $shortcut.TargetPath = $BRIDGE_BAT
    $shortcut.WorkingDirectory = $AMINA_DIR
    $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,43"
    $shortcut.Save()
}

function Try-Install-BridgeTask {
    try {
        $action = New-ScheduledTaskAction `
            -Execute 'powershell.exe' `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$BRIDGE_PS1`"" `
            -WorkingDirectory $AMINA_DIR

        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $trigger.Delay = 'PT10S'

        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit (New-TimeSpan -Days 365)

        Register-ScheduledTask `
            -TaskName $TASK_NAME `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Description 'Amina Bridge: LM Studio daemon + local server + cloudflared tunnel supervisor' `
            | Out-Null

        return $true
    } catch {
        Write-Warn2 "Task Scheduler install failed: $($_.Exception.Message)"
        return $false
    }
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Amina Bridge Installer (Windows)' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $BRIDGE_PS1)) {
    Write-Host "  [ERROR] start-windows-logon.ps1 not found at $BRIDGE_PS1" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $BRIDGE_BAT)) {
    Write-Host "  [ERROR] amina-bridge.bat not found at $BRIDGE_BAT" -ForegroundColor Red
    exit 1
}

$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
$npx = Get-Command npx.cmd,npx -ErrorAction SilentlyContinue | Select-Object -First 1
$lmsCli = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$userTunnelToken = [Environment]::GetEnvironmentVariable('LMSTUDIO_TUNNEL_TOKEN', 'User')

Write-Host 'Checks:' -ForegroundColor White
if ($cloudflared) {
    Write-Step "cloudflared found: $($cloudflared.Source)"
} else {
    Write-Warn2 'cloudflared not found. Install: winget install Cloudflare.cloudflared'
}

if ($npx) {
    Write-Step "npx found for localtunnel fallback: $($npx.Source)"
} else {
    Write-Warn2 'npx not found. Install Node.js if you want automatic localtunnel fallback'
}

if (Test-Path $lmsCli) {
    Write-Step "LM Studio CLI found: $lmsCli"
} else {
    Write-Warn2 'LM Studio CLI not found. Enable CLI in LM Studio: Settings -> Developer -> Enable CLI'
}

if ($userTunnelToken) {
    Write-Step 'LMSTUDIO_TUNNEL_TOKEN found in User environment'
} elseif (Test-LocalEnvHasTunnelToken) {
    Write-Step 'LMSTUDIO_TUNNEL_TOKEN found in local .env'
} else {
    Write-Warn2 'LMSTUDIO_TUNNEL_TOKEN not found in User environment or local .env'
}
Write-Host ''

Remove-TaskIfExists -TaskName 'Amina-Tunnel'
Remove-TaskIfExists -TaskName 'Amina-LMStudio'
Remove-TaskIfExists -TaskName $TASK_NAME
Remove-StartupShortcutIfExists

if (Try-Install-BridgeTask) {
    Write-Step "Task '$TASK_NAME' created (runs at logon)"
    $installMode = 'task'
} else {
    Install-StartupShortcut
    Write-Step "Startup shortcut created: $STARTUP_SHORTCUT"
    $installMode = 'startup'
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Done!' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'What is installed:' -ForegroundColor White
Write-Host '  Amina Bridge = LM Studio daemon + LM Studio server + tunnel supervisor'
Write-Host ''
Write-Host 'Manual start:' -ForegroundColor White
Write-Host "  `"$BRIDGE_BAT`""
Write-Host ''
Write-Host 'Logs:' -ForegroundColor White
Write-Host '  %TEMP%\amina-bridge.log'
Write-Host '  %TEMP%\amina-tunnel-*.log'
Write-Host ''

if ($installMode -eq 'task') {
    Write-Host 'Task Scheduler commands:' -ForegroundColor White
    Write-Host "  Get-ScheduledTask -TaskName `"$TASK_NAME`" | Select-Object State"
    Write-Host "  Start-ScheduledTask -TaskName `"$TASK_NAME`""
    Write-Host "  Stop-ScheduledTask -TaskName `"$TASK_NAME`""
    Write-Host "  Unregister-ScheduledTask -TaskName `"$TASK_NAME`" -Confirm:`$false"
} else {
    Write-Host 'Startup folder commands:' -ForegroundColor White
    Write-Host "  Remove-Item `"$STARTUP_SHORTCUT`" -Force"
}

Write-Host ''
Write-Host 'At next logon, Amina Bridge will start automatically.' -ForegroundColor Green
Write-Host ''
