#Requires -Version 5.1
<#
.SYNOPSIS
  Проверка: слушается ли порт, есть ли Docker и контейнер avatar-local.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 8765
$envp = Join-Path $root '.env'
if (Test-Path $envp) {
    foreach ($line in Get-Content $envp) {
        $t = $line.Trim()
        if ($t.StartsWith('#')) { continue }
        $parts = $t -split '=', 2
        if ($parts.Length -eq 2 -and $parts[0].Trim() -eq 'AVATAR_PORT') {
            $p = 0
            if ([int]::TryParse($parts[1].Trim(), [ref]$p)) { $port = $p }
            break
        }
    }
}

Write-Host "=== Diagnose port $port ===" -ForegroundColor Cyan

$tnc = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue
if ($tnc.TcpTestSucceeded) {
    Write-Host "[ OK ] Port $port is open (something is listening)" -ForegroundColor Green
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
        Write-Host "[ OK ] /health HTTP $($r.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Port open but /health failed: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "[FAIL] Nothing listens on 127.0.0.1:$port" -ForegroundColor Red
    Write-Host "  1) Start Docker Desktop, then in amina-avatar-local run:" -ForegroundColor DarkGray
    Write-Host "     docker compose up -d --build" -ForegroundColor DarkGray
    Write-Host "  2) Or without Docker:" -ForegroundColor DarkGray
    Write-Host "     .\scripts\start-panel-local.ps1" -ForegroundColor DarkGray
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    Write-Host "`ndocker compose ps (project dir):" -ForegroundColor Cyan
    Push-Location $root
    docker compose ps 2>&1
    Pop-Location
} else {
    Write-Host "`n[WARN] docker not in PATH — install Docker Desktop or use scripts\start-panel-local.ps1" -ForegroundColor Yellow
}
