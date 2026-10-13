@echo off
setlocal
title Vanaras Desktop Launcher
cd /d "%~dp0"

:: 1. Ensure Node.js backend server is running on port 3000
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; " ^
  "if (-not $listening) { Start-Process -FilePath 'node' -ArgumentList 'ui\server.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden; Start-Sleep -Milliseconds 900 }"

:: 2. Launch native chromeless Windows App Window via Edge WebView / Chrome App Mode
where msedge >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" msedge --app="http://localhost:3000" --window-size=1220,800
    exit /b 0
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3000" --window-size=1220,800
    exit /b 0
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app="http://localhost:3000" --window-size=1220,800
    exit /b 0
)

start "" "http://localhost:3000"
