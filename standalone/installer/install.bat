@echo off
setlocal DisableDelayedExpansion
rem Explicit arguments retain the offline native CLI.
if not "%~1"=="" goto cli
chcp 65001 >nul
title SupportTemplates
if not exist "%~dp0SupportTemplates\ConsoleInput.ps1" goto missing
if not exist "%~dp0SupportTemplates\PackageUpdate.ps1" goto missing
if not exist "%~dp0SupportTemplates\SupportTemplates.ps1" goto missing
cls
echo   +------------------------------------------------------+
echo   ^|                  SUPPORT TEMPLATES                   ^|
echo   +------------------------------------------------------+
echo.
rem Keep the same console and PowerShell process through every menu screen.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates\ConsoleInput.ps1" -Action Install
if errorlevel 255 exit /b 1
exit /b %errorlevel%
:missing
echo   Не хватает файлов установщика. Распакуйте архив целиком.
if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause >nul
exit /b 2
:cli
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates\SupportTemplates.ps1" -Action Install %*
exit /b %errorlevel%
