@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите его с https://nodejs.org
  start "" https://nodejs.org/ru/download
  pause
  exit /b 1
)

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)

start "" /b cmd /c "npx electron ."
