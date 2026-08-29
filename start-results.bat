@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found in PATH.
    echo Install Node.js 18 or newer, then run this file again.
    pause
    exit /b 1
)

echo Starting the results publisher...
node index.js

if errorlevel 1 (
    echo.
    echo The results publisher stopped with an error.
    pause
)
