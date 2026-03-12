#Requires -Version 5.1
<#
.SYNOPSIS
    Amina LM Studio Tunnel Supervisor (Windows)

.DESCRIPTION
    1. Kills stale cloudflared before start
    2. Waits for LM Studio on localhost
    3. Starts cloudflared quick tunnel (HTTP/2, with retry)
    4. Registers tunnel URL with bot (Render)
    5. Monitors: process + LM Studio + real reachability
    6. Restarts on: process death / LM Studio offline / URL expired
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============================================
#  Configuration
# ============================================

$LMSTUDIO_PORT          = if ($env:LMSTUDIO_PORT)       { $env:LMSTUDIO_PORT }       else { '1234' }
$BOT_API_URL            = if ($env:BOT_API_URL)          { $env:BOT_API_URL }          else { 'https://amina-bot.onrender.com' }
$LMSTUDIO_TUNNEL_TOKEN  = if ($env:LMSTUDIO_TUNNEL_TOKEN) { $env:LMSTUDIO_TUNNEL_TOKEN } else { '' }
$CLOUDFLARED_BIN        = if ($env:CLOUDFLARED_BIN)      { $env:CLOUDFLARED_BIN }      else { 'cloudflared' }
$HEALTH_INTERVAL        = if ($env:HEALTH_INTERVAL)      { [int]$env:HEALTH_INTERVAL } else { 30 }
$LMSTUDIO_WAIT_SEC      = 3
$TUNNEL_URL_TIMEOUT     = 30
$RESTART_DELAY          = 5
$START_RETRIES          = 3
$UNHEALTHY_THRESHOLD    = 3

$script:TunnelProcess   = $null
$script:TunnelLogFile   = $null
$script:CurrentUrl      = ''
$script:UnhealthyCount  = 0

# ============================================
#  Logging
# ============================================

function Write-Log  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor Red }
function Write-Dim  { param([string]$Msg) Write-Host "[tunnel] $Msg" -ForegroundColor DarkGray }

# ============================================
#  Cleanup
# ============================================

function Stop-AllCloudflared {
    Get-Process -Name cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Warn "Killing stale cloudflared PID $($_.Id)"
        $_ | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

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
        exit 1
    }

    $version = & $CLOUDFLARED_BIN --version 2>&1 | Select-Object -First 1
    Write-Log "cloudflared: $version"

    if ([string]::IsNullOrWhiteSpace($LMSTUDIO_TUNNEL_TOKEN)) {
        Write-Err 'LMSTUDIO_TUNNEL_TOKEN is not set'
        exit 1
    }
}

# ============================================
#  LM Studio Health
# ============================================

function Test-LMStudioOk {
    foreach ($path in @('/api/v1/models', '/v1/models')) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:${LMSTUDIO_PORT}${path}" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { return $true }
        } catch { continue }
    }
    return $false
}

function Wait-ForLMStudio {
    Write-Log "Waiting for LM Studio on port $LMSTUDIO_PORT..."
    while (-not (Test-LMStudioOk)) {
        Start-Sleep -Seconds $LMSTUDIO_WAIT_SEC
    }
    Write-Log 'LM Studio is running'
}

# ============================================
#  Tunnel URL Extraction
# ============================================

