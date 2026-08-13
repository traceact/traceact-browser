@echo off
rem One double-click: venv, relay, viewer, demo page, and a guided
rem extension install for the one step Chrome keeps to itself.
cd /d "%~dp0"

echo traceact-browser launcher
echo =========================

if exist .venv\Scripts\python.exe (
  .venv\Scripts\python.exe --version >nul 2>&1 || rmdir /s /q .venv
)
if not exist .venv (
  echo Creating a Python environment...
  python -m venv .venv || (echo Python 3 is required. & exit /b 1)
)
.venv\Scripts\python.exe -m ensurepip --upgrade >nul 2>&1

echo Installing the relay and traceact...
.venv\Scripts\python.exe -m pip install -q -e .\relay
.venv\Scripts\python.exe -m pip install -q traceact

set DATA_DIR=%USERPROFILE%\.traceact-browser
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

start "traceact-browser relay" /min .venv\Scripts\traceact-browser.exe serve
timeout /t 2 /nobreak >nul

echo %CD%\extension| clip
echo.
echo One step left (Chrome only lets you do this by hand):
echo   1. On the extensions page that opens, turn on "Developer mode" (top right).
echo   2. Click "Load unpacked" and paste - the folder path is already on your clipboard:
echo      %CD%\extension
start chrome://extensions/

start "traceact viewer" /min .venv\Scripts\traceact.exe view "%DATA_DIR%\traces.jsonl" --map --focus-hook http://127.0.0.1:8631/focus
timeout /t 2 /nobreak >nul
start http://127.0.0.1:8631/demo
echo.
echo The demo page just opened; once the extension is loaded, its traces
echo appear live in the viewer tab. Localhost is tracked out of the box.
