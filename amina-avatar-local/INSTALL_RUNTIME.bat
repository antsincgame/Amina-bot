@echo off
chcp 65001 >nul
title Amina - install Python and Docker
cd /d "%~dp0"

echo.
echo  This will try to install via winget (Windows Package Manager).
echo  You need Internet. Docker may ask for admin / reboot.
echo.

where winget >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] winget not found.
  echo  Open "Microsoft Store" and update "App Installer", then run this file again.
  echo  Or install manually:
  echo    Python: https://www.python.org/downloads/
  echo    Docker: https://docs.docker.com/desktop/setup/install/windows-install/
  pause
  exit /b 1
)

echo  [1/2] Python 3.12 ...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
if errorlevel 1 echo  Python install had a warning - you can install from python.org

echo.
echo  [2/2] Docker Desktop (large, optional for GPU mode) ...
winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
if errorlevel 1 echo  Docker install had a warning - download from docker.com

echo.
echo  Done. CLOSE this window, RESTART PC if Docker asked for it,
echo  then run START_AMINA.bat again.
echo.
pause
