@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules\smplr (
  call npm ci
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://127.0.0.1:4317 after the service starts.
call npm start
if errorlevel 1 pause
