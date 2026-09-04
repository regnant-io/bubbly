# Platform-Specific Quick Reference

This guide provides platform-specific commands and notes for running Bubbly on different operating systems.

---

## 🐧 Linux

### Distributions Tested

- Ubuntu 20.04+, 22.04+, 24.04+
- Debian 11+, 12+
- Fedora 38+, 39+, 40+
- RHEL/Rocky/Alma 8+, 9+
- Arch Linux
- openSUSE Leap/Tumbleweed
- Linux Mint 21+

### Quick Start

```bash
# Make scripts executable
chmod +x setup.sh start.sh install-cli.sh make-executable.sh

# Setup and run
./setup.sh
./start.sh
```

### Package Installation

**Ubuntu/Debian (.deb):**
```bash
sudo dpkg -i Bubbly-*.deb
sudo apt-get install -f  # Fix dependencies if needed
```

**Fedora/RHEL (.rpm):**
```bash
sudo rpm -i Bubbly-*.rpm
```

**Universal (AppImage):**
```bash
chmod +x Bubbly-*.AppImage
./Bubbly-*.AppImage

# Or install to system
mv Bubbly-*.AppImage ~/.local/bin/bubbly
```

**Portable (tar.gz):**
```bash
tar -xzf Bubbly-*.tar.gz
cd bubbly-*
./bubbly
```

### System Dependencies

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install -y \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 \
  xdg-utils libatspi2.0-0 libsecret-1-0 \
  nodejs npm git build-essential python3
```

**Fedora:**
```bash
sudo dnf install -y \
  libnotify libXScrnSaver libsecret \
  nodejs npm git gcc-c++ make python3
```

**Arch Linux:**
```bash
sudo pacman -S \
  gtk3 libnotify nss libxss \
  nodejs npm git base-devel python
```

### Desktop Integration (AppImage)

Create a desktop entry:
```bash
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/bubbly.desktop << 'EOF'
[Desktop Entry]
Name=Bubbly
Comment=A local-first AI coding agent
Exec=/path/to/Bubbly.AppImage
Icon=bubbly
Terminal=false
Type=Application
Categories=Development;IDE;
EOF

# Update desktop database
update-desktop-database ~/.local/share/applications
```

### Common Issues

**AppImage won't run:**
```bash
# Install FUSE
sudo apt-get install libfuse2        # Ubuntu/Debian
sudo dnf install fuse-libs           # Fedora
sudo pacman -S fuse2                 # Arch

# Or extract and run
./Bubbly-*.AppImage --appimage-extract
./squashfs-root/AppRun
```

**Native modules compilation errors:**
```bash
sudo apt-get install build-essential python3
npm rebuild
```

---

## 🍎 macOS

### Versions Supported

- macOS 11 Big Sur (Intel & Apple Silicon)
- macOS 12 Monterey
- macOS 13 Ventura
- macOS 14 Sonoma
- macOS 15 Sequoia

### Quick Start

```bash
# Make scripts executable
chmod +x setup.sh start.sh install-cli.sh

# Setup and run
./setup.sh
./start.sh
```

### Package Installation

**DMG (Recommended):**
```bash
# Open the DMG
open Bubbly-*.dmg

# Drag Bubbly to Applications
# Then eject the DMG

# Launch from Applications or terminal
open /Applications/Bubbly.app
```

**ZIP Archive:**
```bash
unzip Bubbly-*.zip
mv Bubbly.app /Applications/
```

### Architecture Selection

**Apple Silicon (M1/M2/M3/M4):**
- Use `Bubbly-*-mac-arm64.dmg` for native performance
- The Intel build will work via Rosetta 2 but slower

**Intel Macs:**
- Use `Bubbly-*-mac-x64.dmg`

### First Launch

macOS will show a security warning. To allow:

**Method 1 (GUI):**
1. Right-click Bubbly.app
2. Click "Open"
3. Click "Open" in the dialog

**Method 2 (Terminal):**
```bash
xattr -cr /Applications/Bubbly.app
open /Applications/Bubbly.app
```

### System Dependencies

```bash
# Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js and git
brew install node git

# Install Xcode Command Line Tools (for building)
xcode-select --install
```

### Development Setup

```bash
# Using Homebrew
brew install node git

# Or using nvm (Node Version Manager)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 18
nvm use 18
```

### Permissions

Bubbly will request permissions when needed:
- **Full Disk Access**: To read/write project files
- **Accessibility**: For some terminal features

Grant these in:
`System Preferences → Security & Privacy → Privacy`

### Common Issues

**"Bubbly.app is damaged":**
```bash
xattr -cr /Applications/Bubbly.app
```

**Notarization warning:**
The app is unsigned in development. This is normal for self-built apps.

**Node not found in desktop app:**
```bash
# Ensure Node is in PATH
echo 'export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

---

## 🪟 Windows

*See main README for Windows-specific instructions*

