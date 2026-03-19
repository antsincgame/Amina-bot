@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "amina-avatar-local\START_AMINA.bat" (
  cd /d "%~dp0amina-avatar-local"
  call START_AMINA.bat
  exit /b %ERRORLEVEL%
)

if exist "START_AMINA.bat" (
  call START_AMINA.bat
  exit /b %ERRORLEVEL%
)

echo Folder amina-avatar-local not found next to this file.
pause
exit /b 1
