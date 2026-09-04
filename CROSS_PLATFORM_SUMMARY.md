# Cross-Platform Support Summary

Bubbly runs natively on **Windows**, **macOS**, and **Linux** with full feature parity.

---

## Quick Platform Selection

| I want to... | Windows | macOS | Linux |
|--------------|---------|-------|-------|
| **Desktop App** | ✅ `.exe` installer | ✅ `.dmg` disk image | ✅ `.AppImage` / `.deb` / `.rpm` |
| **Terminal CLI** | ✅ PowerShell/cmd | ✅ bash/zsh | ✅ bash/zsh/fish |
| **Development** | ✅ Full support | ✅ Full support | ✅ Full support |
| **Build from source** | ✅ `npm run dist` | ✅ `npm run dist` | ✅ `npm run dist` |

---

## Installation Files by Platform

### 📁 Shell Scripts (Linux/macOS)

| Script | Purpose |
|--------|---------|
| `setup.sh` | Install dependencies for backend + frontend |
| `start.sh` | Start development mode (backend + frontend) |
| `install-cli.sh` | Install CLI globally |
| `test.sh` | Run all tests |
| `run.sh` | Interactive menu for all operations |
| `make-executable.sh` | Make all scripts executable |
| `verify-platform.sh` | Check system compatibility |

### 📁 Batch Scripts (Windows)

| Script | Purpose |
|--------|---------|
| `setup.bat` | Install dependencies for backend + frontend |
| `start.bat` | Start development mode (backend + frontend) |
| `start-desktop.bat` | Launch desktop app after building |
| `install-cli.bat` | Install CLI globally |

---

## Quick Start by Platform

### Linux

```bash
# 1. Clone and setup
git clone <repo> bubbly && cd bubbly
chmod +x *.sh

# 2. Verify system
./verify-platform.sh

# 3. Install and run
./setup.sh
./start.sh

# Access at http://localhost:3000
```

### macOS

```bash
# 1. Clone and setup
git clone <repo> bubbly && cd bubbly
chmod +x *.sh

# 2. Verify system
./verify-platform.sh

# 3. Install and run
./setup.sh
./start.sh

# Access at http://localhost:3000
```

### Windows

```cmd
REM 1. Clone and setup
git clone <repo> bubbly && cd bubbly

REM 2. Install and run
setup.bat
start.bat

REM Access at http://localhost:3000
```

---

## Platform-Specific Documentation

| Document | Description |
|----------|-------------|
| **README.md** | Main documentation (all platforms) |
| **INSTALL_UNIX.md** | Detailed Linux/macOS installation guide |
| **PLATFORM_GUIDE.md** | Cross-platform command reference |
| **COMPATIBILITY.md** | Complete compatibility matrix |
| **This file** | Quick summary for platform selection |

---

## Built Distributions

After running `npm run dist`, find installers in `desktop/release/`:

### Windows Builds
```
Bubbly-1.0.0-win-x64.exe          # Installer for 64-bit Windows
Bubbly-1.0.0-win-arm64.exe        # Installer for ARM64 Windows
Bubbly-1.0.0-win-x64-portable.exe # Portable version (no install)
```

### macOS Builds
```
Bubbly-1.0.0-mac-x64.dmg          # Intel Macs
Bubbly-1.0.0-mac-arm64.dmg        # Apple Silicon (M1/M2/M3)
Bubbly-1.0.0-mac-x64.zip          # Intel archive
Bubbly-1.0.0-mac-arm64.zip        # Apple Silicon archive
```

### Linux Builds
```
Bubbly-1.0.0-linux-x64.AppImage   # Universal (all distros)
Bubbly-1.0.0-linux-arm64.AppImage # ARM64 Linux
Bubbly-1.0.0-linux-x64.deb        # Debian/Ubuntu
Bubbly-1.0.0-linux-arm64.deb      # Debian/Ubuntu ARM
Bubbly-1.0.0-linux-x64.rpm        # Fedora/RHEL/CentOS
Bubbly-1.0.0-linux-x64.tar.gz     # Portable archive
Bubbly-1.0.0-linux-arm64.tar.gz   # Portable archive ARM
```

---

## Platform-Specific Features

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Native installer | ✅ NSIS | ✅ DMG | ✅ deb/rpm |
| Auto-update | 🚧 Planned | 🚧 Planned | Via package manager |
| Credential storage | ✅ Credential Mgr | ✅ Keychain | ✅ Secret Service |
| Terminal integration | ✅ PowerShell/cmd | ✅ Terminal.app | ✅ Various |
| Desktop integration | ✅ Start Menu | ✅ Applications | ✅ App menu |
| File associations | ✅ Supported | ✅ Supported | ✅ Supported |

---

## Building for Specific Platforms

### Build for Current Platform Only
```bash
npm run dist
```

### Build for Specific Platform
```bash
# Linux packages
npm run dist:linux

# macOS packages  
npm run dist:mac

# Windows packages
npm run dist:win
```

**Note**: Cross-compilation is limited:
- **Windows** can only build Windows packages
- **macOS** can only build macOS packages  
- **Linux** can only build Linux packages

Use GitHub Actions workflow for multi-platform builds.

---

## CI/CD Support

### GitHub Actions (Included)

**`.github/workflows/ci.yml`** - Tests on Ubuntu
- Runs on every push/PR
- Type checking
- Unit tests
- Build verification

