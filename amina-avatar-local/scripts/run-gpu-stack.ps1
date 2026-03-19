#Requires -Version 5.1
<#
.SYNOPSIS
  Сборка и запуск GPU-стека (docker-compose.yml + docker-compose.gpu.yml), затем GET /health.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Error "Нет .env. Сначала: scripts\init-local-env.ps1"
}

docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$port = 8765
foreach ($line in Get-Content (Join-Path $root '.env')) {
    $t = $line.Trim()
    if ($t.StartsWith('#')) { continue }
    $parts = $t -split '=', 2
    if ($parts.Length -eq 2 -and $parts[0].Trim() -eq 'AVATAR_PORT') {
        $p = 0
        if ([int]::TryParse($parts[1].Trim(), [ref]$p)) { $port = $p }
        break
    }
}

Start-Sleep -Seconds 2
try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 15
    Write-Host "GET /health:" -ForegroundColor Green
    $r | ConvertTo-Json -Compress
    Start-Process "http://127.0.0.1:$port/"
} catch {
    Write-Warning "Сервис ещё не отвечает или порт другой: $_"
}
