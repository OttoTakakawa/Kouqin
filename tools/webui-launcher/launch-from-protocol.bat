@echo off
rem Handler for the harmonica:// URL protocol.
rem %1 is the full protocol URL, for example harmonica://launch?port=4318
setlocal
rem Match Theater: dispatch a separate visible startup shell, then return.
rem The startup shell sends progress/errors to the bookmark before it exits.
start "Harmonica Studio" /D "%~dp0" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harmonica.ps1" -Url "%~1"
exit /b %errorlevel%
