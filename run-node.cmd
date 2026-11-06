@echo off
REM ============================================================
REM  run-node.cmd - run the Orbit Remote machine agent in a normal window
REM
REM  Usually not needed: setup.cmd turns on autostart, so the machine agent
REM  starts in the background at every Windows sign-in. The agent finds the hub
REM  on the home network or at the hub's Tailscale address (custom/hub.json) and
REM  asks to join; approve it once on the home screen of the app.
REM
REM  Use this file to watch the agent log on screen. A machine on another
REM  network with no hub address in custom/hub.json needs it once:
REM     node src\main.mjs join http://HUB-ADDRESS:8795
REM
REM  Keep this file ASCII-only (see run.cmd for why).
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

node "%~dp0src\main.mjs" node
echo.
pause
endlocal
