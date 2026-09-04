# Platform Support Documentation

Quick navigation to platform-specific documentation and resources.

---

## 📚 Documentation Index

| Document | Best For |
|----------|----------|
| **[README.md](README.md)** | Overview, features, general usage |
| **[INSTALL_UNIX.md](INSTALL_UNIX.md)** | Detailed Linux & macOS installation |
| **[PLATFORM_GUIDE.md](PLATFORM_GUIDE.md)** | Cross-platform command reference |
| **[COMPATIBILITY.md](COMPATIBILITY.md)** | Complete compatibility matrix |
| **[CROSS_PLATFORM_SUMMARY.md](CROSS_PLATFORM_SUMMARY.md)** | Quick platform selection guide |
| **This file** | Navigation hub |

---

## 🔧 Scripts Reference

### Linux & macOS Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| **`./verify-platform.sh`** | Check system compatibility | Before installing |
| **`./doctor.sh`** | Quick health check | Troubleshooting |
| **`./make-executable.sh`** | Make all scripts executable | After cloning |
| **`./setup.sh`** | Install dependencies | First time setup |
| **`./start.sh`** | Start dev mode | Development |
| **`./test.sh`** | Run tests | Testing |
| **`./install-cli.sh`** | Install CLI globally | CLI setup |
| **`./run.sh`** | Interactive menu | If unsure |

### Windows Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| **`setup.bat`** | Install dependencies | First time setup |
| **`start.bat`** | Start dev mode | Development |
| **`start-desktop.bat`** | Launch desktop app | After building |
| **`install-cli.bat`** | Install CLI globally | CLI setup |

---

## 🚀 Quick Start by Platform

### 🐧 Linux

```bash
git clone <repository> bubbly && cd bubbly

# Check compatibility
chmod +x verify-platform.sh
./verify-platform.sh

# Install and run
chmod +x setup.sh start.sh
./setup.sh
./start.sh
```

**Or use the interactive menu:**
```bash
chmod +x run.sh
./run.sh
```

**Distributions:** Ubuntu, Debian, Fedora, RHEL, Arch, openSUSE, and more  
**Packages:** `.AppImage`, `.deb`, `.rpm`, `.tar.gz`  
**Details:** [INSTALL_UNIX.md](INSTALL_UNIX.md)

---

### 🍎 macOS

```bash
git clone <repository> bubbly && cd bubbly

# Check compatibility
chmod +x verify-platform.sh
./verify-platform.sh

# Install and run
chmod +x setup.sh start.sh
./setup.sh
./start.sh
```

**Or use the interactive menu:**
```bash
chmod +x run.sh
./run.sh
```

**Versions:** macOS 11+ (Big Sur and later)  
**Architectures:** Intel (x64) and Apple Silicon (arm64)  
**Packages:** `.dmg`, `.zip`  
**Details:** [INSTALL_UNIX.md](INSTALL_UNIX.md)

---

### 🪟 Windows

```cmd
git clone <repository> bubbly && cd bubbly

REM Install and run
setup.bat
start.bat
```

**Versions:** Windows 10, 11  
**Architectures:** x64, arm64  
**Packages:** `.exe` (installer), `.exe` (portable)  
**Details:** [README.md](README.md)

---

## 📦 Installation Methods

### Method 1: Pre-built Packages (Recommended)

Download from [Releases](../../releases):

**Linux:**
- **Universal**: `Bubbly-*.AppImage` (works on all distros)
- **Debian/Ubuntu**: `Bubbly-*.deb`
- **Fedora/RHEL**: `Bubbly-*.rpm`
- **Portable**: `Bubbly-*.tar.gz`

**macOS:**
- **Intel**: `Bubbly-*-mac-x64.dmg`
- **Apple Silicon**: `Bubbly-*-mac-arm64.dmg`

**Windows:**
- **Installer**: `Bubbly-*-win-x64.exe`
- **Portable**: `Bubbly-*-portable.exe`

