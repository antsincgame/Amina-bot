#Requires -Version 5.1
<#
.SYNOPSIS
    Amina LM Studio Tunnel Supervisor (Windows)

.DESCRIPTION
    Автоматически:
    1. Ждёт запуска LM Studio на localhost
    2. Поднимает cloudflared quick tunnel
    3. Регистрирует URL туннеля на боте (Render)
    4. Мониторит tunnel — рестарт при падении

.EXAMPLE
    .\tunnel.ps1
    $env:LMSTUDIO_PORT = 8080; .\tunnel.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============================================
#  Configuration
# ============================================

$LMSTUDIO_PORT       = if ($env:LMSTUDIO_PORT)       { $env:LMSTUDIO_PORT }       else { '1234' }
$BOT_API_URL         = if ($env:BOT_API_URL)          { $env:BOT_API_URL }          else { 'https://amina-bot.onrender.com' }
$CLOUDFLARED_BIN     = if ($env:CLOUDFLARED_BIN)      { $env:CLOUDFLARED_BIN }      else { 'cloudflared' }
$HEALTH_INTERVAL     = if ($env:HEALTH_INTERVAL)      { [int]$env:HEALTH_INTERVAL } else { 30 }
$LMSTUDIO_WAIT_SEC   = 3
$TUNNEL_URL_TIMEOUT  = 30
$RESTART_DELAY       = 5

$script:TunnelProcess = $null
$script:TunnelLogFile = $null
$script:CurrentUrl    = ''

# ============================================
#  Logging
# ============================================

function Write-Log  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Red }
function Write-Dim  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor DarkGray }

# ============================================
#  Cleanup (вызывается при завершении)
# ============================================

function Stop-Tunnel {
    Write-Log 'Shutting down...'

    if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
        try {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(5000) | Out-Null
            Write-Log "cloudflared stopped (PID $($script:TunnelProcess.Id))"
        } catch {
            Write-Warn "Failed to stop cloudflared: $_"
        }
    }

    if ($script:TunnelLogFile -and (Test-Path $script:TunnelLogFile)) {
        Remove-Item $script:TunnelLogFile -Force -ErrorAction SilentlyContinue
    }
}

# ============================================
#  Dependency Check
# ============================================

function Test-Dependencies {
    $cfBin = Get-Command $CLOUDFLARED_BIN -ErrorAction SilentlyContinue
    if (-not $cfBin) {
        Write-Err "cloudflared not found. Install:"
        Write-Err "  winget install Cloudflare.cloudflared"
        Write-Err "  OR download from https://github.com/cloudflare/cloudflared/releases"
        exit 1
    }

    $version = & $CLOUDFLARED_BIN --version 2>&1 | Select-Object -First 1
    Write-Log "cloudflared: $version"
}

# ============================================
#  LM Studio Health
# ============================================

function Test-LMStudioOk {
    $urls = @(
        "http://localhost:${LMSTUDIO_PORT}/api/v1/models",
        "http://localhost:${LMSTUDIO_PORT}/v1/models"
    )

    foreach ($url in $urls) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) { return $true }
        } catch {
            continue
        }
    }

    return $false
}

function Wait-ForLMStudio {
    Write-Log "Waiting for LM Studio on port $LMSTUDIO_PORT..."

    while ($true) {
        if (Test-LMStudioOk) {
            Write-Log 'LM Studio is running'
            return
        }
        Start-Sleep -Seconds $LMSTUDIO_WAIT_SEC
    }
}

# ============================================
#  Tunnel URL Extraction
# ============================================

function Get-TunnelUrl {
    param([string]$LogFile)

    $elapsed = 0
    while ($elapsed -lt $TUNNEL_URL_TIMEOUT) {
        if (Test-Path $LogFile) {
            $content = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue
            if ($content) {
                $match = [regex]::Match($content, 'https://[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com')
                if ($match.Success) {
                    return $match.Value
                }
            }
        }
        Start-Sleep -Seconds 1
        $elapsed++
    }

    return $null
}

# ============================================
#  Bot API Communication
# ============================================

function Register-TunnelUrl {
    param([string]$Url)

    $body = @{ url = $Url } | ConvertTo-Json -Compress
    $headers = @{ 'Content-Type' = 'application/json' }

    try {
        $response = Invoke-WebRequest `
            -Uri "$BOT_API_URL/api/tunnel/register" `
            -Method POST `
            -Body $body `
            -Headers $headers `
            -UseBasicParsing `
            -TimeoutSec 15 `
            -ErrorAction Stop
        if ($response.StatusCode -in 200, 201) { return $true }
    } catch {
        Write-Warn "POST /api/tunnel/register failed: $_"
    }

    try {
        $fallbackBody = @{ value = $Url } | ConvertTo-Json -Compress
        $response = Invoke-WebRequest `
            -Uri "$BOT_API_URL/api/settings/lmstudio_url" `
            -Method PUT `
            -Body $fallbackBody `
            -Headers $headers `
            -UseBasicParsing `
            -TimeoutSec 15 `
            -ErrorAction Stop
        if ($response.StatusCode -in 200, 201) { return $true }
    } catch {
        Write-Warn "PUT /api/settings/lmstudio_url failed: $_"
    }

    return $false
}

