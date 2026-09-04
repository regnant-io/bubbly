#!/usr/bin/env bash
# Make all shell scripts executable
# Run this after cloning on Linux/macOS: ./make-executable.sh

set -e

echo "🔧 Making shell scripts executable..."

chmod +x setup.sh
chmod +x start.sh
chmod +x install-cli.sh
chmod +x make-executable.sh

echo "✅ Done! Shell scripts are now executable."
echo ""
echo "You can now run:"
echo "  ./setup.sh       - Install dependencies"
echo "  ./start.sh       - Start Bubbly in dev mode"
echo "  ./install-cli.sh - Install CLI globally"
