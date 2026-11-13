@echo off
chcp 65001 >nul
set "BRIDGE_DIR=%~dp0"
set "VBS_PATH=%BRIDGE_DIR%Start-Bridge-Hidden.vbs"

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "ICA_TestHelper_Bridge" /t REG_SZ /d "wscript.exe //nologo \"%VBS_PATH%\"" /f >nul
if %ERRORLEVEL% equ 0 (
    echo [OK] Автозапуск Live-ИИ моста добавлен для текущего пользователя.
) else (
    echo [ОШИБКА] Не удалось добавить запись автозапуска.
    exit /b 1
)

wscript.exe //nologo "%VBS_PATH%"
echo [OK] Фоновый процесс Live-ИИ моста запущен.
