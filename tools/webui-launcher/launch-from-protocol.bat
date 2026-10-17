@echo off
rem Handler for the harmonica:// URL protocol.
rem %1 is the full protocol URL, for example harmonica://launch?port=4318
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-harmonica.ps1" -Url "%~1"
exit /b %errorlevel%
