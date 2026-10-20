@echo off
setlocal
rem SupportTemplates Lite: select an installed Discord, or pass -Channel Stable/Canary.
rem -WhatIf validates and prints the plan without changing files.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates.ps1" -Action Install %*
set "SUPPORT_TEMPLATES_EXIT=%errorlevel%"
if "%~1"=="" if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause
exit /b %SUPPORT_TEMPLATES_EXIT%
