@echo off
chcp 65001 >nul 2>&1
title Amina LM Studio Tunnel
color 0B

echo.
echo  ============================================
echo    Amina LM Studio Tunnel Supervisor
echo  ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  [ERROR] Node.js not found!
    echo.
    echo  Install Node.js from: https://nodejs.org
    echo  Or run: winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo  Node.js: %%v

:: Run tunnel
node "%~dp0tunnel.js"

:: If it exits, pause so user sees the error
echo.
echo  Tunnel stopped. Press any key to close...
pause >nul
