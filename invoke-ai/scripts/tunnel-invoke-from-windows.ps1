#Requires -Version 5.1
<#
.SYNOPSIS
  SSH-туннель с Windows на GPU-сервер: InvokeAI как будто на localhost.

.DESCRIPTION
  Пробрасывает порт InvokeAI (по умолчанию 9090) с удалённого сервера на 127.0.0.1 локально.
  На сервере Invoke должен слушать тот же порт (см. INVOKEAI_PORT в invoke-ai/.env).

.EXAMPLE
  .\tunnel-invoke-from-windows.ps1 -SshUser deploy -SshHost 203.0.113.50

.EXAMPLE
  .\tunnel-invoke-from-windows.ps1 -SshUser deploy -SshHost gpu.example.com -RemotePort 9090 -LocalPort 19090
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SshUser,

    [Parameter(Mandatory = $true)]
    [string] $SshHost,

    [int] $LocalPort = 9090,

    [int] $RemotePort = 9090,

    [string] $IdentityFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$bind = "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}"
$target = "${SshUser}@${SshHost}"

Write-Host "Туннель: localhost:$LocalPort -> ${SshHost}:127.0.0.1:$RemotePort" -ForegroundColor Cyan
Write-Host "Откройте в браузере: http://127.0.0.1:$LocalPort/" -ForegroundColor Green
Write-Host "Остановка: Ctrl+C" -ForegroundColor Yellow
Write-Host ""

$sshArgs = @(
    '-N', '-T',
    '-L', $bind,
    $target
)

if ($IdentityFile -ne '') {
    $sshArgs = @('-i', $IdentityFile) + $sshArgs
}

& ssh @sshArgs
