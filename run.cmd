@echo off
REM ============================================================
REM  run.cmd - open Orbit Remote on this machine
REM
REM  Double-click to run. If the hub is not running yet, it is started in the
REM  background (no console window). Then a QR code and a pairing code for the
REM  phone are printed in this window. No browser is opened; to use the app on
REM  this machine, Ctrl+click the local address printed below.
REM
REM  Hub log: %USERPROFILE%\.orbit\state\remote\hub.log
REM  Run by hand to see errors at once:  node src\main.mjs
REM
REM  Keep this file ASCII-only. With non-ASCII bytes cmd.exe misreads its own
REM  line positions and runs fragments of comments as commands. Vietnamese text
REM  is printed by Node, which writes to the console correctly by itself.
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

node "%~dp0src\main.mjs" start
echo.
pause
endlocal
