# Installation Guide for Linux & macOS

This guide covers installation and usage of Bubbly on Linux and macOS systems.

## Prerequisites

- **Node.js 18+** (required)
- **npm** (comes with Node.js)
- **git** (recommended for repository features)

### Installing Prerequisites

#### macOS

Using Homebrew:
```bash
brew install node
brew install git  # optional but recommended
```

Or download from [nodejs.org](https://nodejs.org/)

#### Linux

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

**Fedora/RHEL/CentOS:**
```bash
sudo dnf install nodejs npm git
```

**Arch Linux:**
```bash
sudo pacman -S nodejs npm git
```

---

## Installation Methods

### Method 1: Quick Start (Development Mode)

Clone the repository and run the setup script:

```bash
git clone <repository-url> bubbly
cd bubbly
chmod +x setup.sh start.sh install-cli.sh
./setup.sh
```

This will:
- Verify Node.js and npm versions
- Install backend dependencies
- Install frontend dependencies
- Prepare the environment

### Method 2: Build Desktop App

Build native installers for your platform:

```bash
cd bubbly
npm run setup        # Install all dependencies
npm run dist         # Build for current platform
```

**Platform-specific builds:**
```bash
npm run dist:linux   # Build .AppImage, .deb, .rpm, .tar.gz
npm run dist:mac     # Build .dmg and .zip (macOS only)
```

Built installers will be in `desktop/release/`:

**Linux:**
- `Bubbly-1.0.0-linux-x64.AppImage` - Universal AppImage (recommended)
- `Bubbly-1.0.0-linux-x64.deb` - Debian/Ubuntu package
- `Bubbly-1.0.0-linux-x64.rpm` - Fedora/RHEL package
- `Bubbly-1.0.0-linux-x64.tar.gz` - Portable archive

**macOS:**
- `Bubbly-1.0.0-mac-x64.dmg` - Intel Macs
- `Bubbly-1.0.0-mac-arm64.dmg` - Apple Silicon (M1/M2/M3)

### Method 3: Terminal CLI Only

Install just the CLI client:

```bash
cd bubbly
chmod +x install-cli.sh
./install-cli.sh
```

This will:
- Install CLI dependencies
- Build the TypeScript code
- Link the `bubbly` command globally

---

## Running Bubbly

### Desktop App

After building:

**AppImage (Linux):**
```bash
chmod +x desktop/release/Bubbly-*.AppImage
./desktop/release/Bubbly-*.AppImage
```

**Debian/Ubuntu:**
```bash
sudo dpkg -i desktop/release/Bubbly-*.deb
bubbly  # or launch from applications menu
```

**Fedora/RHEL:**
```bash
sudo rpm -i desktop/release/Bubbly-*.rpm
bubbly  # or launch from applications menu
```

**macOS:**
```bash
open desktop/release/Bubbly-*.dmg
# Drag Bubbly to Applications folder
```

### Development Mode (Backend + Frontend)

Start both servers in development mode:

```bash
./start.sh
```

This will:
- Start backend on `http://localhost:3001`
- Start frontend on `http://localhost:3000`
- Auto-restart on code changes

Access the UI at: **http://localhost:3000**

Press `Ctrl+C` to stop both servers.

### Terminal CLI

After installing the CLI:

```bash
# Quick help
bubbly --help

# Start interactive session in current directory
bubbly

# Run a single task
bubbly run "add a health check endpoint"

# Check system requirements
bubbly doctor

# List all sessions
bubbly sessions

# Open a specific session
bubbly session <session-id>
```

---

## Configuration

### First Time Setup

1. **Environment file**: Copy the example environment:
   ```bash
   cp backend/.env.example backend/.env
   ```

2. **Edit configuration**:
   ```bash
   nano backend/.env  # or vim, emacs, etc.
   ```

3. **Set your AI provider**:
   - For Anthropic Claude:
     ```
     ANTHROPIC_API_KEY=sk-ant-...
     ```
   - For Ollama (local):
     ```
     OLLAMA_URL=http://localhost:11434
     ```

### User Data Location

All user data is stored in:
```
~/.bubbly/
  bubbly.db          # Threads, messages, settings
  vault.json         # Encrypted credentials (AES-256-GCM)
  repos/             # Cloned repositories
  logs/              # Backend logs
```

### Workspace Configuration

Per-project instructions go in `.bubbly/` inside your workspace:
```
your-project/
  .bubbly/
    steering/        # Project-specific instructions
    specs/           # Feature specifications
```

---

## Platform-Specific Notes

### Linux

**Required runtime dependencies:**
- GTK+ 3
- libnotify
- NSS
- libXScrnSaver
- libatspi2.0
- libsecret

**Install on Ubuntu/Debian:**
```bash
sudo apt-get install libgtk-3-0 libnotify4 libnss3 libxss1 \
  libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0
```

**Install on Fedora:**
```bash
sudo dnf install libnotify libXScrnSaver libsecret
```

**AppImage troubleshooting:**

If AppImage doesn't run:
```bash
# Make sure FUSE is installed
sudo apt-get install libfuse2  # Ubuntu/Debian
sudo dnf install fuse-libs     # Fedora

# Or extract and run directly
./Bubbly-*.AppImage --appimage-extract
./squashfs-root/AppRun
```

### macOS

**Gatekeeper warning:**

First time running, macOS may block the app. To allow:
1. Right-click the app and select "Open"
2. Click "Open" in the security dialog

Or from terminal:
```bash
xattr -cr /Applications/Bubbly.app
```

**Apple Silicon (M1/M2/M3):**
- Use the `arm64` build for native performance
- The `x64` build will run via Rosetta 2

**Permissions:**
- macOS will ask for folder access when you first open a workspace
- This is normal and required for the agent to read/write files

---

## Troubleshooting

### Permission Denied

If shell scripts won't run:
```bash
chmod +x setup.sh start.sh install-cli.sh
```

### Port Already in Use

If ports 3000 or 3001 are occupied:
```bash
# Find and kill the process
lsof -ti:3000 | xargs kill
lsof -ti:3001 | xargs kill
```

Or edit `backend/.env` and `frontend/vite.config.ts` to use different ports.

### Node Version Issues

Check your Node version:
```bash
node -v  # Should be v18.0.0 or higher
```

If too old, update Node.js using your package manager or [nvm](https://github.com/nvm-sh/nvm):
```bash
# Using nvm
nvm install 18
nvm use 18
```

### Build Errors

If build fails with native module errors:
```bash
# Install build tools

# Ubuntu/Debian
sudo apt-get install build-essential python3

# macOS
xcode-select --install

# Then rebuild
npm run setup
```

### CLI Not Found After Install

If `bubbly` command not found:
```bash
# Check npm global bin path
npm config get prefix

# Add to PATH in ~/.bashrc or ~/.zshrc:
export PATH="$(npm config get prefix)/bin:$PATH"

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

---

## Development

### Running Tests

```bash
cd backend
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

### Hot Reload Development

Terminal 1 (Backend):
```bash
cd backend
npm run dev
```

Terminal 2 (Frontend):
```bash
cd frontend
npm run dev
```

### Type Checking

```bash
npm run typecheck  # Check all TypeScript in all workspaces
```

### Building Individual Components

```bash
npm run build:backend   # Build backend only
npm run build:frontend  # Build frontend only (generates themes first)
npm run build:cli       # Build CLI only
npm run build           # Build all three
```

---

## Uninstallation

### Remove Installed Desktop App

**Ubuntu/Debian:**
```bash
sudo dpkg -r bubbly-desktop
```

**Fedora/RHEL:**
```bash
sudo rpm -e bubbly-desktop
```

**macOS:**
```bash
rm -rf /Applications/Bubbly.app
```

**AppImage:**
```bash
rm Bubbly-*.AppImage
```

### Remove CLI

```bash
npm uninstall -g @bubbly/cli
```

### Remove User Data (Optional)

⚠️ This will delete all your sessions, messages, and credentials:
```bash
rm -rf ~/.bubbly
```

---

## System Requirements

**Minimum:**
- Node.js 18+
- 2 GB RAM
- 500 MB disk space

**Recommended:**
- Node.js 20+
- 4 GB RAM
- 1 GB disk space
- SSD for better performance

**Supported Architectures:**
- x64 (Intel/AMD)
- arm64 (Apple Silicon, ARM Linux)

---

## Getting Help

- **Documentation**: See README.md for features and workflows
- **Issues**: Report bugs on GitHub Issues
- **Logs**: Check `~/.bubbly/logs/` and `backend/logs/`

## Quick Reference

```bash
# Setup and start
./setup.sh && ./start.sh

# Install CLI
./install-cli.sh

# Build desktop app
npm run dist

# Run tests
cd backend && npm test

# Clean build
rm -rf node_modules backend/node_modules frontend/node_modules cli/node_modules
npm run setup
```
