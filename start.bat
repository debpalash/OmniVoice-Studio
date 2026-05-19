@echo off
chcp 65001 >nul
title OmniVoice Studio

echo ========================================
echo   OmniVoice Studio v0.2.7
echo ========================================
echo.

set "PROJECT_DIR=%~dp0"
set "VENV_PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"

REM ── Check .venv exists ──────────────────────────────────────────
if not exist "%VENV_PYTHON%" (
    echo [ERROR] Python virtual environment not found.
    echo Expected: .venv\Scripts\python.exe
    echo.
    echo Run the following to set up the project:
    echo   uv sync
    echo.
    pause
    exit /b 1
)

REM ── Kill any previous backend on port 3900 ──────────────────────
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3900.*LISTENING" 2^>nul') do (
    echo [INFO] Stopping old backend process %%a ...
    taskkill /pid %%a /f >nul 2>&1
)

REM ── Start backend ───────────────────────────────────────────────
echo [INFO] Starting backend on http://127.0.0.1:3900 ...
echo.

start "OmniVoice-Backend" /min "%VENV_PYTHON%" -m uvicorn main:app --app-dir "%PROJECT_DIR%backend" --host 127.0.0.1 --port 3900

REM ── Wait for backend to be ready ────────────────────────────────
echo [INFO] Waiting for backend to be ready ...
for /l %%i in (1,1,30) do (
    curl -s -o nul -w "%%{http_code}" http://127.0.0.1:3900/health 2>nul | findstr "200" >nul
    if not errorlevel 1 goto :ready
    timeout /t 1 /nobreak >nul
)

:ready
echo [INFO] Backend is ready.

REM ── Open browser ────────────────────────────────────────────────
start http://127.0.0.1:3900

echo.
echo ========================================
echo   OmniVoice Studio is running
echo   http://127.0.0.1:3900
echo   API Docs: http://127.0.0.1:3900/docs
echo ========================================
echo.
echo Close the backend window or press any key here to stop.
pause >nul

REM ── Cleanup on exit ─────────────────────────────────────────────
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3900.*LISTENING" 2^>nul') do (
    taskkill /pid %%a /f >nul 2>&1
)
echo [INFO] OmniVoice Studio stopped.