**`.github/workflows/release.yml`** - Multi-platform builds
- Runs on version tags
- Builds Windows, macOS, Linux in parallel
- Creates GitHub release with all installers

### Adding Other CI Systems

The project uses standard npm commands, compatible with:
- GitLab CI
- Jenkins
- Travis CI
- CircleCI
- Any CI with Node.js support

---

## Development Environment Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **Node.js** | 18.0.0 | 20.x or later |
| **RAM** | 2 GB | 4 GB |
| **Disk** | 500 MB | 1 GB |
| **OS** | Win 10, macOS 11, any modern Linux | Latest stable |

---

## Testing on Different Platforms

### Automated Testing
```bash
# All platforms
npm run typecheck  # TypeScript checking
npm test          # Run test suite (backend)
```

### Manual Testing
```bash
# Development mode
./start.sh        # Linux/macOS
start.bat         # Windows

# Desktop app
npm run desktop   # All platforms

# CLI testing
bubbly doctor     # System check
bubbly            # Interactive mode
```

---

## Common Issues by Platform

### Linux
- **AppImage won't run**: Install `libfuse2`
- **Permission denied**: Run `chmod +x *.sh`
- **Missing dependencies**: Install build tools and GUI libraries

### macOS
- **Security warning**: Right-click app, select "Open"
- **Node not found**: Ensure Node in PATH
- **M1/M2/M3 slow**: Use arm64 build, not x64

### Windows
- **Antivirus blocks**: Add exception for Bubbly
- **PowerShell errors**: Run as Administrator
- **Node not found**: Add Node to system PATH

See **INSTALL_UNIX.md** and **PLATFORM_GUIDE.md** for detailed solutions.

---

## Architecture Support

| Architecture | Platform | Status |
|--------------|----------|--------|
| **x64** | Windows, macOS, Linux | ✅ Fully supported |
| **arm64** | Windows, macOS, Linux | ✅ Fully supported |
| **ia32** | Windows, Linux | ⚠️ Not tested |
| **armv7** | Linux | ⚠️ Not tested |

---

## Package Manager Compatibility

| Manager | Platform | Status |
|---------|----------|--------|
| **npm** | All | ✅ Primary |
| **apt** | Debian/Ubuntu | ✅ `.deb` package |
| **dnf/yum** | Fedora/RHEL | ✅ `.rpm` package |
| **Homebrew** | macOS/Linux | ⚠️ Manual install |
| **Chocolatey** | Windows | 🚧 Not yet packaged |
| **winget** | Windows | 🚧 Not yet packaged |

---

## Shell Compatibility

### Unix (Linux/macOS)
- **bash** - ✅ Fully supported (scripts use bash)
- **zsh** - ✅ Fully supported
- **fish** - ✅ Fully supported
- **dash** - ✅ POSIX compatible

### Windows
- **PowerShell** - ✅ Primary (5.1 and 7+)
- **cmd.exe** - ✅ Supported
- **Git Bash** - ⚠️ May have issues
- **WSL** - ✅ Use Linux instructions

---

## File System Considerations

| FS Type | Performance | Recommendation |
|---------|-------------|----------------|
| **NTFS** (Windows) | Good | ✅ Native |
| **APFS** (macOS) | Excellent | ✅ Native |
| **ext4** (Linux) | Excellent | ✅ Native |
| **btrfs** (Linux) | Good | ✅ Supported |
| **Network FS** | Poor | ❌ Use SSH workspace |

**Database**: SQLite performs best on local, native file systems.

---

## Environment Variables

### Setting API Keys

**Linux/macOS (bash/zsh):**
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

**All Platforms (.env file - recommended):**
```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your keys
```

---

## Port Configuration

Default ports:
- **Backend**: 3001
- **Frontend**: 3000

Change in:
- Backend: `backend/.env`
- Frontend: `frontend/vite.config.ts`

---

## Getting Help

- **General**: See `README.md`
- **Linux/macOS**: See `INSTALL_UNIX.md`
- **Commands**: See `PLATFORM_GUIDE.md`
- **Compatibility**: See `COMPATIBILITY.md`
- **Issues**: GitHub Issues

---

## Platform Testing Checklist

Before releasing, verify on each platform:

- [ ] Dependencies install cleanly
- [ ] Backend starts without errors
- [ ] Frontend builds and serves
- [ ] CLI commands work
- [ ] Desktop app builds
- [ ] Desktop app launches
- [ ] Database operations work
- [ ] File operations work
- [ ] Terminal integration works
- [ ] Credential storage works

---

## Contributing Platform Support

Want to improve platform support? Focus areas:

1. **Package managers**: Chocolatey (Windows), Homebrew (macOS)
2. **Auto-updates**: Electron-builder update support
3. **Platform testing**: Automated tests on macOS and Windows
4. **Documentation**: Platform-specific troubleshooting
5. **ARM support**: Testing on ARM Linux (Raspberry Pi, ARM servers)

See `CONTRIBUTING.md` for details.

---

## Summary

✅ **Bubbly works natively on Windows, macOS, and Linux**  
✅ **Full feature parity across all platforms**  
✅ **Simple, platform-appropriate installation**  
✅ **Active CI/CD for multi-platform builds**  
✅ **Comprehensive documentation per platform**

Choose your platform, follow the quick start, and you're ready to go! 🫧