function Get-TunnelUrl {
    param([string]$LogFile)

    for ($i = 0; $i -lt $TUNNEL_URL_TIMEOUT; $i++) {
        if (Test-Path $LogFile) {
            $content = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue
            if ($content) {
                $match = [regex]::Match($content, 'https://[a-zA-Z0-9]+-[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com')
                if ($match.Success) { return $match.Value }
            }
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

# ============================================
#  Bot API Communication
# ============================================

function Send-Register {
    param([string]$Url)

    $body    = @{ url = $Url } | ConvertTo-Json -Compress
    $headers = @{
        'Content-Type' = 'application/json'
        'X-Amina-Tunnel-Token' = $LMSTUDIO_TUNNEL_TOKEN
    }

    try {
        $r = Invoke-WebRequest `
            -Uri "$BOT_API_URL/api/tunnel/register" `
            -Method POST -Body $body -Headers $headers `
            -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop

        if ($r.StatusCode -in 200, 201) {
            $json = $r.Content | ConvertFrom-Json
            return $json
        }
    } catch {
        Write-Warn "POST /api/tunnel/register failed: $($_.Exception.Message)"
    }

    return $null
}

function Register-TunnelUrl {
    param([string]$Url)
    $result = Send-Register -Url $Url
    return ($null -ne $result)
}

# Heartbeat: refresh status without rewriting lmstudio_url
function Send-Heartbeat {
    $body    = @{ url = $script:CurrentUrl } | ConvertTo-Json -Compress
    $headers = @{
        'Content-Type' = 'application/json'
        'X-Amina-Tunnel-Token' = $LMSTUDIO_TUNNEL_TOKEN
    }

    try {
        $response = Invoke-WebRequest `
            -Uri "$BOT_API_URL/api/tunnel/heartbeat" `
            -Method POST -Body $body -Headers $headers `
            -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop

        return ($response.StatusCode -in 200, 201)
    } catch {
        $statusCode = $null
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}

        if ($statusCode) {
            return $false
        }

        return $null
    }
}

# ============================================
#  Tunnel Lifecycle
# ============================================

function Start-SingleCloudflaredAttempt {
    $tempDir = [System.IO.Path]::GetTempPath()
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'

    $script:TunnelLogFile = Join-Path $tempDir "amina-tunnel-$stamp.log"
    $stderrLog            = Join-Path $tempDir "amina-tunnel-$stamp-err.log"

    $script:TunnelProcess = Start-Process `
        -FilePath $CLOUDFLARED_BIN `
        -ArgumentList "tunnel --url http://localhost:$LMSTUDIO_PORT --protocol http2" `
        -RedirectStandardOutput $script:TunnelLogFile `
        -RedirectStandardError  $stderrLog `
        -NoNewWindow -PassThru

    Start-Sleep -Seconds 3

    if ($script:TunnelProcess.HasExited) {
        Write-Warn "cloudflared exited immediately (exit $($script:TunnelProcess.ExitCode))"
        return $null
    }

    Write-Dim "cloudflared PID: $($script:TunnelProcess.Id)"

    $url = Get-TunnelUrl -LogFile $stderrLog
    if (-not $url) { $url = Get-TunnelUrl -LogFile $script:TunnelLogFile }

    if (-not $url) {
        Write-Warn 'Failed to extract tunnel URL'
        if (-not $script:TunnelProcess.HasExited) {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(3000) | Out-Null
        }
        $script:TunnelProcess = $null
        return $null
    }

    return $url
}

function Start-CloudflareTunnel {
    Write-Log "Starting cloudflared tunnel -> localhost:$LMSTUDIO_PORT"

    Stop-AllCloudflared
    Start-Sleep -Seconds 1

    for ($attempt = 1; $attempt -le $START_RETRIES; $attempt++) {
        Write-Log "Attempt $attempt/$START_RETRIES..."

        $url = Start-SingleCloudflaredAttempt
        if ($url) {
            $script:CurrentUrl = $url
            $script:UnhealthyCount = 0
            Write-Log "Tunnel URL: $url"

            Write-Log "Registering URL with bot at $BOT_API_URL..."
            if (Register-TunnelUrl -Url $url) {
                Write-Log 'URL registered successfully'
            } else {
                Write-Warn 'Registration failed (bot may be offline). Will retry via heartbeat.'
            }
            return $true
        }

        if ($attempt -lt $START_RETRIES) {
            Write-Warn "Retrying in ${RESTART_DELAY}s..."
            Stop-AllCloudflared
            Start-Sleep -Seconds $RESTART_DELAY
        }
    }

    Write-Err "Failed to start tunnel after $START_RETRIES attempts"
    return $false
}

# ============================================
#  Monitoring (exit_reason: 1=crashed, 2=lm_offline, 3=url_dead)
# ============================================

function Watch-Tunnel {
    Write-Log "Monitoring (health check every ${HEALTH_INTERVAL}s, restart after ${UNHEALTHY_THRESHOLD} unhealthy)..."
    Write-Host ''
    Write-Log '=== Tunnel active ==='
    Write-Log "  LM Studio:  http://localhost:$LMSTUDIO_PORT"
    Write-Log "  Tunnel URL:  $($script:CurrentUrl)"
    Write-Log "  Bot API:     $BOT_API_URL"
    Write-Log '  Press Ctrl+C to stop'
    Write-Host ''

    while ($true) {
        Start-Sleep -Seconds $HEALTH_INTERVAL

        # 1. cloudflared process alive?
        if (-not $script:TunnelProcess -or $script:TunnelProcess.HasExited) {
            Write-Warn 'cloudflared process died'
            $script:TunnelProcess = $null
            return 1
        }

        # 2. LM Studio alive?
        if (-not (Test-LMStudioOk)) {
            Write-Warn 'LM Studio went offline'
            if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                $script:TunnelProcess.Kill()
                $script:TunnelProcess.WaitForExit(3000) | Out-Null
            }
            $script:TunnelProcess = $null
            return 2
        }

        # 3. Heartbeat + reachability check
        $healthy = Send-Heartbeat
        $ts = Get-Date -Format 'HH:mm:ss'

        if ($healthy -eq $true) {
            $script:UnhealthyCount = 0
            Write-Dim "$ts tunnel: ok | lmstudio: ok | render: ok"
        }
        elseif ($healthy -eq $false) {
            $script:UnhealthyCount++
            Write-Warn "$ts tunnel: ok | lmstudio: ok | render: UNHEALTHY ($($script:UnhealthyCount)/$UNHEALTHY_THRESHOLD)"

            if ($script:UnhealthyCount -ge $UNHEALTHY_THRESHOLD) {
                Write-Err "Tunnel URL unreachable from Render for $UNHEALTHY_THRESHOLD checks - restarting with new URL"
                if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                    $script:TunnelProcess.Kill()
                    $script:TunnelProcess.WaitForExit(3000) | Out-Null
                }
                $script:TunnelProcess = $null
                return 3
            }
        }
        else {
            Write-Dim "$ts tunnel: ok | lmstudio: ok | render: no response"
        }
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
    Stop-AllCloudflared

    try {
        while ($true) {
            Wait-ForLMStudio

            if (Start-CloudflareTunnel) {
                $exitReason = Watch-Tunnel

                switch ($exitReason) {
                    2 {
                        Write-Log 'LM Studio offline - waiting for it to come back...'
                        continue
                    }
                    3 {
                        Write-Warn 'Tunnel URL expired - getting new one...'
                        Start-Sleep -Seconds $RESTART_DELAY
                        continue
                    }
                    default {
                        Write-Warn "Tunnel crashed - restarting in ${RESTART_DELAY}s..."
                        Start-Sleep -Seconds $RESTART_DELAY
                    }
                }
            } else {
                Write-Warn "Failed to start tunnel - retrying in ${RESTART_DELAY}s..."
                Start-Sleep -Seconds $RESTART_DELAY
            }
        }
    } finally {
        Stop-Tunnel
    }
}

Start-TunnelSupervisor