### Method 2: Build from Source

```bash
# All platforms
npm run setup    # Install dependencies
npm run dist     # Build for current platform
```

Built packages appear in `desktop/release/`

---

## 🧪 Testing Your Installation

### Quick Check (before CLI installed)

**Linux/macOS:**
```bash
./doctor.sh
```

**Windows:**
```cmd
npm --prefix backend test
```

### Full Verification

**Linux/macOS:**
```bash
./verify-platform.sh
```

### After Installation

```bash
bubbly doctor    # CLI health check
```

---

## 🔍 Troubleshooting by Platform

### Linux Issues

| Problem | Solution |
|---------|----------|
| Permission denied | `chmod +x *.sh` |
| AppImage won't run | Install `libfuse2` |
| Missing libraries | See [INSTALL_UNIX.md](INSTALL_UNIX.md) |
| Port in use | `lsof -ti:3000 \| xargs kill` |

### macOS Issues

| Problem | Solution |
|---------|----------|
| Security warning | Right-click → Open, or `xattr -cr Bubbly.app` |
| Node not found | Ensure Node in PATH, restart terminal |
| Slow on M1/M2/M3 | Use arm64 build, not x64 |
| Build errors | `xcode-select --install` |

### Windows Issues

| Problem | Solution |
|---------|----------|
| Antivirus blocks | Add Bubbly to exceptions |
| PowerShell errors | Run as Administrator |
| Node not found | Add Node to system PATH |
| Scripts fail | Use PowerShell, not cmd |

**See:** [PLATFORM_GUIDE.md](PLATFORM_GUIDE.md) for detailed solutions

---

## 📊 Platform Comparison

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| **Desktop App** | ✅ NSIS installer | ✅ DMG disk image | ✅ Multiple formats |
| **CLI** | ✅ PowerShell/cmd | ✅ Terminal | ✅ All shells |
| **Auto-update** | 🚧 Planned | 🚧 Planned | Via pkg manager |
| **Native feel** | ✅ Windows UI | ✅ macOS UI | ✅ GTK integration |
| **Build speed** | Good | Excellent (M1+) | Good |
| **Credential store** | ✅ Cred Manager | ✅ Keychain | ✅ Secret Service |

**Full comparison:** [COMPATIBILITY.md](COMPATIBILITY.md)

---

## 🛠 Development Setup

### Prerequisites

All platforms need:
- **Node.js 18+** (20+ recommended)
- **npm** (comes with Node.js)
- **git** (optional but recommended)

**Platform-specific tools:**

**Linux:**
```bash
# Ubuntu/Debian
sudo apt-get install build-essential python3

# Fedora
sudo dnf install gcc-c++ make python3
```

**macOS:**
```bash
xcode-select --install
```

