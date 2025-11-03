@echo off
REM Kaspa Node Auto-Start Script (Auto-generated)
REM This script starts kaspad.exe and automatically restarts it if it crashes

title Kaspa Node - Auto-Restart Script

REM Get the directory where this batch file is located
set "BAT_DIR=%~dp0"

REM Try to find kaspad.exe in common locations relative to batch file
REM First, check if kaspad.exe is in the same directory as this batch file (development)
if exist "%BAT_DIR%kaspad.exe" (
    set "KASPAD_EXE=%BAT_DIR%kaspad.exe"
    set "KASPAD_DIR=%BAT_DIR%"
    goto :found
)

REM Check parent directory (if batch is in userData and exe is in install dir)
set "PARENT_DIR=%BAT_DIR%..\"
if exist "%PARENT_DIR%kaspad.exe" (
    set "KASPAD_EXE=%PARENT_DIR%kaspad.exe"
    set "KASPAD_DIR=%PARENT_DIR%"
    goto :found
)

REM Check installation directory (Program Files or custom install location)
REM Try to find kaspad.exe in the directory where Kaspa Mixer.exe is located
REM This works by checking if we can find the executable relative to common paths
for %%P in ("%ProgramFiles%\Kaspa Mixer\kaspad.exe" "%ProgramFiles(x86)%\Kaspa Mixer\kaspad.exe" "%LOCALAPPDATA%\Programs\kaspa-mixer-standalone\kaspad.exe" "%LOCALAPPDATA%\Programs\Kaspa Mixer\kaspad.exe" "%APPDATA%\kaspa-mixer-standalone\..\kaspad.exe") do (
    if exist %%P (
        set "KASPAD_EXE=%%P"
        set "KASPAD_DIR=%%~dpP"
        goto :found
    )
)

REM Try to find Kaspa Mixer.exe and use its directory
REM Use PowerShell to get the actual executable path (works even if renamed/moved)
powershell -Command "$exe = Get-Process -Name 'Kaspa Mixer' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; if ($exe) { $dir = Split-Path $exe; if (Test-Path (Join-Path $dir 'kaspad.exe')) { Write-Output $dir } }" > "%TEMP%\kaspa_dir.txt" 2>nul
if exist "%TEMP%\kaspa_dir.txt" (
    set /p KASPAD_DIR=<"%TEMP%\kaspa_dir.txt"
    if defined KASPAD_DIR (
        set "KASPAD_EXE=%KASPAD_DIR%\kaspad.exe"
        if exist "%KASPAD_EXE%" (
            del "%TEMP%\kaspa_dir.txt" >nul 2>&1
            goto :found
        )
    )
    del "%TEMP%\kaspa_dir.txt" >nul 2>&1
)

REM Fallback: Search in common installation locations
for %%D in ("%ProgramFiles%" "%ProgramFiles(x86)%" "%LOCALAPPDATA%\Programs") do (
    if exist "%%D\Kaspa Mixer\Kaspa Mixer.exe" (
        if exist "%%D\Kaspa Mixer\kaspad.exe" (
            set "KASPAD_EXE=%%D\Kaspa Mixer\kaspad.exe"
            set "KASPAD_DIR=%%D\Kaspa Mixer\"
            goto :found
        )
    )
    if exist "%%D\kaspa-mixer-standalone\Kaspa Mixer.exe" (
        if exist "%%D\kaspa-mixer-standalone\kaspad.exe" (
            set "KASPAD_EXE=%%D\kaspa-mixer-standalone\kaspad.exe"
            set "KASPAD_DIR=%%D\kaspa-mixer-standalone\"
            goto :found
        )
    )
)

REM Try resources directory (electron-builder puts some files there)
if exist "%BAT_DIR%..\resources\kaspad.exe" (
    set "KASPAD_EXE=%BAT_DIR%..\resources\kaspad.exe"
    set "KASPAD_DIR=%BAT_DIR%..\resources\"
    goto :found
)

REM Try finding the executable that started this process (Kaspa Mixer.exe location)
REM Get parent process path to find installation directory
for /f "tokens=2 delims==" %%I in ('wmic process where "name='Kaspa Mixer.exe'" get ExecutablePath /format:list 2^>nul ^| findstr "="') do (
    if exist "%%~dpIkaspad.exe" (
        set "KASPAD_EXE=%%~dpIkaspad.exe"
        set "KASPAD_DIR=%%~dpI"
        goto :found
    )
)

REM If still not found, try to find it in PATH or use a relative path
where kaspad.exe >nul 2>&1
if %ERRORLEVEL% == 0 (
    set "KASPAD_EXE=kaspad.exe"
    set "KASPAD_DIR="
    goto :found
)

REM Last resort: try relative to batch file location
set "KASPAD_EXE=%BAT_DIR%..\kaspad.exe"
set "KASPAD_DIR=%BAT_DIR%..\"
if not exist "%KASPAD_EXE%" (
    echo ERROR: kaspad.exe not found!
    echo Please ensure kaspad.exe is in the installation directory or in your PATH.
    pause
    exit /b 1
)

:found
REM Change to kaspad.exe directory to ensure it can find any dependencies
if defined KASPAD_DIR (
    cd /d "%KASPAD_DIR%"
)

:xxx
echo Starting Kaspa Node (kaspad.exe)...
if defined KASPAD_DIR (
    echo Directory: %KASPAD_DIR%
) else (
    echo Directory: Current directory
)
echo Parameters: --utxoindex --rpclisten=127.0.0.1:16110 --rpclisten-borsh=127.0.0.1:17110 --perf-metrics --perf-metrics-interval-sec=1 --outpeers=128 --disable-upnp
echo Node Mode: Private (UPnP Disabled)
echo.
echo To stop, press Ctrl+C and then 'Y' when prompted, or press S when asked.
echo.

"%KASPAD_EXE%" --utxoindex --rpclisten=127.0.0.1:16110 --rpclisten-borsh=127.0.0.1:17110 --perf-metrics --perf-metrics-interval-sec=1 --outpeers=128 --disable-upnp

echo.
echo Kaspa Node process exited. Restarting in 5 seconds...
echo Press Ctrl+C to abort restart, or press S to stop now.
choice /C SR /N /T 5 /D R >nul
if errorlevel 2 goto xxx
echo Stopping by user request.
goto :eof
