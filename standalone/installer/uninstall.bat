@echo off
setlocal DisableDelayedExpansion
if not "%~1"=="" goto cli
set "ST_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "ST_NATIVE=%~dp0SupportTemplates\SupportTemplates.ps1"
set "ST_INPUT=%~dp0SupportTemplates\ConsoleInput.ps1"
set "ST_RESULT=0"
chcp 65001 >nul
title SupportTemplates - Удаление
if not exist "%ST_NATIVE%" goto missing
if not exist "%ST_INPUT%" goto missing
:menu
cls
echo   +------------------------------------------------------+
echo   ^|                  SUPPORT TEMPLATES                   ^|
echo   +------------------------------------------------------+
echo.
echo   Из какого Discord удалить SupportTemplates?
echo.
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_INPUT%" -Action Clients
set "ST_SELECTION=%errorlevel%"
if "%ST_SELECTION%"=="255" goto input_error
if "%ST_SELECTION%"=="0" goto done
set "ST_CHANNEL="
if "%ST_SELECTION%"=="1" set "ST_CHANNEL=Stable"
if "%ST_SELECTION%"=="2" set "ST_CHANNEL=Canary"
if "%ST_SELECTION%"=="3" set "ST_CHANNEL=PTB"
if not defined ST_CHANNEL goto input_error
echo.
echo   Удалить SupportTemplates из Discord %ST_CHANNEL%?
echo   Настройки сохранятся. Полностью закройте этот Discord.
echo.
echo   [1] Удалить
echo   [0] Назад
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_INPUT%" -Action Key -Keys 10
if errorlevel 255 goto input_error
if errorlevel 2 goto menu
if not errorlevel 1 goto done
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_NATIVE%" -Action Uninstall -Channel %ST_CHANNEL% -Utf8Output
set "ST_RESULT=%errorlevel%"
echo.
if "%ST_RESULT%"=="0" echo   Готово. Можно запускать Discord.
if not "%ST_RESULT%"=="0" echo   Удаление не завершено. Причина указана выше.
if "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" goto done
echo   [0] Закрыть
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_INPUT%" -Action Key -Keys 0
goto done
:missing
echo   Не хватает файлов установщика. Распакуйте архив целиком.
set "ST_RESULT=2"
if not "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" pause >nul
goto done
:input_error
echo   Не удалось прочитать выбор. Откройте uninstall.bat в обычной консоли.
set "ST_RESULT=1"
:done
exit /b %ST_RESULT%
:cli
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates\SupportTemplates.ps1" -Action Uninstall %*
exit /b %errorlevel%
