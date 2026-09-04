#!/usr/bin/env bash
# Platform verification script for Bubbly
# Checks system requirements and reports compatibility

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

ERRORS=0
WARNINGS=0

echo ""
echo -e "${BLUE}${BOLD}🫧  Bubbly Platform Verification${NC}"
echo "════════════════════════════════════════"
echo ""

# Detect OS and Architecture
detect_platform() {
    OS="unknown"
    ARCH=$(uname -m)
    
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
        if [ -f /etc/os-release ]; then
            DISTRO=$(grep "^ID=" /etc/os-release | cut -d'=' -f2 | tr -d '"')
            VERSION=$(grep "^VERSION_ID=" /etc/os-release | cut -d'=' -f2 | tr -d '"')
        fi
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
        DISTRO="macOS"
        VERSION=$(sw_vers -productVersion)
    fi
    
    echo -e "${BOLD}Platform Detection${NC}"
    echo -e "  OS: ${GREEN}$OS${NC}"
    [ -n "$DISTRO" ] && echo -e "  Distribution: ${GREEN}$DISTRO${NC}"
    [ -n "$VERSION" ] && echo -e "  Version: ${GREEN}$VERSION${NC}"
    echo -e "  Architecture: ${GREEN}$ARCH${NC}"
    echo ""
}

# Check Node.js
check_node() {
    echo -e "${BOLD}Node.js${NC}"
    
    if ! command -v node &> /dev/null; then
        echo -e "  ${RED}✗ Node.js not found${NC}"
        ERRORS=$((ERRORS + 1))
        return 1
    fi
    
    NODE_VERSION=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'v' -f2 | cut -d'.' -f1)
    
    if [ "$NODE_MAJOR" -lt 18 ]; then
        echo -e "  ${RED}✗ Node.js $NODE_VERSION (need 18+)${NC}"
        ERRORS=$((ERRORS + 1))
    elif [ "$NODE_MAJOR" -lt 20 ]; then
        echo -e "  ${YELLOW}⚠ Node.js $NODE_VERSION (20+ recommended)${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "  ${GREEN}✓ Node.js $NODE_VERSION${NC}"
    fi
}

# Check npm
check_npm() {
    echo -e "${BOLD}npm${NC}"
    
    if ! command -v npm &> /dev/null; then
        echo -e "  ${RED}✗ npm not found${NC}"
        ERRORS=$((ERRORS + 1))
        return 1
    fi
    
    NPM_VERSION=$(npm -v)
    echo -e "  ${GREEN}✓ npm $NPM_VERSION${NC}"
}

# Check git
check_git() {
    echo -e "${BOLD}git${NC}"
    
    if ! command -v git &> /dev/null; then
        echo -e "  ${YELLOW}⚠ git not found (optional but recommended)${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        GIT_VERSION=$(git --version | cut -d' ' -f3)
        echo -e "  ${GREEN}✓ git $GIT_VERSION${NC}"
    fi
}

# Check build tools
check_build_tools() {
    echo -e "${BOLD}Build Tools${NC}"
    
    if [ "$OS" = "linux" ]; then
        if command -v gcc &> /dev/null; then
            GCC_VERSION=$(gcc --version | head -n1 | awk '{print $NF}')
            echo -e "  ${GREEN}✓ gcc $GCC_VERSION${NC}"
        else
            echo -e "  ${YELLOW}⚠ gcc not found (needed for native modules)${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
        
        if command -v make &> /dev/null; then
            echo -e "  ${GREEN}✓ make$(make --version | head -n1 | awk '{print $NF}')${NC}"
        else
            echo -e "  ${YELLOW}⚠ make not found (needed for building)${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
        
        if command -v python3 &> /dev/null; then
            PYTHON_VERSION=$(python3 --version | awk '{print $2}')
            echo -e "  ${GREEN}✓ python3 $PYTHON_VERSION${NC}"
        else
            echo -e "  ${YELLOW}⚠ python3 not found (needed for node-gyp)${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    elif [ "$OS" = "macos" ]; then
        if xcode-select -p &> /dev/null; then
            echo -e "  ${GREEN}✓ Xcode Command Line Tools installed${NC}"
        else
            echo -e "  ${YELLOW}⚠ Xcode Command Line Tools not found${NC}"
            echo -e "    Install with: ${BOLD}xcode-select --install${NC}"
            WARNINGS=$((WARNINGS + 1))
        fi
    fi
}

