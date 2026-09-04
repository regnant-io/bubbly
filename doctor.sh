#!/usr/bin/env bash
# Bubbly Doctor - Quick health check for your installation
# Similar to 'bubbly doctor' but works before CLI is installed

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BLUE}${BOLD}🫧  Bubbly Doctor${NC}"
echo "════════════════════════════════════════"
echo ""

CHECKS_PASSED=0
CHECKS_FAILED=0

check() {
    local name="$1"
    local command="$2"
    
    if eval "$command" &> /dev/null; then
        echo -e "${GREEN}✓${NC} $name"
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $name"
        CHECKS_FAILED=$((CHECKS_FAILED + 1))
        return 1
    fi
}

check_with_version() {
    local name="$1"
    local command="$2"
    local version_command="$3"
    
    if command -v "$command" &> /dev/null; then
        local version=$($version_command 2>&1 | head -n1)
        echo -e "${GREEN}✓${NC} $name: $version"
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗${NC} $name: not found"
        CHECKS_FAILED=$((CHECKS_FAILED + 1))
        return 1
    fi
}

# Core requirements
echo -e "${BOLD}Core Requirements:${NC}"
check_with_version "Node.js" "node" "node -v"
check_with_version "npm" "npm" "npm -v"
check_with_version "git" "git" "git --version"
echo ""

# Project structure
echo -e "${BOLD}Project Structure:${NC}"
check "Backend directory" "[ -d backend ]"
check "Frontend directory" "[ -d frontend ]"
check "CLI directory" "[ -d cli ]"
check "Desktop directory" "[ -d desktop ]"
echo ""

# Dependencies installed
echo -e "${BOLD}Dependencies:${NC}"
check "Backend node_modules" "[ -d backend/node_modules ]"
check "Frontend node_modules" "[ -d frontend/node_modules ]"
check "CLI node_modules" "[ -d cli/node_modules ]"
echo ""

# Configuration
echo -e "${BOLD}Configuration:${NC}"
check "Backend .env file" "[ -f backend/.env ]"
check "Backend .env.example" "[ -f backend/.env.example ]"
echo ""

# Built artifacts
echo -e "${BOLD}Build Artifacts:${NC}"
check "Backend compiled" "[ -d backend/dist ]"
check "Frontend compiled" "[ -d frontend/dist ]"
check "CLI compiled" "[ -d cli/dist ]"
echo ""

# Scripts executable
echo -e "${BOLD}Shell Scripts:${NC}"
check "setup.sh executable" "[ -x setup.sh ]"
check "start.sh executable" "[ -x start.sh ]"
check "install-cli.sh executable" "[ -x install-cli.sh ]"
echo ""

# Network ports
echo -e "${BOLD}Network Ports:${NC}"
if command -v lsof &> /dev/null; then
    if lsof -i:3000 &> /dev/null; then
        echo -e "${YELLOW}⚠${NC} Port 3000 in use"
    else
        echo -e "${GREEN}✓${NC} Port 3000 available"
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
    
    if lsof -i:3001 &> /dev/null; then
        echo -e "${YELLOW}⚠${NC} Port 3001 in use"
    else
        echo -e "${GREEN}✓${NC} Port 3001 available"
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
else
    echo -e "${YELLOW}⚠${NC} Cannot check ports (lsof not available)"
fi
echo ""

# Summary
echo "════════════════════════════════════════"
TOTAL=$((CHECKS_PASSED + CHECKS_FAILED))
echo -e "${BOLD}Results: ${GREEN}$CHECKS_PASSED passed${NC}, ${RED}$CHECKS_FAILED failed${NC} (of $TOTAL)${NC}"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✓ Everything looks good!${NC}"
    echo ""
    echo "Ready to:"
    echo -e "  • Start dev mode: ${BOLD}./start.sh${NC}"
    echo -e "  • Build desktop: ${BOLD}npm run dist${NC}"
    echo -e "  • Run tests: ${BOLD}./test.sh${NC}"
elif [ $CHECKS_FAILED -le 3 ]; then
    echo -e "${YELLOW}${BOLD}⚠ Some issues detected${NC}"
    echo ""
    echo "Suggested fixes:"
    [ ! -d "backend/node_modules" ] && echo -e "  • Run ${BOLD}./setup.sh${NC} to install dependencies"
    [ ! -x "setup.sh" ] && echo -e "  • Run ${BOLD}chmod +x *.sh${NC} to make scripts executable"
    [ ! -f "backend/.env" ] && echo -e "  • Run ${BOLD}cp backend/.env.example backend/.env${NC}"
else
    echo -e "${RED}${BOLD}✗ Multiple issues detected${NC}"
    echo ""
    echo "Please:"
    echo -e "  1. Run ${BOLD}./verify-platform.sh${NC} for detailed diagnosis"
    echo -e "  2. Review ${BOLD}INSTALL_UNIX.md${NC} for setup instructions"
    echo -e "  3. Run ${BOLD}./setup.sh${NC} to install dependencies"
fi

echo ""
exit $CHECKS_FAILED
