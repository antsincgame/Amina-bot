#Requires -Version 5.1
<#
.SYNOPSIS
  Запуск веб-панели БЕЗ Docker: Python + uvicorn на 127.0.0.1.
  Используйте, если http://127.0.0.1:8765/ не открывается при работе через Docker.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Host 'No .env — run scripts\init-local-env.ps1 or copy env.example to .env' -ForegroundColor Yellow
    exit 1
}

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

$venvPy = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    Write-Host 'Creating .venv...' -ForegroundColor Cyan
    & python -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed. Install Python 3.11+ from python.org' }
    & (Join-Path $root '.venv\Scripts\pip.exe') install -r (Join-Path $root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
}

$url = "http://127.0.0.1:$port/"
Write-Host "Starting panel at $url (Ctrl+C to stop)" -ForegroundColor Green
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process $using:url
} | Out-Null

& $venvPy -m uvicorn app.main:app --host 127.0.0.1 --port $port
