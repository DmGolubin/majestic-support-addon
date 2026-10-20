@echo off
setlocal DisableDelayedExpansion
rem Explicit arguments are an offline CLI: no menu, update checks or pause.
if not "%~1"=="" goto cli
set "ST_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "ST_NATIVE=%~dp0SupportTemplates\SupportTemplates.ps1"
set "ST_UPDATE=%~dp0SupportTemplates\PackageUpdate.ps1"
set "ST_MANIFEST=%~dp0SupportTemplates\manifest.json"
set "ST_CHANNEL="
set "ST_RESULT=0"
chcp 65001 >nul
title SupportTemplates Lite
if not exist "%ST_NATIVE%" goto missing
call :frame
"%ST_PS%" -NoLogo -NoProfile -Command "try { $v = (Get-Content -LiteralPath $env:ST_MANIFEST -Raw -ErrorAction Stop | ConvertFrom-Json).version; if ($v -is [string] -and $v -cmatch '\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\z' -and $v.Length -le 100) { Write-Output ('  Package: ' + $v) } } catch {}"
echo   Проверка обновлений пакета. Ожидание сети: до 20 секунд.
echo   Discord сейчас не изменяется.
echo.
if not exist "%ST_UPDATE%" goto updater_missing_start
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_UPDATE%" -Action Check -Console
if errorlevel 1 echo   Проверка недоступна. Можно продолжить с локальным пакетом.
goto startup_done
:updater_missing_start
echo   Модуль обновления отсутствует. Распакуйте полный архив пакета.
:startup_done
call :pause
:home
call :frame
if defined ST_CHANNEL echo   Выбран Discord: %ST_CHANNEL%
if not defined ST_CHANNEL echo   Discord: сначала выберите Stable или Canary.
echo.
echo   -- DISCORD --------------------------------------------
echo   [1] Выбрать Discord
echo   [2] Установить / обновить Lite
echo.
echo   -- PACKAGE --------------------------------------------
echo   [3] Обновление пакета
echo.
echo   -- SERVICE --------------------------------------------
echo   [4] Статус установки
echo   [5] Восстановить установку
echo   [6] Удалить Lite
echo.
echo   [0] Выход
echo.
choice /c 1234560 /n /m "  Ваш выбор: "
if errorlevel 255 goto input_error
if errorlevel 7 goto done
if errorlevel 6 goto uninstall
if errorlevel 5 goto repair
if errorlevel 4 goto status
if errorlevel 3 goto updates
if errorlevel 2 goto install
if errorlevel 1 goto choose
goto done
:choose
call :channel
goto home
:install
set "ST_PACKAGE_ACTION=Install"
goto package_action
:repair
set "ST_PACKAGE_ACTION=Repair"
:package_action
call :require_channel
if errorlevel 1 goto home
call :frame
echo   Discord %ST_CHANNEL%  /  %ST_PACKAGE_ACTION%
echo   Закройте выбранный Discord. Проверки защиты выполняет установщик.
echo.
if not exist "%ST_UPDATE%" goto updater_missing
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_UPDATE%" -Action %ST_PACKAGE_ACTION% -Channel %ST_CHANNEL%
call :result
goto home
:status
set "ST_ACTION=Status"
goto native
:uninstall
call :require_channel
if errorlevel 1 goto home
call :frame
echo   Удалить Lite из Discord %ST_CHANNEL%?
echo   Исходный Discord будет восстановлен штатным установщиком.
echo.
choice /c 10 /n /m "  [1] Удалить  [0] Назад: "
if errorlevel 255 goto input_error
if errorlevel 2 goto home
if not errorlevel 1 goto home
set "ST_ACTION=Uninstall"
:native
call :require_channel
if errorlevel 1 goto home
call :frame
echo   Discord: %ST_CHANNEL%  /  %ST_ACTION%
echo.
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_NATIVE%" -Action %ST_ACTION% -Channel %ST_CHANNEL% -Utf8Output
call :result
goto home
:updates
call :frame
echo   [1] Проверить новую версию  ^(до 20 секунд^)
echo   [2] Скачать проверенный пакет  ^(до 80 секунд^)
echo   [0] Назад
echo.
echo   Скачивание не устанавливает Lite в Discord.
echo   Следующая установка автоматически использует проверенный пакет.
echo.
choice /c 120 /n /m "  Ваш выбор: "
if errorlevel 255 goto input_error
if errorlevel 3 goto home
if errorlevel 2 goto download
if errorlevel 1 goto check
goto home
:download
set "ST_UPDATE_ACTION=Update"
goto update_run
:check
set "ST_UPDATE_ACTION=Check"
:update_run
if not exist "%ST_UPDATE%" goto updater_missing
echo.
echo   Запрос выполняется. Дождитесь результата.
"%ST_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ST_UPDATE%" -Action %ST_UPDATE_ACTION% -Console
call :result
goto updates
:updater_missing
echo   Модуль обновления отсутствует. Распакуйте полный архив пакета.
set "ST_RESULT=2"
call :pause
goto home
:require_channel
if defined ST_CHANNEL exit /b 0
call :channel
exit /b %errorlevel%
:channel
call :frame
echo   Выберите установленный Discord:
echo.
echo   [1] Discord Stable
echo   [2] Discord Canary
echo   [0] Назад
echo.
choice /c 120 /n /m "  Ваш выбор: "
if errorlevel 255 exit /b 1
if errorlevel 3 exit /b 1
if errorlevel 2 goto channel_canary
if errorlevel 1 goto channel_stable
exit /b 1
:channel_canary
set "ST_CHANNEL=Canary"
exit /b 0
:channel_stable
set "ST_CHANNEL=Stable"
exit /b 0
:result
set "ST_RESULT=%errorlevel%"
echo.
if "%ST_RESULT%"=="0" goto result_ok
color 0C
echo   Команда не выполнена. Код: %ST_RESULT%.
echo   Причина указана выше. Исправьте её и повторите действие.
goto result_pause
:result_ok
color 0A
echo   Команда завершена ^(код 0^). Результат и предупреждения указаны выше.
:result_pause
call :pause
exit /b 0
:frame
cls
color 0D
echo   +------------------------------------------------------+
rem A short decorative reveal, never an operation progress indicator.
echo   ^|              SUPPORT TEMPLATES  /  LITE              ^|
echo   +------------------------------------------------------+
rem Decorative ASCII only; no operation percentages or network text in cmd.
if "%SUPPORT_TEMPLATES_NO_ANIMATION%"=="1" goto frame_static
"%ST_PS%" -NoLogo -NoProfile -Command "$rows = @('       ____  _   _ ____  ____   ___  ____ _____', '      / ___|| | | |  _ \|  _ \ / _ \|  _ \_   _|', '      \___ \| |_| | |_) | |_) | | | | |_) || |', '       ___) |_____|____/|____/ \___/|_| \_\|_|'); foreach ($row in $rows) { Write-Output $row; if ($env:SUPPORT_TEMPLATES_NO_ANIMATION -ne '1') { Start-Sleep -Milliseconds 55 } }; Write-Output ''"
goto frame_tail
:frame_static
echo        ____  _   _ ____  ____   ___  ____ _____
echo       / ___^|^| ^| ^| ^|  _ \^|  _ \ / _ \^|  _ \_   _^|
echo       \___ \^| ^|_^| ^| ^|_) ^| ^|_) ^| ^| ^| ^| ^|_) ^|^| ^|
echo        ___) ^|_____^|____/^|____/ \___/^|_^| \_\^|_^|
:frame_tail
echo.
exit /b 0
:pause
echo.
if "%SUPPORT_TEMPLATES_NO_PAUSE%"=="1" exit /b 0
echo   Нажмите любую клавишу, чтобы продолжить...
pause >nul
exit /b 0
:missing
echo   Не найден SupportTemplates\SupportTemplates.ps1.
echo   Распакуйте архив целиком рядом с install.bat.
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
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupportTemplates\SupportTemplates.ps1" -Action Install %*
exit /b %errorlevel%
