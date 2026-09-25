@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Qwen-Image-2.1 Studio

rem The port can be overridden from the environment: set PORT=xxxx, then run.
if not defined PORT set "PORT=5178"
set "URL=http://127.0.0.1:%PORT%"

echo ==========================================================
echo    Qwen-Image-2.1 Studio  ^|  Server Launcher
echo ==========================================================
echo.

rem ---- 1. Node.js present? ---------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    echo.
    echo   This is a Node.js project, not a Python one. Running it with
    echo   "python server.js" only produces a SyntaxError on the first line.
    echo.
    echo   Install Node.js 18 or newer, then reopen this window:
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
echo [ OK ] Node.js !NODEV! detected

rem ---- 2. Entry file present? -------------------------------
if not exist "server.js" (
    echo [FAIL] server.js was not found next to this script.
    echo        Keep start.bat in the project root folder.
    echo.
    pause
    exit /b 1
)
echo [ OK ] server.js found

rem ---- 3. Is the port already taken? ------------------------
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" 2^>nul') do set "PID=%%p"

if defined PID (
    echo [WARN] Port %PORT% is already in use by PID !PID!.
    echo        The studio is most likely already running.
    echo.
    choice /c YN /n /m "Open %URL% in the browser anyway? [Y/N] "
    if errorlevel 2 goto :halt
    start "" "%URL%"
    goto :halt
)
echo [ OK ] Port %PORT% is free
echo.

rem ---- 4. Open the browser once the server is listening ------
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"

rem ---- 5. Run the server in the foreground -------------------
echo ----------------------------------------------------------
echo    Starting server...
echo    URL: %URL%
echo    Press Ctrl+C or close this window to stop the server.
echo ----------------------------------------------------------
echo.

node server.js
set "CODE=%errorlevel%"

echo.
echo [STOPPED] Server exited with code %CODE%.
echo.
pause
exit /b %CODE%

:halt
echo.
rem Use pause rather than timeout.exe here: timeout.exe aborts with an error
rem when stdin is not a real console (for example when piped), while pause
rem degrades gracefully. It also lets the user read the message at their own pace.
echo Nothing was started. Press any key to close this window.
pause >nul
exit /b 0
