@echo off
rem Start Harmonica Studio in the background without opening a browser.
rem Extra arguments are forwarded to start-harmonica.ps1.
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harmonica.ps1" %*
set "RESULT=%errorlevel%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
