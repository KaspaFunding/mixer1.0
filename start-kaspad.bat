@echo off
REM Kaspa Node Auto-Start Script
REM This script starts kaspad.exe and automatically restarts it if it crashes

title Kaspa Node (kaspad.exe)
color 0A

echo ========================================
echo Kaspa Node - Auto-Restart Script
echo ========================================
echo.
echo Configuration:
echo   - UTXO Index: Enabled
echo   - JSON-RPC: 127.0.0.1:16110
echo   - Borsh WebSocket: 127.0.0.1:17110
echo   - Performance Metrics: Enabled
echo   - Outgoing Peers: 128
echo.
echo Press Ctrl+C to stop (will ask for confirmation)
echo.

:xxx
echo [%date% %time%] Starting Kaspa Node...
echo.

kaspad.exe --utxoindex --rpclisten=127.0.0.1:16110 --rpclisten-borsh=127.0.0.1:17110 --perf-metrics --perf-metrics-interval-sec=1 --outpeers=128

REM Check exit code
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [%date% %time%] Node exited with error code: %ERRORLEVEL%
) else (
    echo.
    echo [%date% %time%] Node stopped normally
)

echo.
echo Kaspa Node stopped. Restarting in 5 seconds...
echo Press Ctrl+C to abort restart, or press S to stop now.
rem Allow Ctrl+C to break, and also offer S key to stop without Ctrl+C
choice /C SR /N /T 5 /D R >nul
if errorlevel 2 goto xxx
echo Stopping by user request.
goto :eof
