@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "BRIDGE_PS1=%SCRIPT_DIR%start-windows-logon.ps1"

if not exist "%BRIDGE_PS1%" (
  echo [amina-bridge] start-windows-logon.ps1 not found: "%BRIDGE_PS1%"
  exit /b 1
)

echo [amina-bridge] Starting Amina Bridge...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BRIDGE_PS1%"
exit /b %ERRORLEVEL%
