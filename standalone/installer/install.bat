@echo off
setlocal
rem No arguments opens the GUI. Arguments retain the existing CLI.
rem -WhatIf validates and prints the plan without changing files.
if not "%~1"=="" goto cli
start "SupportTemplates Lite" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0SupportTemplates.Gui.ps1"
exit /b %errorlevel%
:cli
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates.ps1" -Action Install %*
set "SUPPORT_TEMPLATES_EXIT=%errorlevel%"
if "%~1"=="" if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause
exit /b %SUPPORT_TEMPLATES_EXIT%
