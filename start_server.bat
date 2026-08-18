@echo off
title DM LLM Server Portable
chcp 65001 >nul

:: 1. Get current directory
set "ROOT=%~dp0"

:: 2. Define paths
set "PYTHON=%ROOT%python\python.exe"
set "SERVER=%ROOT%app\server.py"
set "LOGDIR=%ROOT%Logs"

:: 3. Create Logs folder if missing
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

:: 4. Check if Python exists
if not exist "%PYTHON%" (
    echo ERROR: Python not found at %PYTHON%
    pause
    exit /b 1
)

:: 5. Clear old logs
if exist "%LOGDIR%\error.log" del "%LOGDIR%\error.log"

:: 6. Start Server
echo ============================================================
echo   DM LLM Server - Starting...
echo ============================================================
echo Path: %ROOT%
echo.

"%PYTHON%" "%SERVER%" 2>> "%LOGDIR%\error.log"

echo.
echo ============================================================
echo   Server stopped. Exit code: %ERRORLEVEL%
echo ============================================================
pause