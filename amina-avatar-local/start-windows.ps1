#Requires -Version 5.1
<#
.SYNOPSIS
  Поднимает amina-avatar-local через Docker Compose (Windows).

.PARAMETER Gpu
  Сборка из Dockerfile.gpu (Wav2Lip + CUDA). Нужен Docker Desktop с поддержкой GPU.

.PARAMETER Tunnel
  После старта контейнера запускает cloudflared quick tunnel на порт сервиса (блокирует консоль).
#>
param(
    [switch]$Gpu,
    [switch]$Tunnel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path "$root\.env")) {
    Copy-Item "$root\env.example" "$root\.env"
    Write-Host "Создан .env — задайте AMINA_AVATAR_SECRET и перезапустите скрипт." -ForegroundColor Yellow
    exit 1
}

$port = 8765
foreach ($line in Get-Content "$root\.env" -ErrorAction SilentlyContinue) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $parts = $t -split '=', 2
    if ($parts.Length -eq 2 -and $parts[0].Trim() -eq 'AVATAR_PORT') {
        $parsed = 0
        if ([int]::TryParse($parts[1].Trim(), [ref]$parsed)) { $port = $parsed }
        break
    }
}

$composeCmd = @('compose', '-f', 'docker-compose.yml')
if ($Gpu) {
    $composeCmd += @('-f', 'docker-compose.gpu.yml')
    Write-Host "Режим GPU (Wav2Lip). Убедитесь, что Docker видит NVIDIA." -ForegroundColor Cyan
}

$composeCmd += @('up', '-d', '--build')
& docker @composeCmd
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$panel = "http://127.0.0.1:$port/"
Write-Host "Веб-панель: $panel" -ForegroundColor Green
Write-Host "Health: http://127.0.0.1:$port/health" -ForegroundColor DarkGray
Write-Host "Подставьте https URL туннеля и секрет в мини-апп (Локальный PC)." -ForegroundColor DarkGray

Start-Process $panel

if ($Tunnel) {
    $cf = $env:CLOUDFLARED_BIN
    if ([string]::IsNullOrWhiteSpace($cf)) { $cf = 'cloudflared' }
    Write-Host "Запуск туннеля: $cf tunnel --url http://127.0.0.1:$port" -ForegroundColor Yellow
    & $cf tunnel --url "http://127.0.0.1:$port"
}
