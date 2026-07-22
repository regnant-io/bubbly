#!/usr/bin/env bash
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BLUE}${BOLD}🫧  Bubbly Setup${NC}"
echo "════════════════════════════════════════"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org (v18+)${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}✗ Node.js v18+ required. Current: $(node -v)${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Check npm
if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ npm not found${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# Check optional: git
if command -v git &> /dev/null; then
  echo -e "${GREEN}✓ git $(git --version | cut -d' ' -f3)${NC}"
else
  echo -e "${YELLOW}⚠ git not found (git tools will be unavailable)${NC}"
fi

echo ""
echo -e "${BLUE}Installing backend dependencies...${NC}"
cd backend && npm install 2>&1 | tail -3
echo -e "${GREEN}✓ Backend ready${NC}"

echo ""
echo -e "${BLUE}Installing frontend dependencies...${NC}"
cd ../frontend && npm install 2>&1 | tail -3
echo -e "${GREEN}✓ Frontend ready${NC}"

echo ""
echo "════════════════════════════════════════"
echo -e "${GREEN}${BOLD}✓ Setup complete!${NC}"
echo ""
echo -e "Run: ${BOLD}./start.sh${NC}   to start Bubbly"
echo ""
