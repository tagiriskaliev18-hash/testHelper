@echo off
chcp 65001 >nul
title ICA Test Helper - Live AI Bridge (127.0.0.1:8765)
color 0B

echo ======================================================================
echo    АО «Интергаз Центральная Азия» — Live AI Мост (Промбез / БИОТ РК)
echo ======================================================================
echo.

where python >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo [ОШИБКА] Python не найден в PATH. Установите Python 3.10+.
    pause
    exit /b 1
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %ERRORLEVEL% equ 0 (
    echo [OK] Мост уже запущен в фоне на http://127.0.0.1:8765/health
    echo      Никаких действий не требуется — расширение может им пользоваться.
    pause
    exit /b 0
)

cd /d "%~dp0"
echo [ИНФО] Запуск Live AI моста на http://127.0.0.1:8765...
python bridge_server.py

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ПРЕДУПРЕЖДЕНИЕ] Сервер завершил работу с кодом %ERRORLEVEL%.
    pause
)