Quick reference:
- Use `setup.bat` instead of `setup.sh`
- Use `start.bat` instead of `start.sh`
- Use `install-cli.bat` instead of `install-cli.sh`

---

## Cross-Platform Commands

### Development Scripts

| Task | Linux/macOS | Windows |
|------|-------------|---------|
| Setup | `./setup.sh` | `setup.bat` |
| Start dev | `./start.sh` | `start.bat` |
| Install CLI | `./install-cli.sh` | `install-cli.bat` |
| Run tests | `./test.sh` | `npm --prefix backend test` |
| Build all | `npm run build` | `npm run build` |
| Type check | `npm run typecheck` | `npm run typecheck` |

### CLI Commands (All Platforms)

```bash
bubbly                          # Interactive session
bubbly run "task"               # One-shot task
bubbly doctor                   # System check
bubbly sessions                 # List sessions
bubbly --help                   # Full help
```

### Package Managers

| Platform | Command | Example |
|----------|---------|---------|
| npm (all) | `npm install` | Universal |
| Homebrew (macOS) | `brew install node` | macOS only |
| apt (Debian/Ubuntu) | `sudo apt-get install nodejs` | Debian-based Linux |
| dnf (Fedora/RHEL) | `sudo dnf install nodejs` | Red Hat-based Linux |
| pacman (Arch) | `sudo pacman -S nodejs` | Arch Linux |

---

## Environment Variables

### Unix (Linux/macOS)

**Set in shell:**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OLLAMA_URL="http://localhost:11434"
```

**Persist in shell config:**
```bash
# bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc

# zsh (macOS default)
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

**Using .env file (recommended):**
```bash
cp backend/.env.example backend/.env
nano backend/.env  # or vim, emacs, etc.
```

### Windows

**PowerShell:**
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

**cmd:**
```cmd
set ANTHROPIC_API_KEY=sk-ant-...
```

---

## Path Differences

### Unix Path Style (Linux/macOS)

```bash
/home/user/projects/my-app
~/projects/my-app
./relative/path
../parent/path
```

### Windows Path Style

```cmd
C:\Users\user\projects\my-app
%USERPROFILE%\projects\my-app
.\relative\path
..\parent\path
```

Bubbly handles path conversion automatically.

---

## Performance Notes

### Linux

- **AppImage**: Slightly slower first launch (FUSE mounting)
- **.deb/.rpm**: Fastest, native integration
- **SSD recommended** for database performance

### macOS

- **Apple Silicon (arm64)**: ~2x faster than Intel for builds
- **Intel (x64)**: Still performant, use native build
- **Rosetta 2**: Avoid if possible (use arm64 build on M series)

### General

- **Node.js 20+**: Better performance than 18
- **RAM**: 4GB minimum, 8GB recommended for large workspaces
- **Disk**: SSD strongly recommended (10x faster for DB operations)

---

## Network Configuration

### Firewall (Linux)

**UFW (Ubuntu):**
```bash
sudo ufw allow 3000/tcp  # Frontend
sudo ufw allow 3001/tcp  # Backend
```

**firewalld (Fedora/RHEL):**
```bash
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --add-port=3001/tcp --permanent
sudo firewall-cmd --reload
```

### Firewall (macOS)

macOS will prompt automatically. Or configure manually:
```bash
# System Preferences → Security & Privacy → Firewall → Firewall Options
# Allow "node" to accept incoming connections
```

---

## Shell Support

### Linux

- **bash** (default on most distros) ✅
- **zsh** ✅
- **fish** ✅
- **dash** ✅

### macOS

- **zsh** (default since Catalina) ✅
- **bash** ✅
- **fish** ✅

All shells supported. Scripts use `#!/usr/bin/env bash` for compatibility.

---

## Architecture Support

| Platform | x64 | arm64 |
|----------|-----|-------|
| Linux | ✅ | ✅ |
| macOS | ✅ (Intel) | ✅ (Apple Silicon) |
| Windows | ✅ | ✅ |

Both architectures fully supported on all platforms.

---

## Container Support

### Docker (All Platforms)

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY . .

RUN npm run setup
RUN npm run build

EXPOSE 3001
CMD ["npm", "start"]
```

### Podman (Linux)

```bash
podman build -t bubbly .
podman run -p 3001:3001 bubbly
```

---

## Quick Troubleshooting

| Issue | Linux | macOS |
|-------|-------|-------|
| Permission denied | `chmod +x script.sh` | `chmod +x script.sh` |
| Command not found | Check PATH, reinstall | Check PATH, restart terminal |
| Port in use | `lsof -ti:3000 \| xargs kill` | `lsof -ti:3000 \| xargs kill` |
| Node too old | Use package manager | `brew upgrade node` |
| Build errors | Install build-essential | `xcode-select --install` |

---

## Getting More Help

- **Linux Issues**: Check distro-specific package names
- **macOS Issues**: Verify Xcode Command Line Tools installed
- **Cross-platform**: GitHub Issues

For detailed troubleshooting, see `INSTALL_UNIX.md`.
