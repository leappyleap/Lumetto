@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Сборка Lumetto

echo.
echo   ===  Сборка Lumetto  ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Не найден Node.js.
  echo       Установите LTS-версию с https://nodejs.org и запустите этот файл снова.
  echo.
  start "" https://nodejs.org/ru/download
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo   Node.js %NODEVER% найден.
echo.

echo   [1/2] Устанавливаю зависимости (первый раз 1-3 минуты)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   [!] npm install завершился с ошибкой. Проверьте интернет и попробуйте снова.
  pause
  exit /b 1
)

echo.
echo   [2/2] Собираю установщик и портативную версию...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run dist
if errorlevel 1 (
  echo.
  echo   [!] Сборка не удалась.
  echo       Частая причина - нет прав на создание символических ссылок.
  echo       Запустите build.bat правой кнопкой - "Запуск от имени администратора"
  echo       или включите "Режим разработчика" в Параметрах Windows.
  pause
  exit /b 1
)

echo.
echo   Готово! Файлы в папке dist:
echo     - Lumetto Setup 1.0.0.exe      (установщик)
echo     - Lumetto-portable-1.0.0.exe   (без установки)
echo.
start "" "%~dp0dist"
pause
