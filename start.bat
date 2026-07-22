@echo off
setlocal enabledelayedexpansion

:: Colors for Windows (using ANSI escape codes - works in Windows 10+)
set "BLUE=[94m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "BOLD=[1m"
set "NC=[0m"

echo.
echo %BLUE%%BOLD%🫧  Starting Bubbly%NC%
echo.

:: Check if node_modules exist
if not exist "backend\node_modules" (
    echo %YELLOW%Backend dependencies not installed. Running npm install...%NC%
    cd backend
    call npm install
    cd ..
)

if not exist "frontend\node_modules" (
    echo %YELLOW%Frontend dependencies not installed. Running npm install...%NC%
    cd frontend
    call npm install
    cd ..
)

:: Copy .env if not present
if not exist "backend\.env" (
    if exist "backend\.env.example" (
        copy "backend\.env.example" "backend\.env" >nul
        echo %YELLOW%Created backend\.env from .env.example%NC%
    )
)

echo %BLUE%Starting backend (port 3001)...%NC%
cd backend
start "Bubbly Backend" cmd /c "npm run dev"
cd ..

:: Wait for backend to start
timeout /t 2 /nobreak >nul

echo %BLUE%Starting frontend (port 3000)...%NC%
cd frontend
start "Bubbly Frontend" cmd /c "npm run dev"
cd ..

timeout /t 2 /nobreak >nul

echo.
echo ════════════════════════════════════════
echo %GREEN%%BOLD%🫧  Bubbly is running!%NC%
echo.
echo   Open: %BOLD%http://localhost:3000%NC%
echo.
echo   %YELLOW%First time? Go to Settings (gear icon) and set:%NC%
echo     • Your workspace path
echo     • Anthropic API key (for Claude) or Ollama URL
echo.
echo   Press %BOLD%Ctrl+C%NC% in the backend/frontend windows to stop
echo ════════════════════════════════════════
echo.
echo Backend and frontend are running in separate windows.
echo Close this window or press any key to exit this script.
echo.
pause >nul