function Send-Heartbeat {
    $body = @{ url = $script:CurrentUrl } | ConvertTo-Json -Compress
    try {
        Invoke-WebRequest `
            -Uri "$BOT_API_URL/api/tunnel/heartbeat" `
            -Method POST `
            -Body $body `
            -Headers @{ 'Content-Type' = 'application/json' } `
            -UseBasicParsing `
            -TimeoutSec 10 `
            -ErrorAction SilentlyContinue | Out-Null
    } catch {}
}

# ============================================
#  Tunnel Lifecycle
# ============================================

function Start-CloudflareTunnel {
    $tempDir = [System.IO.Path]::GetTempPath()
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'

    $script:TunnelLogFile = Join-Path $tempDir "amina-tunnel-$stamp.log"
    $stderrLog            = Join-Path $tempDir "amina-tunnel-$stamp-err.log"

    Write-Log "Starting cloudflared tunnel -> localhost:$LMSTUDIO_PORT"

    # cloudflared пишет URL в stderr — перенаправляем оба потока в файлы
    $script:TunnelProcess = Start-Process `
        -FilePath $CLOUDFLARED_BIN `
        -ArgumentList "tunnel --url http://localhost:$LMSTUDIO_PORT" `
        -RedirectStandardOutput $script:TunnelLogFile `
        -RedirectStandardError  $stderrLog `
        -NoNewWindow `
        -PassThru

    Start-Sleep -Seconds 2

    if ($script:TunnelProcess.HasExited) {
        Write-Err 'cloudflared exited immediately. Log:'
        foreach ($logPath in @($stderrLog, $script:TunnelLogFile)) {
            if (Test-Path $logPath) {
                Get-Content $logPath -Tail 20 | ForEach-Object { Write-Err "  $_" }
            }
        }
        return $false
    }

    Write-Dim "cloudflared PID: $($script:TunnelProcess.Id)"
    Write-Log "Extracting tunnel URL (up to ${TUNNEL_URL_TIMEOUT}s)..."

    # URL появляется в stderr — ищем там
    $url = Get-TunnelUrl -LogFile $stderrLog
    if (-not $url) {
        # Fallback: может URL попал в stdout
        $url = Get-TunnelUrl -LogFile $script:TunnelLogFile
    }

    if (-not $url) {
        Write-Err 'Failed to extract tunnel URL. Last cloudflared output:'
        foreach ($logPath in @($stderrLog, $script:TunnelLogFile)) {
            if (Test-Path $logPath) {
                Get-Content $logPath -Tail 20 | ForEach-Object { Write-Err "  $_" }
            }
        }
        Write-Err 'Tip: if you have ~/.cloudflared/config.yaml, remove or rename it (quick tunnels do not work with config)'

        if (-not $script:TunnelProcess.HasExited) {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(3000) | Out-Null
        }
        $script:TunnelProcess = $null
        return $false
    }

    $script:CurrentUrl = $url
    Write-Log "Tunnel URL: $url"

    Write-Log "Registering URL with bot at $BOT_API_URL..."
    if (Register-TunnelUrl -Url $url) {
        Write-Log 'URL registered successfully'
    } else {
        Write-Warn 'Failed to register URL (bot may be offline). Will retry on next health check.'
    }

    return $true
}

# exit_reason: 1 = tunnel died, 2 = LM Studio offline
function Watch-Tunnel {
    Write-Log "Monitoring tunnel (health check every ${HEALTH_INTERVAL}s)..."
    Write-Host ''
    Write-Log '=== Tunnel active ==='
    Write-Log "  LM Studio:  http://localhost:$LMSTUDIO_PORT"
    Write-Log "  Tunnel URL:  $($script:CurrentUrl)"
    Write-Log "  Bot API:     $BOT_API_URL"
    Write-Log '  Press Ctrl+C to stop'
    Write-Host ''

    while ($true) {
        Start-Sleep -Seconds $HEALTH_INTERVAL

        if (-not $script:TunnelProcess -or $script:TunnelProcess.HasExited) {
            Write-Warn "cloudflared process died. Restarting in ${RESTART_DELAY}s..."
            $script:TunnelProcess = $null
            Start-Sleep -Seconds $RESTART_DELAY
            return 1
        }

        if (-not (Test-LMStudioOk)) {
            Write-Warn 'LM Studio went offline. Stopping tunnel...'
            if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                $script:TunnelProcess.Kill()
                $script:TunnelProcess.WaitForExit(3000) | Out-Null
            }
            $script:TunnelProcess = $null
            return 2
        }

        Send-Heartbeat
        $ts = Get-Date -Format 'HH:mm:ss'
        Write-Dim "$ts tunnel: ok | lmstudio: ok"
    }
}

# ============================================
#  Main Loop
# ============================================

function Start-TunnelSupervisor {
    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host '  Amina LM Studio Tunnel Supervisor (Win)' -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host ''

    Test-Dependencies

    try {
        while ($true) {
            Wait-ForLMStudio

            if (Start-CloudflareTunnel) {
                $exitReason = Watch-Tunnel

                if ($exitReason -eq 2) {
                    Write-Log 'LM Studio offline - waiting for it to come back...'
                    if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                        $script:TunnelProcess.Kill()
                        $script:TunnelProcess.WaitForExit(3000) | Out-Null
                    }
                    $script:TunnelProcess = $null
                    continue
                }

                Write-Warn 'Tunnel crashed - restarting...'
            } else {
                Write-Warn "Failed to start tunnel - retrying in ${RESTART_DELAY}s..."
                Start-Sleep -Seconds $RESTART_DELAY
            }
        }
    } finally {
        Stop-Tunnel
    }
}

# ============================================
#  Entry Point
# ============================================

Start-TunnelSupervisor
