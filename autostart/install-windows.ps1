#Requires -Version 5.1
<#
.SYNOPSIS
    Установка автозапуска LM Studio и tunnel.ps1 на Windows

.DESCRIPTION
    Создаёт задачи в Task Scheduler:
    1. Amina-LMStudio — запуск LM Studio при входе в систему
    2. Amina-Tunnel   — запуск tunnel.ps1 (ждёт LM Studio, поднимает cloudflared)

    Не требует прав администратора — задачи создаются для текущего пользователя.

.EXAMPLE
    .\autostart\install-windows.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$AMINA_DIR  = Split-Path -Parent $SCRIPT_DIR
$TUNNEL_PS1 = Join-Path $AMINA_DIR 'tunnel.ps1'

# ============================================
#  Helpers
# ============================================

function Write-Step  { param([string]$Msg) Write-Host "  -> $Msg" -ForegroundColor Green }
function Write-Info  { param([string]$Msg) Write-Host "  $Msg" -ForegroundColor Cyan }
function Write-Warn2 { param([string]$Msg) Write-Host "  [!] $Msg" -ForegroundColor Yellow }

function Find-LMStudioExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'LM Studio\LM Studio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\LM Studio\LM Studio.exe'),
        (Join-Path ${env:ProgramFiles} 'LM Studio\LM Studio.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'LM Studio\LM Studio.exe')
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }

    $lmsCliPath = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
    if (Test-Path $lmsCliPath) { return $lmsCliPath }

    return $null
}

function Remove-TaskIfExists {
    param([string]$TaskName)
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Warn2 "Existing task '$TaskName' removed"
    }
}

# ============================================
#  Banner
# ============================================

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Amina Autostart Installer (Windows)' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

# ============================================
#  1. Tunnel (Task Scheduler)
# ============================================

Write-Host '1. Tunnel (tunnel.ps1) - Task Scheduler' -ForegroundColor White

if (-not (Test-Path $TUNNEL_PS1)) {
    Write-Host "  [ERROR] tunnel.ps1 not found at $TUNNEL_PS1" -ForegroundColor Red
    exit 1
}

$cfBin = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cfBin) {
    Write-Warn2 'cloudflared not found. Install: winget install Cloudflare.cloudflared'
    Write-Warn2 'Continuing anyway (you can install it later)...'
}

Remove-TaskIfExists -TaskName 'Amina-Tunnel'

$tunnelAction = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$TUNNEL_PS1`"" `
    -WorkingDirectory $AMINA_DIR

$tunnelTrigger = New-ScheduledTaskTrigger -AtLogOn

$tunnelSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)

Register-ScheduledTask `
    -TaskName 'Amina-Tunnel' `
    -Action $tunnelAction `
    -Trigger $tunnelTrigger `
    -Settings $tunnelSettings `
    -Description 'Amina LM Studio Tunnel Supervisor - cloudflared quick tunnel' `
    | Out-Null

Write-Step 'Task "Amina-Tunnel" created (runs at logon)'
Write-Host ''

# ============================================
#  2. LM Studio - выбор режима
# ============================================

Write-Host '2. LM Studio - choose mode:' -ForegroundColor White
Write-Host '   [1] GUI - auto-start LM Studio app at logon'
Write-Host '   [2] Headless (lms CLI) - start server without GUI'
Write-Host '   [3] Skip (I start LM Studio manually)'
Write-Host ''

$choice = Read-Host '   Enter choice (1/2/3)'

switch ($choice) {
    '1' {
        $lmExe = Find-LMStudioExe
        if (-not $lmExe) {
            Write-Warn2 'LM Studio not found in standard paths.'
            $lmExe = Read-Host '   Enter full path to LM Studio.exe'
            if (-not (Test-Path $lmExe)) {
                Write-Host "   [ERROR] File not found: $lmExe" -ForegroundColor Red
                break
            }
        }

        Remove-TaskIfExists -TaskName 'Amina-LMStudio'

        $lmAction = New-ScheduledTaskAction `
            -Execute $lmExe

        $lmTrigger = New-ScheduledTaskTrigger -AtLogOn

        # Задержка 5 секунд после входа
        $lmTrigger.Delay = 'PT5S'

        $lmSettings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Days 365)

        Register-ScheduledTask `
            -TaskName 'Amina-LMStudio' `
            -Action $lmAction `
            -Trigger $lmTrigger `
            -Settings $lmSettings `
            -Description 'LM Studio - local LLM server for Amina bot' `
            | Out-Null

        Write-Step "Task 'Amina-LMStudio' created (runs at logon with 5s delay)"
        Write-Info "Path: $lmExe"
    }

    '2' {
        $lmsCli = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
        if (-not (Test-Path $lmsCli)) {
            Write-Warn2 'lms CLI not found. Install LM Studio first, then enable CLI:'
            Write-Warn2 '  Settings -> Developer -> Enable CLI'
            break
        }

        Remove-TaskIfExists -TaskName 'Amina-LMStudio'

        # lms server start запускает headless-сервер
        $lmAction = New-ScheduledTaskAction `
            -Execute $lmsCli `
            -Argument 'server start'

        $lmTrigger = New-ScheduledTaskTrigger -AtLogOn
        $lmTrigger.Delay = 'PT5S'

        $lmSettings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Days 365)

        Register-ScheduledTask `
            -TaskName 'Amina-LMStudio' `
            -Action $lmAction `
            -Trigger $lmTrigger `
            -Settings $lmSettings `
            -Description 'LM Studio Headless Server for Amina bot (lms CLI)' `
            | Out-Null

        Write-Step "Task 'Amina-LMStudio' created (headless, runs at logon)"
        Write-Info "CLI: $lmsCli"
    }

    default {
        Write-Info 'Skipped.'
    }
}

Write-Host ''

# ============================================
#  Summary
# ============================================

Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  Done!' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Commands:' -ForegroundColor White
Write-Host '  # Check tunnel status'
Write-Host '  Get-ScheduledTask -TaskName "Amina-Tunnel" | Select-Object State'
Write-Host ''
Write-Host '  # Start tunnel now'
Write-Host '  Start-ScheduledTask -TaskName "Amina-Tunnel"'
Write-Host ''
Write-Host '  # Stop tunnel'
Write-Host '  Stop-ScheduledTask -TaskName "Amina-Tunnel"'
Write-Host ''
Write-Host '  # View all Amina tasks'
Write-Host '  Get-ScheduledTask -TaskName "Amina-*"'
Write-Host ''
Write-Host '  # Remove autostart completely'
Write-Host '  Unregister-ScheduledTask -TaskName "Amina-Tunnel" -Confirm:$false'
Write-Host '  Unregister-ScheduledTask -TaskName "Amina-LMStudio" -Confirm:$false'
Write-Host ''
Write-Host 'At next logon, LM Studio and tunnel will start automatically.' -ForegroundColor Green
Write-Host ''
