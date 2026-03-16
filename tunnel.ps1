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

function Import-LocalEnvFile {
    param(
        [string]$EnvPath,
        [string[]]$Keys
    )

    if (-not (Test-Path $EnvPath)) {
        return
    }

    foreach ($line in (Get-Content $EnvPath -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }

        $parts = $trimmed -split '=', 2
        if ($parts.Length -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        if ($Keys -notcontains $key) {
            continue
        }

        $existing = [Environment]::GetEnvironmentVariable($key, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($existing)) {
            continue
        }

        $value = $parts[1].Trim()
        if ((($value.StartsWith('"')) -and ($value.EndsWith('"'))) -or (($value.StartsWith("'")) -and ($value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

$script:RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-LocalEnvFile `
    -EnvPath (Join-Path $script:RootDir '.env') `
    -Keys @('LMSTUDIO_PORT', 'BOT_API_URL', 'LMSTUDIO_TUNNEL_TOKEN', 'CLOUDFLARED_BIN', 'HEALTH_INTERVAL', 'CLOUDFLARED_TUNNEL_ARGS', 'CLOUDFLARED_PUBLIC_URL', 'TUNNEL_PROVIDER', 'LOCALTUNNEL_ARGS')

# ============================================
#  Configuration
# ============================================

$LMSTUDIO_PORT          = if ($env:LMSTUDIO_PORT)       { $env:LMSTUDIO_PORT }       else { '1234' }
$BOT_API_URL            = if ($env:BOT_API_URL)          { $env:BOT_API_URL }          else { 'https://amina.vibecoding.by' }
$LMSTUDIO_TUNNEL_TOKEN  = if ($env:LMSTUDIO_TUNNEL_TOKEN) { $env:LMSTUDIO_TUNNEL_TOKEN } else { '' }
$CLOUDFLARED_BIN        = if ($env:CLOUDFLARED_BIN)      { $env:CLOUDFLARED_BIN }      else { 'cloudflared' }
$CLOUDFLARED_TUNNEL_ARGS = if ($env:CLOUDFLARED_TUNNEL_ARGS) { $env:CLOUDFLARED_TUNNEL_ARGS } else { '' }
$CLOUDFLARED_PUBLIC_URL  = if ($env:CLOUDFLARED_PUBLIC_URL) { $env:CLOUDFLARED_PUBLIC_URL.Trim().TrimEnd('/') } else { '' }
$TUNNEL_PROVIDER        = if ($env:TUNNEL_PROVIDER) { $env:TUNNEL_PROVIDER.ToLowerInvariant() } else { 'auto' }
$LOCALTUNNEL_ARGS       = if ($env:LOCALTUNNEL_ARGS) { $env:LOCALTUNNEL_ARGS } else { "-y localtunnel@2.0.2 --port $LMSTUDIO_PORT" }
$HEALTH_INTERVAL        = if ($env:HEALTH_INTERVAL)      { [int]$env:HEALTH_INTERVAL } else { 30 }
$LMSTUDIO_WAIT_SEC      = 3
$TUNNEL_URL_TIMEOUT     = 30
$RESTART_DELAY          = 5
$START_RETRIES          = 3
$UNHEALTHY_THRESHOLD    = 3
$REGISTER_RETRY_LIMIT   = 4
$REGISTER_RETRY_DELAY   = 5
$NO_RESPONSE_THRESHOLD  = 4
$PUBLIC_READY_TIMEOUT   = 45
$RATE_LIMIT_BACKOFF_SEC = 120

$script:TunnelProcess   = $null
$script:TunnelLogFile   = $null
$script:CurrentUrl      = ''
$script:UnhealthyCount  = 0
$script:NoResponseCount = 0
$script:IsRegistered    = $false
$script:NextRestartDelay = $RESTART_DELAY
$script:CurrentProvider = ''

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

function Stop-AllLocalTunnel {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains('localtunnel')
    } | ForEach-Object {
        Write-Warn "Killing stale localtunnel PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-AllTunnelProviders {
    Stop-AllCloudflared
    Stop-AllLocalTunnel
}

function Stop-Tunnel {
    Write-Log 'Shutting down...'

    if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
        try {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(5000) | Out-Null
            Write-Log "Tunnel provider '$($script:CurrentProvider)' stopped (PID $($script:TunnelProcess.Id))"
        } catch {
            Write-Warn "Failed to stop tunnel process: $_"
        }
    }

    if ($script:TunnelLogFile -and (Test-Path $script:TunnelLogFile)) {
        Remove-Item $script:TunnelLogFile -Force -ErrorAction SilentlyContinue
    }

    Stop-AllLocalTunnel
}

# ============================================
#  Dependency Check
# ============================================

function Test-Dependencies {
    $requiresCloudflared = $TUNNEL_PROVIDER -in @('auto', 'cloudflare')
    if ($requiresCloudflared) {
        $cfBin = Get-Command $CLOUDFLARED_BIN -ErrorAction SilentlyContinue
        if (-not $cfBin) {
            if ($TUNNEL_PROVIDER -eq 'cloudflare') {
                Write-Err "cloudflared not found. Install:"
                Write-Err "  winget install Cloudflare.cloudflared"
                exit 1
            }

            Write-Warn 'cloudflared not found - auto mode will rely on localtunnel fallback'
        } else {
            $version = & $CLOUDFLARED_BIN --version 2>&1 | Select-Object -First 1
            Write-Log "cloudflared: $version"
        }
    }

    $requiresLocalTunnel = $TUNNEL_PROVIDER -in @('auto', 'localtunnel')
    if ($requiresLocalTunnel) {
        $npxBin = Get-Command npx.cmd,npx -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npxBin) {
            if ($TUNNEL_PROVIDER -eq 'localtunnel') {
                Write-Err 'npx not found. Install Node.js to enable localtunnel fallback'
                exit 1
            }

            Write-Warn 'npx not found - auto mode will rely on cloudflared only'
        }
    }

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

function Get-TunnelProbeUrls {
    param([string]$Url)

    $baseUrl = $Url.TrimEnd('/')
    return @(
        "$baseUrl/v1/models",
        "$baseUrl/api/v1/models"
    )
}

function Test-TunnelUrlReady {
    param([string]$Url)

    foreach ($probeUrl in (Get-TunnelProbeUrls -Url $Url)) {
        try {
            $response = Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $true
            }
        } catch {
            $statusCode = $null
            try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
            if ($statusCode -in 401, 403) {
                return $true
            }
        }
    }

    return $false
}

function Wait-ForTunnelUrlReady {
    param(
        [string]$Url,
        [int]$TimeoutSec = $PUBLIC_READY_TIMEOUT
    )

    Write-Dim 'Waiting for tunnel URL to become publicly reachable...'
    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        if (Test-TunnelUrlReady -Url $Url) {
            return $true
        }
        Start-Sleep -Seconds 1
    }

    return $false
}

function Get-TunnelRestartDelayFromLogs {
    param([string[]]$LogFiles)

    foreach ($logFile in $LogFiles) {
        if (-not (Test-Path $logFile)) {
            continue
        }

        $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if (-not $content) {
            continue
        }

        if ($content -match '429 Too Many Requests' -or $content -match 'error code:\s*1015') {
            return $RATE_LIMIT_BACKOFF_SEC
        }
    }

    return $RESTART_DELAY
}

# ============================================
#  Tunnel URL Extraction
# ============================================

function Get-QuickTunnelUrl {
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

function Get-LocalTunnelUrl {
    param([string]$LogFile)

    for ($i = 0; $i -lt $TUNNEL_URL_TIMEOUT; $i++) {
        if (Test-Path $LogFile) {
            $content = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue
            if ($content) {
                $match = [regex]::Match($content, 'https://[a-zA-Z0-9-]+\.loca\.lt')
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

function Ensure-TunnelRegistered {
    param(
        [string]$Url,
        [int]$Attempts = $REGISTER_RETRY_LIMIT,
        [switch]$WaitUntilReady
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $false
    }

    if ($WaitUntilReady -and -not (Wait-ForTunnelUrlReady -Url $Url)) {
        Write-Warn 'Tunnel URL did not become publicly reachable in time'
        $script:IsRegistered = $false
        return $false
    }

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (Register-TunnelUrl -Url $Url) {
            $script:IsRegistered = $true
            $script:UnhealthyCount = 0
            $script:NoResponseCount = 0
            return $true
        }

        if ($attempt -lt $Attempts) {
            Write-Warn "Registration retry $attempt/$Attempts failed - retrying in ${REGISTER_RETRY_DELAY}s"
            Start-Sleep -Seconds $REGISTER_RETRY_DELAY
        }
    }

    $script:IsRegistered = $false
    return $false
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

        if ($response.StatusCode -in 200, 201) {
            return 'ok'
        }

        return 'unhealthy'
    } catch {
        $statusCode = $null
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}

        switch ($statusCode) {
            401 { return 'auth_error' }
            403 { return 'auth_error' }
            409 { return 'conflict' }
            503 { return 'server_error' }
        }

        if ($statusCode) {
            return 'unhealthy'
        }

        return 'no_response'
    }
}

# ============================================
#  Tunnel Lifecycle
# ============================================

function Start-SingleCloudflaredAttempt {
    $tempDir = [System.IO.Path]::GetTempPath()
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
    $argumentList = if ([string]::IsNullOrWhiteSpace($CLOUDFLARED_TUNNEL_ARGS)) {
        "tunnel --url http://localhost:$LMSTUDIO_PORT --protocol http2"
    } else {
        $CLOUDFLARED_TUNNEL_ARGS
    }

    $script:TunnelLogFile = Join-Path $tempDir "amina-tunnel-$stamp.log"
    $stderrLog            = Join-Path $tempDir "amina-tunnel-$stamp-err.log"
    $script:NextRestartDelay = $RESTART_DELAY

    $script:TunnelProcess = Start-Process `
        -FilePath $CLOUDFLARED_BIN `
        -ArgumentList $argumentList `
        -RedirectStandardOutput $script:TunnelLogFile `
        -RedirectStandardError  $stderrLog `
        -NoNewWindow -PassThru

    Start-Sleep -Seconds 3

    if ($script:TunnelProcess.HasExited) {
        $script:NextRestartDelay = Get-TunnelRestartDelayFromLogs -LogFiles @($stderrLog, $script:TunnelLogFile)
        Write-Warn "cloudflared exited immediately (exit $($script:TunnelProcess.ExitCode))"
        return $null
    }

    Write-Dim "cloudflared PID: $($script:TunnelProcess.Id)"

    if (-not [string]::IsNullOrWhiteSpace($CLOUDFLARED_PUBLIC_URL)) {
        $url = $CLOUDFLARED_PUBLIC_URL
    } else {
        $url = Get-QuickTunnelUrl -LogFile $stderrLog
        if (-not $url) { $url = Get-QuickTunnelUrl -LogFile $script:TunnelLogFile }
    }

    if (-not $url) {
        $script:NextRestartDelay = Get-TunnelRestartDelayFromLogs -LogFiles @($stderrLog, $script:TunnelLogFile)
        Write-Warn 'Failed to extract tunnel URL'
        if (-not $script:TunnelProcess.HasExited) {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(3000) | Out-Null
        }
        $script:TunnelProcess = $null
        return $null
    }

    $script:NextRestartDelay = $RESTART_DELAY
    return $url
}

function Start-SingleLocalTunnelAttempt {
    $tempDir = [System.IO.Path]::GetTempPath()
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
    $command = "npx $LOCALTUNNEL_ARGS"

    $script:TunnelLogFile = Join-Path $tempDir "amina-localtunnel-$stamp.log"
    $stderrLog            = Join-Path $tempDir "amina-localtunnel-$stamp-err.log"
    $script:NextRestartDelay = $RESTART_DELAY

    $script:TunnelProcess = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList "/d /s /c `"$command`"" `
        -RedirectStandardOutput $script:TunnelLogFile `
        -RedirectStandardError  $stderrLog `
        -NoNewWindow -PassThru

    Start-Sleep -Seconds 3

    if ($script:TunnelProcess.HasExited) {
        Write-Warn "localtunnel exited immediately (exit $($script:TunnelProcess.ExitCode))"
        return $null
    }

    Write-Dim "localtunnel PID: $($script:TunnelProcess.Id)"

    $url = Get-LocalTunnelUrl -LogFile $script:TunnelLogFile
    if (-not $url) { $url = Get-LocalTunnelUrl -LogFile $stderrLog }

    if (-not $url) {
        Write-Warn 'Failed to extract localtunnel URL'
        if (-not $script:TunnelProcess.HasExited) {
            $script:TunnelProcess.Kill()
            $script:TunnelProcess.WaitForExit(3000) | Out-Null
        }
        $script:TunnelProcess = $null
        return $null
    }

    return $url
}

function Get-TunnelProviders {
    switch ($TUNNEL_PROVIDER) {
        'cloudflare' { return @('cloudflare') }
        'localtunnel' { return @('localtunnel') }
        default { return @('cloudflare', 'localtunnel') }
    }
}

function Start-TunnelTransport {
    $providers = Get-TunnelProviders
    Write-Log "Starting tunnel transport ($($providers -join ' -> ')) -> localhost:$LMSTUDIO_PORT"

    Stop-AllTunnelProviders
    Start-Sleep -Seconds 1

    for ($attempt = 1; $attempt -le $START_RETRIES; $attempt++) {
        Write-Log "Attempt $attempt/$START_RETRIES..."

        foreach ($provider in $providers) {
            switch ($provider) {
                'cloudflare' {
                    Write-Dim 'Trying provider: cloudflare'
                    $url = Start-SingleCloudflaredAttempt
                }
                'localtunnel' {
                    Write-Dim 'Trying provider: localtunnel'
                    Stop-AllLocalTunnel
                    $url = Start-SingleLocalTunnelAttempt
                }
                default {
                    $url = $null
                }
            }

            if (-not $url) {
                if ($provider -eq 'cloudflare' -and $script:NextRestartDelay -ge $RATE_LIMIT_BACKOFF_SEC -and $providers -contains 'localtunnel') {
                    Write-Warn 'Cloudflare quick tunnel is rate-limited; trying localtunnel fallback now'
                }
                continue
            }

            $script:CurrentProvider = $provider
            $script:CurrentUrl = $url
            $script:UnhealthyCount = 0
            $script:NoResponseCount = 0
            $script:IsRegistered = $false
            Write-Log "Tunnel provider: $provider"
            Write-Log "Tunnel URL: $url"

            Write-Log "Registering URL with bot at $BOT_API_URL..."
            if (Ensure-TunnelRegistered -Url $url -WaitUntilReady) {
                Write-Log 'URL registered successfully'
            } else {
                Write-Warn 'Registration failed. Supervisor will keep tunnel alive and retry registration.'
            }
            return $true
        }

        if ($attempt -lt $START_RETRIES) {
            Write-Warn "Retrying in $($script:NextRestartDelay)s..."
            Stop-AllTunnelProviders
            Start-Sleep -Seconds $script:NextRestartDelay
        }
    }

    Write-Err "Failed to start tunnel after $START_RETRIES attempts"
    return $false
}

# ============================================
#  Monitoring (exit_reason: 1=crashed, 2=lm_offline, 3=url_dead, 4=auth_error)
# ============================================

function Watch-Tunnel {
    Write-Log "Monitoring (health check every ${HEALTH_INTERVAL}s, restart after ${UNHEALTHY_THRESHOLD} unhealthy)..."
    Write-Host ''
    Write-Log '=== Tunnel active ==='
    Write-Log "  LM Studio:  http://localhost:$LMSTUDIO_PORT"
    Write-Log "  Provider:    $($script:CurrentProvider)"
    Write-Log "  Tunnel URL:  $($script:CurrentUrl)"
    Write-Log "  Bot API:     $BOT_API_URL"
    Write-Log '  Press Ctrl+C to stop'
    Write-Host ''

    while ($true) {
        Start-Sleep -Seconds $HEALTH_INTERVAL
        $ts = Get-Date -Format 'HH:mm:ss'

        # 1. Active tunnel process alive?
        if (-not $script:TunnelProcess -or $script:TunnelProcess.HasExited) {
            Write-Warn "Tunnel provider '$($script:CurrentProvider)' process died"
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

        # 3. If registration is not confirmed, recover it before heartbeat
        if (-not $script:IsRegistered) {
            if (Ensure-TunnelRegistered -Url $script:CurrentUrl -Attempts 1) {
                Write-Log "$ts tunnel: ok | lmstudio: ok | render: registered"
                continue
            }

            $script:NoResponseCount++
            Write-Warn "$ts tunnel: ok | lmstudio: ok | render: registration pending ($($script:NoResponseCount)/$NO_RESPONSE_THRESHOLD)"

            if ($script:NoResponseCount -ge $NO_RESPONSE_THRESHOLD -and -not (Test-TunnelUrlReady -Url $script:CurrentUrl)) {
                Write-Err 'Current tunnel URL is no longer publicly reachable - restarting with new URL'
                if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                    $script:TunnelProcess.Kill()
                    $script:TunnelProcess.WaitForExit(3000) | Out-Null
                }
                $script:TunnelProcess = $null
                return 3
            }

            continue
        }

        # 4. Heartbeat + recovery
        $heartbeatStatus = Send-Heartbeat

        switch ($heartbeatStatus) {
            'ok' {
                $script:UnhealthyCount = 0
                $script:NoResponseCount = 0
                Write-Dim "$ts tunnel: ok | lmstudio: ok | render: ok"
            }

            'conflict' {
                $script:IsRegistered = $false
                $script:UnhealthyCount++
                Write-Warn "$ts tunnel: ok | lmstudio: ok | render: re-register required ($($script:UnhealthyCount)/$UNHEALTHY_THRESHOLD)"

                if (Ensure-TunnelRegistered -Url $script:CurrentUrl -Attempts 1) {
                    Write-Log 'Tunnel re-registered successfully'
                    continue
                }

                if ($script:UnhealthyCount -ge $UNHEALTHY_THRESHOLD) {
                    Write-Err "Tunnel registration could not be recovered for $UNHEALTHY_THRESHOLD checks - restarting with new URL"
                    if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                        $script:TunnelProcess.Kill()
                        $script:TunnelProcess.WaitForExit(3000) | Out-Null
                    }
                    $script:TunnelProcess = $null
                    return 3
                }
            }

            'unhealthy' {
                $script:UnhealthyCount++
                Write-Warn "$ts tunnel: ok | lmstudio: ok | render: UNHEALTHY ($($script:UnhealthyCount)/$UNHEALTHY_THRESHOLD)"

                if ($script:UnhealthyCount -ge $UNHEALTHY_THRESHOLD) {
                    if (Ensure-TunnelRegistered -Url $script:CurrentUrl -Attempts 1) {
                        Write-Log 'Tunnel registration refreshed successfully'
                        continue
                    }

                    Write-Err "Tunnel URL unreachable from Render for $UNHEALTHY_THRESHOLD checks - restarting with new URL"
                    if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                        $script:TunnelProcess.Kill()
                        $script:TunnelProcess.WaitForExit(3000) | Out-Null
                    }
                    $script:TunnelProcess = $null
                    return 3
                }
            }

            'no_response' {
                $script:NoResponseCount++
                Write-Dim "$ts tunnel: ok | lmstudio: ok | render: no response ($($script:NoResponseCount)/$NO_RESPONSE_THRESHOLD)"

                if ($script:NoResponseCount -ge $NO_RESPONSE_THRESHOLD) {
                    $script:IsRegistered = $false
                    if (Ensure-TunnelRegistered -Url $script:CurrentUrl -Attempts 1) {
                        Write-Log 'Render reachable again - tunnel registration refreshed'
                        continue
                    }

                    if (-not (Test-TunnelUrlReady -Url $script:CurrentUrl)) {
                        Write-Err 'Render is unreachable and current tunnel URL is no longer public - restarting with new URL'
                        if ($script:TunnelProcess -and -not $script:TunnelProcess.HasExited) {
                            $script:TunnelProcess.Kill()
                            $script:TunnelProcess.WaitForExit(3000) | Out-Null
                        }
                        $script:TunnelProcess = $null
                        return 3
                    }

                    $script:NoResponseCount = 0
                    Write-Warn 'Render did not respond, but tunnel is still public. Will retry registration later.'
                }
            }

            'auth_error' {
                Write-Err "$ts tunnel: ok | lmstudio: ok | render: tunnel auth failed"
                return 4
            }

            'server_error' {
                Write-Err "$ts tunnel: ok | lmstudio: ok | render: server misconfigured"
                return 4
            }

            default {
                Write-Warn "$ts tunnel: ok | lmstudio: ok | render: unexpected status '$heartbeatStatus'"
            }
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

            if (Start-TunnelTransport) {
                $exitReason = Watch-Tunnel

                switch ($exitReason) {
                    2 {
                        Write-Log 'LM Studio offline - waiting for it to come back...'
                        continue
                    }
                    3 {
                        Write-Warn 'Tunnel URL expired - getting new one...'
                        Start-Sleep -Seconds $script:NextRestartDelay
                        continue
                    }
                    4 {
                        Write-Err 'Tunnel authentication/configuration error - retrying after 60s...'
                        Start-Sleep -Seconds 60
                        continue
                    }
                    default {
                        Write-Warn "Tunnel crashed - restarting in $($script:NextRestartDelay)s..."
                        Start-Sleep -Seconds $script:NextRestartDelay
                    }
                }
            } else {
                Write-Warn "Failed to start tunnel - retrying in $($script:NextRestartDelay)s..."
                Start-Sleep -Seconds $script:NextRestartDelay
            }
        }
    } finally {
        Stop-Tunnel
    }
}

Start-TunnelSupervisor