**Windows:**
- Install Node.js from [nodejs.org](https://nodejs.org)
- Git Bash or PowerShell recommended

### Running Development Mode

**Linux/macOS:**
```bash
./setup.sh    # First time only
./start.sh    # Each time
```

**Windows:**
```cmd
setup.bat     # First time only
start.bat     # Each time
```

Access at: **http://localhost:3000**

---

## 🏗 Building Packages

### Current Platform

```bash
npm run dist
```

### Specific Platform

```bash
npm run dist:linux   # Linux packages
npm run dist:mac     # macOS packages
npm run dist:win     # Windows packages
```

**Note:** Can only build for current platform (no cross-compilation)

### All Platforms (CI/CD)

Use GitHub Actions workflow (`.github/workflows/release.yml`)

---

## 📋 System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **Node.js** | 18.0.0 | 20.x |
| **RAM** | 2 GB | 4 GB |
| **Disk** | 500 MB | 1 GB |
| **OS** | Win 10, macOS 11, Modern Linux | Latest stable |

**See:** [COMPATIBILITY.md](COMPATIBILITY.md) for detailed requirements

---

## 🌐 Supported Platforms Summary

### Operating Systems

✅ **Windows**: 10, 11  
✅ **macOS**: 11+ (Big Sur, Monterey, Ventura, Sonoma, Sequoia)  
✅ **Linux**: Ubuntu, Debian, Fedora, RHEL, Arch, openSUSE, Mint, Pop!_OS, and more

### Architectures

✅ **x64** (Intel/AMD) - All platforms  
✅ **arm64** (ARM) - Windows, macOS (M1/M2/M3), Linux

### Shells

✅ **bash, zsh, fish, dash** (Unix)  
✅ **PowerShell, cmd** (Windows)

### Package Formats

**Linux:** AppImage, deb, rpm, tar.gz  
**macOS:** dmg, zip  
**Windows:** exe (NSIS), exe (portable)

---

## 🤝 Contributing Platform Support

Contributions welcome for:

1. **New package formats** (Snap, Flatpak, Homebrew, Chocolatey)
2. **Platform testing** (Automated tests for macOS/Windows)
3. **Documentation improvements** (Platform-specific guides)
4. **Bug fixes** (Platform-specific issues)
5. **ARM support** (Testing on ARM devices)

See [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 📞 Getting Help

**Before asking:**
1. Run `./doctor.sh` (Linux/macOS) or `./verify-platform.sh`
2. Check [INSTALL_UNIX.md](INSTALL_UNIX.md) or [README.md](README.md)
3. Review [PLATFORM_GUIDE.md](PLATFORM_GUIDE.md)

**Still stuck?**
- 🐛 **Bug reports**: GitHub Issues
- 💬 **Questions**: GitHub Discussions
- 📖 **Docs**: This directory

---

## 🗺 Document Navigation

```
bubbly/
├── README.md                      # Main documentation (start here)
├── PLATFORMS.md                   # This file (platform hub)
├── INSTALL_UNIX.md               # Linux/macOS installation guide
├── PLATFORM_GUIDE.md             # Cross-platform commands
├── COMPATIBILITY.md              # Complete compatibility matrix
├── CROSS_PLATFORM_SUMMARY.md     # Quick platform selection
├── CONTRIBUTING.md               # How to contribute
├── ARCHITECTURE.md               # Technical architecture
├── SECURITY.md                   # Security practices
│
├── Setup Scripts (Linux/macOS)
│   ├── verify-platform.sh        # System compatibility check
│   ├── doctor.sh                 # Installation health check
│   ├── make-executable.sh        # Make scripts executable
│   ├── setup.sh                  # Install dependencies
│   ├── start.sh                  # Start dev mode
│   ├── test.sh                   # Run tests
│   ├── install-cli.sh            # Install CLI
│   └── run.sh                    # Interactive menu
│
└── Setup Scripts (Windows)
    ├── setup.bat                 # Install dependencies
    ├── start.bat                 # Start dev mode
    ├── start-desktop.bat         # Launch desktop
    └── install-cli.bat           # Install CLI
```

---

## 🎯 Choose Your Path

**New to Bubbly?**  
→ Start with [README.md](README.md)

**Installing on Linux/macOS?**  
→ Read [INSTALL_UNIX.md](INSTALL_UNIX.md)

**Need command reference?**  
→ Check [PLATFORM_GUIDE.md](PLATFORM_GUIDE.md)

**Checking compatibility?**  
→ See [COMPATIBILITY.md](COMPATIBILITY.md)

**Quick platform decision?**  
→ See [CROSS_PLATFORM_SUMMARY.md](CROSS_PLATFORM_SUMMARY.md)

**Troubleshooting?**  
→ Run `./doctor.sh` or `./verify-platform.sh`

**Contributing?**  
→ Read [CONTRIBUTING.md](CONTRIBUTING.md)

---

**Welcome to Bubbly! 🫧**  
*A local-first AI coding agent that works everywhere.*
