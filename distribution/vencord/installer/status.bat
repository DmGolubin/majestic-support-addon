@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0VencordFull.ps1" -Action Status %*
set "VENCORD_FULL_EXIT=%errorlevel%"
if "%~1"=="" if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause
exit /b %VENCORD_FULL_EXIT%
