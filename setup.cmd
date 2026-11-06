@echo off
REM ============================================================
REM  setup.cmd - set up THIS machine for Orbit Remote. Just double-click it.
REM
REM  For a machine that runs sessions (not the hub). It also works on the hub
REM  machine and then only checks and installs what that machine lacks.
REM
REM  What it does, each step checked on the real machine and fixed when missing:
REM    1. Gets the newest Orbit Remote code (git pull --ff-only, only when safe).
REM    2. Installs Node.js LTS with winget if it is missing.
REM    3. Runs "node src\main.mjs setup": Git, Claude Code,
REM       ffmpeg with ddagrab (screen view), a test capture of one frame, the
REM       mouse and keyboard helper, firewall rules (one UAC prompt), Tailscale
REM       sign-in, autostart at Windows sign-in, restart of the machine agent on
REM       the new code, and approval of this machine on the phone app.
REM  The list of steps lives in src\setup.mjs. Running this file again is safe:
REM  steps that are already done are only checked.
REM
REM  Check only, change nothing:  node src\main.mjs doctor
REM
REM  Keep this file ASCII-only (see run.cmd for why). Everything runs inside one
REM  parenthesized block: cmd.exe reads the whole block before running it, so
REM  "git pull" may rewrite this very file without cmd.exe running half-new lines.
REM ============================================================
setlocal EnableDelayedExpansion
(
  cd /d "%~dp0"
  set "NODE="
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
  if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

  where git >nul 2>nul
  if not errorlevel 1 (
    echo --- Getting the newest Orbit Remote code ---
    git -C "%~dp0." pull --ff-only
    if errorlevel 1 (
      REM Another git command on the same repository, such as VS Code
      REM auto fetch, makes git fail with "incorrect old value provided" or "cannot lock ref". No
      REM brackets in these notes: inside a block a closing bracket would end the block. Wait, retry.
      echo [NOTE] git failed, maybe busy with another git command. Trying again in 3 seconds...
      ping -n 4 127.0.0.1 >nul
      git -C "%~dp0." pull --ff-only
      if errorlevel 1 (
        set "ORBIT_REMOTE_PULL_FAILED=1"
        echo [NOTE] Could not fast-forward the Orbit Remote repository. Setup goes on with the code on disk.
      )
    )
    echo.
  )

  if not defined NODE (
    where winget >nul 2>nul
    if errorlevel 1 (
      echo [ERROR] Node.js is missing and winget is not available to install it.
      echo         Install Node.js LTS from https://nodejs.org and run this file again.
      pause
      exit /b 1
    )
    echo --- Installing Node.js LTS ---
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
  )
  if not defined NODE (
    echo [ERROR] Node.js is still missing. Install Node.js LTS from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )

  "!NODE!" "%~dp0src\main.mjs" setup %*
  set "ORBIT_EXIT=!errorlevel!"
  echo.
  pause
  exit /b !ORBIT_EXIT!
)
