@echo off
setlocal
title Harmonica Studio
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harmonica.ps1" -OpenBrowser %*
set "RESULT=%errorlevel%"
if not "%RESULT%"=="0" (
  echo.
  echo Harmonica could not start. The error and log path are shown above.
  pause
)
exit /b %RESULT%
