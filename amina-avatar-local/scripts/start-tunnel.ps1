#Requires -Version 5.1
<#
.SYNOPSIS
  Запускает cloudflared quick tunnel на порт сервиса из .env (план, шаг 4).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envPath = Join-Path $root '.env'
$port = 8765

if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
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

$cf = $env:CLOUDFLARED_BIN
if ([string]::IsNullOrWhiteSpace($cf)) { $cf = 'cloudflared' }

Write-Host "Туннель: $cf tunnel --url http://127.0.0.1:$port" -ForegroundColor Cyan
Write-Host "URL вставьте в мини-апп + тот же секрет, что AMINA_AVATAR_SECRET." -ForegroundColor DarkGray

& $cf tunnel --url "http://127.0.0.1:$port"
