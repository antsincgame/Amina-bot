#Requires -Version 5.1
<#
.SYNOPSIS
  Creates assets/face.png as a simple ellipse placeholder (replace with a real portrait for Wav2Lip).
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'assets\face.png'

if (Test-Path $out) {
    Write-Host "face.png already exists; not overwriting." -ForegroundColor Yellow
    exit 0
}

Add-Type -AssemblyName System.Drawing
$size = 512
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(26, 21, 32))
$skin = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 188, 172))
$g.FillEllipse($skin, 96, 72, 320, 400)
$eye = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(40, 35, 45))
$g.FillEllipse($eye, 160, 200, 48, 36)
$g.FillEllipse($eye, 304, 200, 48, 36)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "Wrote $out (placeholder). For Wav2Lip quality, replace with a real front face photo." -ForegroundColor Green
