@echo off
setlocal
title Qwen-Image-2.1 Studio - Stop

set "PORT=5178"

echo ==========================================================
echo    Qwen-Image-2.1 Studio  ^|  Server Stopper
echo ==========================================================
echo.

set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" 2^>nul') do (
    echo [ .. ] Stopping PID %%p ...
    taskkill /PID %%p /F >nul 2>nul
    if errorlevel 1 (
        echo [FAIL] Could not stop PID %%p - try running as administrator.
    ) else (
        echo [ OK ] PID %%p stopped.
        set "FOUND=1"
    )
)

if not defined FOUND (
    echo [INFO] Nothing is listening on port %PORT%.
    echo        The server is not running.
)

echo.
pause
exit /b 0
