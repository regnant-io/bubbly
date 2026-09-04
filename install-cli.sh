#!/bin/bash

# Install script for Bubbly CLI
set -e

echo "🫧 Installing Bubbly CLI..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✓ Node.js $(node -v) detected"
echo ""

# Navigate to CLI directory
cd cli

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building CLI..."
npm run build

# Link globally
echo "🔗 Linking CLI globally..."
npm link

echo ""
echo "✅ Installation complete!"
echo ""
echo "You can now use 'bubbly' from anywhere:"
echo "  bubbly start              # Start backend and enter chat"
echo "  bubbly chat               # Enter chat (backend running)"
echo "  bubbly run \"task\" -w .    # Execute one-shot task"
echo "  bubbly sessions           # List saved sessions"
echo "  bubbly --help             # Show all commands"
echo ""
