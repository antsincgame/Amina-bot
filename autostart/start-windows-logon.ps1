#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$aminaDir = Split-Path -Parent $scriptDir
$tunnelPs1 = Join-Path $aminaDir 'tunnel.ps1'
$lmsCli = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
$userTunnelToken = [Environment]::GetEnvironmentVariable('LMSTUDIO_TUNNEL_TOKEN', 'User')

if (-not $env:LMSTUDIO_TUNNEL_TOKEN -and $userTunnelToken) {
    $env:LMSTUDIO_TUNNEL_TOKEN = $userTunnelToken
}

function Test-LMStudioServer {
    foreach ($path in @('/api/v1/models', '/v1/models')) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:1234$path" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                return $true
            }
        } catch {
            continue
        }
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
        return
    }

    if (-not (Test-Path $lmsCli)) {
        return
    }

    Start-Process -FilePath $lmsCli -ArgumentList 'server start' -WindowStyle Hidden
}

function Start-TunnelSupervisor {
    if (Test-TunnelSupervisorRunning) {
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
}

Start-LMStudioHeadless
Start-Sleep -Seconds 5
Start-TunnelSupervisor
