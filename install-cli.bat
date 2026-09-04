@echo off
REM Install script for Bubbly CLI (Windows)

echo 🫧 Installing Bubbly CLI...
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js is not installed. Please install Node.js 18+ first.
    exit /b 1
)

echo ✓ Node.js detected
node -v
echo.

REM Navigate to CLI directory
cd cli

REM Install dependencies
echo 📦 Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Failed to install dependencies
    exit /b 1
)

REM Build TypeScript
echo 🔨 Building CLI...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Failed to build CLI
    exit /b 1
)

REM Link globally
echo 🔗 Linking CLI globally...
call npm link
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Failed to link CLI globally
    exit /b 1
)

echo.
echo ✅ Installation complete!
echo.
echo You can now use 'bubbly' from anywhere:
echo   bubbly start              # Start backend and enter chat
echo   bubbly chat               # Enter chat (backend running)
echo   bubbly run "task" -w .    # Execute one-shot task
echo   bubbly sessions           # List saved sessions
echo   bubbly --help             # Show all commands
echo.

pause
