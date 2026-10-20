@echo off
setlocal
rem Read-only integrity/status inspection; pending transactions are never recovered here.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates.ps1" -Action Status %*
set "SUPPORT_TEMPLATES_EXIT=%errorlevel%"
if "%~1"=="" if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause
exit /b %SUPPORT_TEMPLATES_EXIT%
