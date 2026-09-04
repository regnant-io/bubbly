#!/usr/bin/env bash
# Universal startup script for Bubbly on Linux and macOS
# Automatically detects environment and runs appropriate setup

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
fi

echo ""
echo -e "${BLUE}${BOLD}🫧  Bubbly${NC}"
echo -e "Detected OS: ${GREEN}$OS${NC}"
echo "════════════════════════════════════════"
echo ""

# Check prerequisites
check_prerequisites() {
    local missing=0
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}✗ Node.js not found${NC}"
        missing=1
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -lt 18 ]; then
            echo -e "${RED}✗ Node.js v18+ required. Current: $(node -v)${NC}"
            missing=1
        else
            echo -e "${GREEN}✓ Node.js $(node -v)${NC}"
        fi
    fi
    
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}✗ npm not found${NC}"
        missing=1
    else
        echo -e "${GREEN}✓ npm $(npm -v)${NC}"
    fi
    
    if command -v git &> /dev/null; then
        echo -e "${GREEN}✓ git $(git --version | cut -d' ' -f3)${NC}"
    else
        echo -e "${YELLOW}⚠ git not found (optional but recommended)${NC}"
    fi
    
    return $missing
}

# OS-specific dependency checks
check_os_dependencies() {
    if [ "$OS" = "linux" ]; then
        echo ""
        echo -e "${BLUE}Checking Linux dependencies...${NC}"
        
        local missing_libs=()
        
        # Check for common GUI libraries
        if ! ldconfig -p 2>/dev/null | grep -q libgtk-3; then
            missing_libs+=("libgtk-3-0")
        fi
        
        if [ ${#missing_libs[@]} -gt 0 ]; then
            echo -e "${YELLOW}⚠ Missing libraries for desktop app:${NC}"
            for lib in "${missing_libs[@]}"; do
                echo "  - $lib"
            done
            echo ""
            echo "Install with:"
            if command -v apt-get &> /dev/null; then
                echo "  sudo apt-get install ${missing_libs[*]}"
            elif command -v dnf &> /dev/null; then
                echo "  sudo dnf install ${missing_libs[*]}"
            fi
            echo ""
        fi
    fi
}

# Main menu
show_menu() {
    echo ""
    echo "What would you like to do?"
    echo ""
    echo "  1) Setup (install dependencies)"
    echo "  2) Start development mode (backend + frontend)"
    echo "  3) Install CLI globally"
    echo "  4) Build desktop app for this platform"
    echo "  5) Run tests"
    echo "  6) Exit"
    echo ""
    read -p "Choose [1-6]: " choice
    
    case $choice in
        1)
            run_setup
            ;;
        2)
            run_dev
            ;;
        3)
            install_cli
            ;;
        4)
            build_desktop
            ;;
        5)
            run_tests
            ;;
        6)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid choice${NC}"
            show_menu
            ;;
    esac
}

run_setup() {
    echo ""
    echo -e "${BLUE}Running setup...${NC}"
    echo ""
    chmod +x setup.sh
    ./setup.sh
    
    echo ""
    read -p "Press Enter to continue..."
    show_menu
}

run_dev() {
    echo ""
    echo -e "${BLUE}Starting development mode...${NC}"
    echo ""
    
    if [ ! -d "backend/node_modules" ]; then
        echo -e "${YELLOW}Dependencies not installed. Running setup first...${NC}"
        chmod +x setup.sh
        ./setup.sh
    fi
    
    chmod +x start.sh
    ./start.sh
}

install_cli() {
    echo ""
    echo -e "${BLUE}Installing CLI...${NC}"
    echo ""
    chmod +x install-cli.sh
    ./install-cli.sh
    
    echo ""
    read -p "Press Enter to continue..."
    show_menu
}

build_desktop() {
    echo ""
    echo -e "${BLUE}Building desktop app for $OS...${NC}"
    echo ""
    
    if [ "$OS" = "linux" ]; then
        npm run dist:linux
    elif [ "$OS" = "macos" ]; then
        npm run dist:mac
    fi
    
    echo ""
    echo -e "${GREEN}Build complete! Check desktop/release/${NC}"
    echo ""
    read -p "Press Enter to continue..."
    show_menu
}

run_tests() {
    echo ""
    echo -e "${BLUE}Running tests...${NC}"
    echo ""
    chmod +x test.sh
    ./test.sh
    
    echo ""
    read -p "Press Enter to continue..."
    show_menu
}

# Main execution
if ! check_prerequisites; then
    echo ""
    echo -e "${RED}Please install missing prerequisites first.${NC}"
    echo ""
    
    if [ "$OS" = "linux" ]; then
        echo "On Ubuntu/Debian:"
        echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
        echo "  sudo apt-get install -y nodejs git"
        echo ""
        echo "On Fedora/RHEL:"
        echo "  sudo dnf install nodejs npm git"
    elif [ "$OS" = "macos" ]; then
        echo "On macOS:"
        echo "  brew install node git"
        echo ""
        echo "Or download from https://nodejs.org"
    fi
    
    exit 1
fi

check_os_dependencies
show_menu
