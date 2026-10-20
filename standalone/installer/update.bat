@echo off
setlocal
rem SupportTemplates: select the installed client, keep it open, then press Ctrl+R.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates.ps1" -Action UpdateRenderer %*
set "SUPPORT_TEMPLATES_EXIT=%errorlevel%"
if "%~1"=="" if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause
exit /b %SUPPORT_TEMPLATES_EXIT%