# Check Linux GUI dependencies
check_linux_deps() {
    if [ "$OS" != "linux" ]; then
        return 0
    fi
    
    echo -e "${BOLD}Linux Desktop Dependencies${NC}"
    
    local missing=()
    
    # Check for GTK
    if ! ldconfig -p 2>/dev/null | grep -q libgtk-3; then
        missing+=("libgtk-3-0")
    fi
    
    # Check for libnotify
    if ! ldconfig -p 2>/dev/null | grep -q libnotify; then
        missing+=("libnotify4")
    fi
    
    # Check for NSS
    if ! ldconfig -p 2>/dev/null | grep -q libnss3; then
        missing+=("libnss3")
    fi
    
    if [ ${#missing[@]} -eq 0 ]; then
        echo -e "  ${GREEN}✓ All GUI libraries present${NC}"
    else
        echo -e "  ${YELLOW}⚠ Missing libraries for desktop app:${NC}"
        for lib in "${missing[@]}"; do
            echo -e "    - $lib"
        done
        echo ""
        echo -e "  Install command:"
        if command -v apt-get &> /dev/null; then
            echo -e "    ${BOLD}sudo apt-get install ${missing[*]}${NC}"
        elif command -v dnf &> /dev/null; then
            echo -e "    ${BOLD}sudo dnf install ${missing[*]}${NC}"
        elif command -v pacman &> /dev/null; then
            echo -e "    ${BOLD}sudo pacman -S ${missing[*]}${NC}"
        fi
        WARNINGS=$((WARNINGS + 1))
    fi
}

# Check disk space
check_disk_space() {
    echo -e "${BOLD}Disk Space${NC}"
    
    AVAILABLE_MB=$(df -m . | tail -1 | awk '{print $4}')
    
    if [ "$AVAILABLE_MB" -lt 500 ]; then
        echo -e "  ${RED}✗ Only ${AVAILABLE_MB}MB available (need 500MB+)${NC}"
        ERRORS=$((ERRORS + 1))
    elif [ "$AVAILABLE_MB" -lt 1000 ]; then
        echo -e "  ${YELLOW}⚠ ${AVAILABLE_MB}MB available (1GB+ recommended)${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "  ${GREEN}✓ ${AVAILABLE_MB}MB available${NC}"
    fi
}

# Check memory
check_memory() {
    echo -e "${BOLD}Memory${NC}"
    
    if [ "$OS" = "linux" ]; then
        TOTAL_MB=$(free -m | grep Mem: | awk '{print $2}')
    elif [ "$OS" = "macos" ]; then
        TOTAL_MB=$(($(sysctl -n hw.memsize) / 1024 / 1024))
    fi
    
    if [ "$TOTAL_MB" -lt 2048 ]; then
        echo -e "  ${RED}✗ Only ${TOTAL_MB}MB RAM (need 2GB+)${NC}"
        ERRORS=$((ERRORS + 1))
    elif [ "$TOTAL_MB" -lt 4096 ]; then
        echo -e "  ${YELLOW}⚠ ${TOTAL_MB}MB RAM (4GB+ recommended)${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "  ${GREEN}✓ ${TOTAL_MB}MB RAM${NC}"
    fi
}

# Check architecture support
check_architecture() {
    echo -e "${BOLD}Architecture Support${NC}"
    
    case "$ARCH" in
        x86_64|amd64)
            echo -e "  ${GREEN}✓ x64 - Fully supported${NC}"
            ;;
        aarch64|arm64)
            echo -e "  ${GREEN}✓ arm64 - Fully supported${NC}"
            ;;
        armv7l)
            echo -e "  ${YELLOW}⚠ ARMv7 - Not officially supported${NC}"
            WARNINGS=$((WARNINGS + 1))
            ;;
        i686|i386)
            echo -e "  ${YELLOW}⚠ 32-bit x86 - Not officially supported${NC}"
            WARNINGS=$((WARNINGS + 1))
            ;;
        *)
            echo -e "  ${RED}✗ Unknown architecture: $ARCH${NC}"
            ERRORS=$((ERRORS + 1))
            ;;
    esac
}

# Check shell
check_shell() {
    echo -e "${BOLD}Shell${NC}"
    
    SHELL_NAME=$(basename "$SHELL")
    echo -e "  Current: ${GREEN}$SHELL_NAME${NC}"
    
    if [ -f "setup.sh" ] && [ ! -x "setup.sh" ]; then
        echo -e "  ${YELLOW}⚠ Shell scripts not executable${NC}"
        echo -e "    Run: ${BOLD}chmod +x *.sh${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "  ${GREEN}✓ Scripts executable${NC}"
    fi
}

# Check ports availability
check_ports() {
    echo -e "${BOLD}Network Ports${NC}"
    
    if command -v lsof &> /dev/null; then
        if lsof -i:3000 &> /dev/null; then
            echo -e "  ${YELLOW}⚠ Port 3000 in use${NC}"
            WARNINGS=$((WARNINGS + 1))
        else
            echo -e "  ${GREEN}✓ Port 3000 available${NC}"
        fi
        
        if lsof -i:3001 &> /dev/null; then
            echo -e "  ${YELLOW}⚠ Port 3001 in use${NC}"
            WARNINGS=$((WARNINGS + 1))
        else
            echo -e "  ${GREEN}✓ Port 3001 available${NC}"
        fi
    else
        echo -e "  ${YELLOW}⚠ Cannot check ports (lsof not available)${NC}"
    fi
}

# Main execution
detect_platform
echo ""
check_node
check_npm
check_git
check_build_tools
check_linux_deps
check_disk_space
check_memory
check_architecture
check_shell
check_ports

# Summary
echo ""
echo "════════════════════════════════════════"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✓ All checks passed!${NC}"
    echo ""
    echo "Your system is ready to run Bubbly."
    echo ""
    echo "Next steps:"
    echo -e "  1. ${BOLD}./setup.sh${NC}  - Install dependencies"
    echo -e "  2. ${BOLD}./start.sh${NC}  - Start development mode"
    echo -e "  3. ${BOLD}npm run dist${NC} - Build desktop app"
    EXIT_CODE=0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}${BOLD}⚠ $WARNINGS warning(s)${NC}"
    echo ""
    echo "Your system will work but some features may be limited."
    echo "Review warnings above for details."
    EXIT_CODE=0
else
    echo -e "${RED}${BOLD}✗ $ERRORS error(s), $WARNINGS warning(s)${NC}"
    echo ""
    echo "Please fix the errors above before proceeding."
    EXIT_CODE=1
fi

echo ""
exit $EXIT_CODE
