#Requires -Version 5.1
# SCRIPT_VERSION 2025-03-21-ascii
# One double-click startup: Docker (GPU then CPU) or Python fallback. Opens browser + SECRET_FOR_TELEGRAM.txt

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function New-RandomSecret {
    return -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
}

function Get-AvatarPort {
    $port = 8765
    $envp = Join-Path $root '.env'
    if (-not (Test-Path $envp)) { return $port }
    foreach ($line in Get-Content $envp -Encoding UTF8) {
        $t = $line.Trim()
        if ($t.StartsWith('#')) { continue }
        $parts = $t -split '=', 2
        if ($parts.Length -eq 2 -and $parts[0].Trim() -eq 'AVATAR_PORT') {
            $p = 0
            if ([int]::TryParse($parts[1].Trim(), [ref]$p)) { return $p }
        }
    }
    return $port
}

function Ensure-EnvFile {
    $envp = Join-Path $root '.env'
    $ex = Join-Path $root 'env.example'
    if (-not (Test-Path $envp)) {
        if (-not (Test-Path $ex)) { throw 'Missing env.example' }
        Copy-Item $ex $envp
    }
    $lines = @(Get-Content $envp -Encoding UTF8)
    $out = New-Object System.Collections.Generic.List[string]
    $secretVal = $null
    $seen = $false
    foreach ($line in $lines) {
        if ($line -match '^\s*AMINA_AVATAR_SECRET\s*=\s*(.*)$') {
            $seen = $true
            $v = $matches[1].Trim()
            # ASCII-only check: no Cyrillic / sample text in .env (avoids script encoding issues on Windows)
            $isAsciiToken = $v -match '^[A-Za-z0-9_-]+$'
            $isWeak = ($v.Length -lt 24) -or (-not $isAsciiToken) -or ($v -eq 'change_me')
            if (-not $isWeak) {
                $secretVal = $v
                $out.Add("AMINA_AVATAR_SECRET=$v") | Out-Null
            } else {
                $secretVal = New-RandomSecret
                $out.Add("AMINA_AVATAR_SECRET=$secretVal") | Out-Null
            }
        } else {
            $out.Add($line) | Out-Null
        }
    }
    if (-not $seen) {
        $secretVal = New-RandomSecret
        $out.Add("AMINA_AVATAR_SECRET=$secretVal") | Out-Null
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($envp, $out.ToArray(), $utf8)

    $note = @"
========================================
  TELEGRAM Mini App -> Local PC -> Secret
========================================

$secretVal

(Close this file after copying.)
========================================
"@
    [System.IO.File]::WriteAllText((Join-Path $root 'SECRET_FOR_TELEGRAM.txt'), $note, $utf8)
}

function Ensure-FacePlaceholder {
    $face = Join-Path $root 'assets\face.png'
    $need = (-not (Test-Path $face)) -or ((Get-Item $face -ErrorAction SilentlyContinue).Length -lt 400)
    if (-not $need) { return }
    $ps1 = Join-Path $root 'scripts\create-minimal-face-placeholder.ps1'
    if (Test-Path $ps1) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ps1
    }
}

function Refresh-PathFromMachine {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    if ($m) { $parts += $m }
    if ($u) { $parts += $u }
    if ($parts.Count -gt 0) { $Env:Path = ($parts -join ';') }
}

function Test-PythonAvailable {
    Refresh-PathFromMachine
    if (Get-Command py -ErrorAction SilentlyContinue) { return $true }
    if (Get-Command python -ErrorAction SilentlyContinue) { return $true }
    $candidates = @(
        "$Env:LocalAppData\Programs\Python\Python312\python.exe",
        "$Env:LocalAppData\Programs\Python\Python313\python.exe",
        "$Env:LocalAppData\Programs\Python\Python311\python.exe",
        "${Env:ProgramFiles}\Python312\python.exe"
    )
    foreach ($c in $candidates) {
        if (-not (Test-Path $c)) { continue }
        $dir = Split-Path $c
        $Env:Path = "$dir;$dir\Scripts;$Env:Path"
        return $true
    }
    return $false
}

function Try-WingetInstallPython {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host 'winget missing - use INSTALL_RUNTIME.bat or https://www.python.org/downloads/' -ForegroundColor Yellow
        return $false
    }
    Write-Host 'Installing Python 3.12 via winget (Internet, one-time)...' -ForegroundColor Cyan
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    Start-Sleep -Seconds 3
    Refresh-PathFromMachine
    return (Test-PythonAvailable)
}

function Test-DockerCli {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    $alt = "$Env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
    if (Test-Path $alt) {
        $Env:Path = "$(Split-Path $alt);$Env:Path"
        return $true
    }
    return $false
}

