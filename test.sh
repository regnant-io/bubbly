#!/usr/bin/env bash
# Run all tests for Bubbly
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BLUE}${BOLD}🧪 Running Bubbly Tests${NC}"
echo "════════════════════════════════════════"
echo ""

# Check if node_modules exist
if [ ! -d "backend/node_modules" ]; then
  echo -e "${RED}Backend dependencies not installed. Run ./setup.sh first${NC}"
  exit 1
fi

cd backend

echo -e "${BLUE}Running backend tests...${NC}"
echo ""

if npm test; then
  echo ""
  echo "════════════════════════════════════════"
  echo -e "${GREEN}${BOLD}✓ All tests passed!${NC}"
  echo ""
  exit 0
else
  echo ""
  echo "════════════════════════════════════════"
  echo -e "${RED}${BOLD}✗ Tests failed${NC}"
  echo ""
  exit 1
fi
