@echo off
setlocal DisableDelayedExpansion
rem Explicit arguments retain the offline native CLI and its exact result code.
if not "%~1"=="" goto cli
set "ST_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "ST_NATIVE=%~dp0SupportTemplates\SupportTemplates.ps1"
set "ST_RESULT=0"
chcp 65001 >nul
title SupportTemplates Lite - Uninstall
if not exist "%ST_NATIVE%" goto missing
:menu
cls
color 0D
echo   +------------------------------------------------------+
if "%SUPPORT_TEMPLATES_NO_ANIMATION%"=="1" goto logo_static
"%ST_PS%" -NoLogo -NoProfile -Command "foreach ($row in @('  |     [ S ]  [ U ]  [ P ]  [ P ]  [ O ]  [ R ]  [ T ]    |', '  |                    T E M P L A T E S                 |', '  |                         L I T E                      |')) { Write-Output $row; if ($env:SUPPORT_TEMPLATES_NO_ANIMATION -ne '1') { Start-Sleep -Milliseconds 55 } }"
goto logo_end
:logo_static
echo   ^|     [ S ]  [ U ]  [ P ]  [ P ]  [ O ]  [ R ]  [ T ]    ^|
echo   ^|                    T E M P L A T E S                 ^|
echo   ^|                         L I T E                      ^|
:logo_end
echo   ^|          SUPPORT TEMPLATES  /  УДАЛЕНИЕ LITE          ^|
echo   +------------------------------------------------------+
echo.
echo   Выберите Discord, из которого нужно удалить Lite:
echo.
echo   [1] Discord Stable
echo   [2] Discord Canary
echo   [0] Выход
echo.
choice /c 120 /n /m "  Ваш выбор: "
if errorlevel 255 goto input_error
if errorlevel 3 goto done
if errorlevel 2 goto canary
if errorlevel 1 goto stable
goto done
:canary
set "ST_CHANNEL=Canary"
goto confirm
:stable
set "ST_CHANNEL=Stable"
:confirm
echo.
echo   Удалить Lite из Discord %ST_CHANNEL%?
echo   Закройте выбранный Discord перед удалением.
echo   Настройки и кеш версий сохранятся.
echo.
choice /c 10 /n /m "  [1] Удалить  [0] Назад: "
if errorlevel 255 goto input_error
if errorlevel 2 goto menu
if not errorlevel 1 goto menu
echo.
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_NATIVE%" -Action Uninstall -Channel %ST_CHANNEL% -Utf8Output
set "ST_RESULT=%errorlevel%"
echo.
if "%ST_RESULT%"=="0" goto success
color 0C
echo   Удаление не выполнено. Код: %ST_RESULT%.
echo   Причина указана выше. Исправьте её и повторите действие.
goto result
:success
color 0A
echo   Команда завершена ^(код 0^). Подробности указаны выше.
:result
call :pause
goto menu
:pause
echo.
if "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" exit /b 0
echo   Нажмите любую клавишу, чтобы продолжить...
pause >nul
exit /b 0
:missing
echo   Не найден SupportTemplates\SupportTemplates.ps1.
echo   Распакуйте архив целиком рядом с uninstall.bat.
set "ST_RESULT=2"
call :pause
goto done
:input_error
echo   Не удалось прочитать выбор. Откройте BAT в обычной консоли Windows.
set "ST_RESULT=1"
call :pause
:done
color
exit /b %ST_RESULT%
:cli
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates\SupportTemplates.ps1" -Action Uninstall %*
exit /b %errorlevel%
