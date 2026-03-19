@echo off
chcp 65001 >nul
title Amina - start
cd /d "%~dp0"

echo.
echo  Starting Amina on your PC...
echo  First run may take several minutes (Docker download).
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-everything.ps1"
set ERR=%ERRORLEVEL%

echo.
if %ERR% equ 2 (
  echo  Python was just installed. Run START_AMINA.bat again.
  pause
  exit /b 0
)
if %ERR% neq 0 (
  echo  Error code: %ERR%
  echo  If Docker/Python are missing: double-click INSTALL_RUNTIME.bat in this folder first.
  pause
  exit /b %ERR%
)

echo  You can close this window. If you used Docker, leave Docker Desktop running.
echo.
pause