function Wait-DockerDaemon {
    if (-not (Test-DockerCli)) { return $false }
    $dd = "$Env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dd) {
        $proc = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'Docker Desktop' })
        if ($proc.Count -lt 1) {
            Start-Process $dd
            Write-Host 'Docker Desktop is starting... Wait up to 1-2 minutes on first run.' -ForegroundColor Yellow
            Start-Sleep 25
        }
    }
    for ($i = 0; $i -lt 50; $i++) {
        docker info 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep 2
    }
    return $false
}

function Invoke-DockerStacks {
    Push-Location $root
    try {
        $gpuYml = Join-Path $root 'docker-compose.gpu.yml'
        if (Test-Path $gpuYml) {
            Write-Host 'Trying GPU mode (Wav2Lip)...' -ForegroundColor Cyan
            docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
            if ($LASTEXITCODE -eq 0) { return $true }
            Write-Host 'GPU mode failed (normal if no Docker GPU). Trying simple CPU mode...' -ForegroundColor Yellow
        }
        docker compose -f docker-compose.yml up -d --build
        return ($LASTEXITCODE -eq 0)
    } finally {
        Pop-Location
    }
}

function Start-PythonServer {
    param([int]$Port)
    $venvPy = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPy)) {
        $pyCmd = $null
        if (Get-Command py -ErrorAction SilentlyContinue) { $pyCmd = 'py' }
        elseif (Get-Command python -ErrorAction SilentlyContinue) { $pyCmd = 'python' }
        else {
            Write-Host 'ERROR: Install Python 3 from https://www.python.org/downloads/ (check Add to PATH).' -ForegroundColor Red
            return $false
        }
        if ($pyCmd -eq 'py') {
            & py -3 -m venv (Join-Path $root '.venv')
        } else {
            & python -m venv (Join-Path $root '.venv')
        }
        if ($LASTEXITCODE -ne 0) { return $false }
        & (Join-Path $root '.venv\Scripts\pip.exe') install -r (Join-Path $root 'requirements.txt') --quiet
        if ($LASTEXITCODE -ne 0) { return $false }
    }
    $url = "http://127.0.0.1:$Port/"
    $cmd = "`$Env:AVATAR_ENGINE='ffmpeg'; Set-Location '$root'; `$Host.UI.RawUI.WindowTitle = 'Amina - do not close'; & '$venvPy' -m uvicorn app.main:app --host 127.0.0.1 --port $Port"
    Start-Process powershell -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd)
    Start-Sleep 4
    Start-Process $url
    Write-Host ''
    Write-Host 'Simple mode started. Keep the extra black window open.' -ForegroundColor Green
    Write-Host "Panel: $url" -ForegroundColor Green
    return $true
}

# --- run ---
Write-Host ''
Write-Host '  Amina - local server' -ForegroundColor Cyan
Write-Host '  Please wait...' -ForegroundColor DarkGray
Write-Host ''

try {
    Ensure-EnvFile
    Ensure-FacePlaceholder
} catch {
    Write-Host "Setup error: $_" -ForegroundColor Red
    exit 1
}

$port = Get-AvatarPort
$url = "http://127.0.0.1:$port/"

if (Wait-DockerDaemon) {
    if (Invoke-DockerStacks) {
        Start-Sleep 2
        Start-Process $url
        Start-Process -FilePath 'notepad.exe' -ArgumentList (Join-Path $root 'SECRET_FOR_TELEGRAM.txt')
        Write-Host ''
        Write-Host 'Done - browser opened.' -ForegroundColor Green
        Write-Host "If page fails, wait 30 sec and refresh: $url" -ForegroundColor DarkYellow
        Write-Host 'Secret opened in Notepad - paste into Telegram Mini App (Local PC).' -ForegroundColor DarkYellow
        Write-Host 'Docker keeps running; to stop: Docker Desktop - Stop, or: docker compose down' -ForegroundColor DarkGray
        exit 0
    }
    Write-Host 'Docker compose failed.' -ForegroundColor Yellow
} else {
    Write-Host 'Docker not ready or not installed.' -ForegroundColor Yellow
}

Write-Host ''

if (-not (Test-PythonAvailable)) {
    Write-Host 'Python is not installed (or not on PATH).' -ForegroundColor Yellow
    if (Try-WingetInstallPython) {
        Write-Host ''
        Write-Host 'Python installed. Close this window and run START_AMINA.bat again.' -ForegroundColor Green
        exit 2
    }
    Write-Host ''
    Write-Host 'Double-click INSTALL_RUNTIME.bat in this folder, then START_AMINA.bat again.' -ForegroundColor Red
    exit 1
}

if (-not (Start-PythonServer -Port $port)) {
    Write-Host ''
    Write-Host 'Server did not start. Try INSTALL_RUNTIME.bat or check antivirus for this folder.' -ForegroundColor Red
    exit 1
}
Start-Process -FilePath 'notepad.exe' -ArgumentList (Join-Path $root 'SECRET_FOR_TELEGRAM.txt')
Write-Host 'Secret opened in Notepad for Telegram.' -ForegroundColor DarkYellow
exit 0
