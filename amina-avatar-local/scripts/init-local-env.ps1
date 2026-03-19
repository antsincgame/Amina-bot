#Requires -Version 5.1
<#
.SYNOPSIS
  Creates amina-avatar-local/.env with random AMINA_AVATAR_SECRET (local PC build checklist).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$envPath = Join-Path $root '.env'
$example = Join-Path $root 'env.example'

if (-not (Test-Path $example)) {
    throw 'env.example not found'
}

if (Test-Path $envPath) {
    Write-Host '.env already exists; not overwriting. Delete it to re-init.' -ForegroundColor Yellow
    exit 0
}

$secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$lines = Get-Content $example -Encoding UTF8
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
    if ($line -match '^\s*AMINA_AVATAR_SECRET=') {
        $out.Add("AMINA_AVATAR_SECRET=$secret") | Out-Null
    } else {
        $out.Add($line) | Out-Null
    }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllLines($envPath, $out.ToArray(), $utf8NoBom)

Write-Host "Created $envPath" -ForegroundColor Green
Write-Host 'Paste this secret into Mini App - Local PC settings:' -ForegroundColor Cyan
Write-Host $secret
