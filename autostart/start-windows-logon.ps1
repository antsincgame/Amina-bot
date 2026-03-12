#Requires -Version 5.1
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$aminaDir = Split-Path -Parent $scriptDir
$tunnelPs1 = Join-Path $aminaDir 'tunnel.ps1'
$envFile = Join-Path $aminaDir '.env'

Import-LocalEnvFile `
    -EnvPath $envFile `
    -Keys @('LMSTUDIO_PORT', 'LMSTUDIO_TUNNEL_TOKEN', 'BOT_API_URL', 'CLOUDFLARED_BIN', 'CLOUDFLARED_TUNNEL_ARGS', 'CLOUDFLARED_PUBLIC_URL', 'TUNNEL_PROVIDER', 'LOCALTUNNEL_ARGS')

$LMSTUDIO_PORT = if ($env:LMSTUDIO_PORT) { $env:LMSTUDIO_PORT } else { '1234' }
$lmsCli = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$bridgeLog = Join-Path $env:TEMP 'amina-bridge.log'
$userTunnelToken = [Environment]::GetEnvironmentVariable('LMSTUDIO_TUNNEL_TOKEN', 'User')

if (-not $env:LMSTUDIO_TUNNEL_TOKEN -and $userTunnelToken) {
    $env:LMSTUDIO_TUNNEL_TOKEN = $userTunnelToken
}

function Write-BridgeLog {
    param([string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $bridgeLog -Value "[$timestamp] $Message" -Encoding UTF8
}

function Find-LMStudioGuiExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'LM Studio\LM Studio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\LM Studio\LM Studio.exe'),
        (Join-Path ${env:ProgramFiles} 'LM Studio\LM Studio.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'LM Studio\LM Studio.exe')
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) {
            return $path
        }
    }

    return $null
}

function Test-LMStudioServer {
    foreach ($path in @('/api/v1/models', '/v1/models')) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:${LMSTUDIO_PORT}$path" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $true
            }
        } catch {
            continue
        }
    }

    return $false
}

function Wait-ForLMStudioServer {
    param([int]$TimeoutSec = 60)

    for ($i = 0; $i -lt $TimeoutSec; $i++) {
        if (Test-LMStudioServer) {
            return $true
        }

        Start-Sleep -Seconds 1
    }

    return $false
}

function Test-TunnelSupervisorRunning {
    $needle = $tunnelPs1.ToLowerInvariant()
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'"

    foreach ($process in $processes) {
        if ($process.CommandLine -and $process.CommandLine.ToLowerInvariant().Contains($needle)) {
            return $true
        }
    }

    return $false
}

function Start-LMStudioHeadless {
    if (Test-LMStudioServer) {
        Write-BridgeLog "LM Studio API already responds on port $LMSTUDIO_PORT"
        return $true
    }

    if (Test-Path $lmsCli) {
        Write-BridgeLog "Starting LM Studio daemon via $lmsCli"
        try {
            Start-Process -FilePath $lmsCli -ArgumentList 'daemon up' -WindowStyle Hidden | Out-Null
        } catch {
            Write-BridgeLog "LM Studio daemon start failed: $($_.Exception.Message)"
        }

        Start-Sleep -Seconds 3

        Write-BridgeLog "Starting LM Studio server on port $LMSTUDIO_PORT"
        try {
            Start-Process -FilePath $lmsCli -ArgumentList "server start --port $LMSTUDIO_PORT" -WindowStyle Hidden | Out-Null
        } catch {
            Write-BridgeLog "LM Studio server start failed: $($_.Exception.Message)"
        }

        if (Wait-ForLMStudioServer -TimeoutSec 60) {
            Write-BridgeLog 'LM Studio headless server is ready'
            return $true
        }

        Write-BridgeLog 'LM Studio headless server did not become ready in time'
    }

    $lmStudioGui = Find-LMStudioGuiExe
    if ($lmStudioGui) {
        Write-BridgeLog "Starting LM Studio GUI: $lmStudioGui"
        Start-Process -FilePath $lmStudioGui -WindowStyle Minimized | Out-Null
        if (Wait-ForLMStudioServer -TimeoutSec 90) {
            Write-BridgeLog 'LM Studio GUI is running and API is ready'
            return $true
        }

        Write-BridgeLog 'LM Studio GUI started, but local API is still not ready'
    }

    Write-BridgeLog 'LM Studio API is still offline; tunnel supervisor will keep waiting'
    return $false
}

function Start-TunnelSupervisor {
    if (Test-TunnelSupervisorRunning) {
        Write-BridgeLog 'Tunnel supervisor is already running'
        return
    }

    if (-not (Test-Path $tunnelPs1)) {
        throw "tunnel.ps1 not found: $tunnelPs1"
    }

    Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tunnelPs1`"" `
        -WorkingDirectory $aminaDir `
        -WindowStyle Hidden

    Write-BridgeLog 'Tunnel supervisor started'
}

Write-BridgeLog 'Amina Bridge bootstrap started'
[void](Start-LMStudioHeadless)
Start-Sleep -Seconds 5
Start-TunnelSupervisor
Write-BridgeLog 'Amina Bridge bootstrap completed'
