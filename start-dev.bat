@echo off
chcp 65001 >nul
title OmniVoice Studio (Dev Mode)

echo ========================================
echo   OmniVoice Studio v0.2.7 (Dev Mode)
echo ========================================
echo.

set "PROJECT_DIR=%~dp0"
set "VENV_PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"

REM ── Check .venv exists ──────────────────────────────────────────
if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python virtual environment not found.
    echo Expected: .venv\Scripts\python.exe
    echo Run: uv sync
    pause
    exit /b 1
)

REM ── Check bun exists ────────────────────────────────────────────
where bun >nul 2>&1
if errorlevel 1 (
    echo [ERROR] bun is not installed.
    echo Install from: https://bun.sh
    echo Or use start.bat for production mode.
    pause
    exit /b 1
)

REM ── Kill previous processes on ports 3900/3901 ──────────────────
for %%p in (3900 3901) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p.*LISTENING" 2^>nul') do (
        echo [INFO] Stopping old process on port %%p (PID %%a) ...
        taskkill /pid %%a /f >nul 2>&1
    )
)

REM ── Start backend in background window ──────────────────────────
echo [1/3] Starting backend on http://127.0.0.1:3900 ...
start "OmniVoice-Backend" /min "%VENV_PYTHON%" -m uvicorn main:app --app-dir "%PROJECT_DIR%backend" --host 127.0.0.1 --port 3900

REM ── Wait for backend ────────────────────────────────────────────
echo [INFO] Waiting for backend ...
for /l %%i in (1,1,30) do (
    curl -s -o nul -w "%%{http_code}" http://127.0.0.1:3900/health 2>nul | findstr "200" >nul
    if not errorlevel 1 goto :backend_ready
    timeout /t 1 /nobreak >nul
)
:backend_ready

REM ── Start Vite dev server ───────────────────────────────────────
echo [2/3] Starting Vite dev server on http://127.0.0.1:3901 ...
start "OmniVoice-Vite" /min bun run --cwd "%PROJECT_DIR%frontend" dev

REM ── Wait for Vite ───────────────────────────────────────────────
echo [INFO] Waiting for Vite ...
for /l %%i in (1,1,30) do (
    curl -s -o nul -w "%%{http_code}" http://127.0.0.1:3901 2>nul | findstr "200" >nul
    if not errorlevel 1 goto :vite_ready
    timeout /t 1 /nobreak >nul
)
:vite_ready

REM ── Open browser ────────────────────────────────────────────────
echo [3/3] Opening browser ...
start http://127.0.0.1:3901

echo.
echo ========================================
echo   OmniVoice Studio (Dev Mode)
echo   Frontend : http://127.0.0.1:3901
echo   Backend  : http://127.0.0.1:3900
echo   API Docs : http://127.0.0.1:3900/docs
echo ========================================
echo.
echo Press any key here to stop all services.
pause >nul

REM ── Cleanup ─────────────────────────────────────────────────────
echo [INFO] Stopping services ...
for %%p in (3900 3901) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%p.*LISTENING" 2^>nul') do (
        taskkill /pid %%a /f >nul 2>&1
    )
)
echo [INFO] OmniVoice Studio stopped.
