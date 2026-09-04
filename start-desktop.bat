@echo off
setlocal

:: ============================================================
::  Bubbly Desktop launcher (Windows)
::  Builds the backend + frontend, then launches the native app.
:: ============================================================

:: Clear NODE_ENV so dev dependencies install and TypeScript builds.
set "NODE_ENV="

echo.
echo  Starting Bubbly Desktop...
echo.

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found. Install Node 18+ from https://nodejs.org
  pause
  exit /b 1
)

cd /d "%~dp0"

:: Install desktop deps (electron) if missing
if not exist "desktop\node_modules\electron\dist\electron.exe" (
  echo  Installing desktop dependencies ^(first run only^)...
  pushd desktop
  call npm install --include=dev --no-audit --no-fund
  popd
)

:: Build backend + frontend
echo  Building Bubbly...
node scripts\build-all.js
if errorlevel 1 (
  echo  [ERROR] Build failed.
  pause
  exit /b 1
)

:: Launch the desktop app
echo  Launching window...
pushd desktop
call npm start
popd

endlocal
