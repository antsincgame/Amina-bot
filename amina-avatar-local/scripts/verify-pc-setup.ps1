#Requires -Version 5.1
<#
.SYNOPSIS
  Checks Docker, Compose, optional GPU container probe, .env, face.png (local PC build).
#>
param(
    [switch]$SkipGpuProbe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$assets = Join-Path $root 'assets'
$face = Join-Path $assets 'face.png'
$envFile = Join-Path $root '.env'

$script:checksOk = $true

function Step-Ok($msg) { Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Step-Warn($msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Step-Fail($msg) {
    Write-Host "[FAIL] $msg" -ForegroundColor Red
    $script:checksOk = $false
}

Write-Host "=== Amina Avatar Local: PC checks ===" -ForegroundColor Cyan
Write-Host "Root: $root`n"

try {
    $dv = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $dv) { Step-Ok "Docker server: $dv" }
    else { Step-Fail "Docker not responding. Start Docker Desktop." }
} catch {
    Step-Fail "docker not in PATH."
}

try {
    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Step-Ok "Docker Compose v2 OK" }
    else { Step-Fail "docker compose unavailable" }
} catch {
    Step-Fail "docker compose unavailable"
}

$composeGpu = Join-Path $root 'docker-compose.gpu.yml'
if (Test-Path $composeGpu) { Step-Ok "docker-compose.gpu.yml present" }
else { Step-Warn "docker-compose.gpu.yml missing" }

$nsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nsmi) {
    try {
        $gpu = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1
        if ($gpu) { Step-Ok "nvidia-smi: $gpu" }
        else { Step-Warn "nvidia-smi returned no GPU name" }
    } catch {
        Step-Warn "nvidia-smi error"
    }
} else {
    Step-Warn "nvidia-smi not in PATH (driver may still work inside Docker)."
}

if (-not $SkipGpuProbe) {
    Write-Host "`nGPU probe: docker run --gpus all nvidia/cuda..." -ForegroundColor DarkGray
    $probe = docker run --rm --gpus all nvidia/cuda:12.2.0-base-ubuntu22.04 nvidia-smi -L 2>&1
    if ($LASTEXITCODE -eq 0) {
        Step-Ok "Container sees GPU:"
        Write-Host $probe
    } else {
        Step-Warn "docker run --gpus all failed. Enable GPU in Docker / WSL2 or NVIDIA Container Toolkit."
        Write-Host $probe
    }
}

if (Test-Path $envFile) {
    $hasSecret = $false
    foreach ($line in Get-Content $envFile) {
        $t = $line.Trim()
        if ($t -match '^AMINA_AVATAR_SECRET=(.+)$' -and $matches[1].Trim().Length -gt 8) { $hasSecret = $true }
    }
    if ($hasSecret) { Step-Ok ".env OK, AMINA_AVATAR_SECRET set" }
    else { Step-Warn ".env present but secret empty/short - run scripts\\init-local-env.ps1" }
} else {
    Step-Warn "No .env - run scripts\\init-local-env.ps1"
}

if (Test-Path $face) {
    $len = (Get-Item $face).Length
    if ($len -gt 500) { Step-Ok "assets\\face.png present ($len bytes)" }
    else { Step-Warn "assets\\face.png too small - use a real 512x512 portrait for Wav2Lip" }
} else {
    Step-Warn "No assets\\face.png - run scripts\\create-minimal-face-placeholder.ps1 or add your photo"
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
if ($script:checksOk) {
    Write-Host "Docker checks OK. Next: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build" -ForegroundColor Green
} else {
    Write-Host "Fix Docker issues first. See BUILD-PC.md." -ForegroundColor Yellow
}

exit $(if ($script:checksOk) { 0 } else { 1 })
