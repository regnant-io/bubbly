#!/usr/bin/env bash
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down Bubbly...${NC}"
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM

echo ""
echo -e "${BLUE}${BOLD}🫧  Starting Bubbly${NC}"
echo ""

# Check if node_modules exist
if [ ! -d "backend/node_modules" ] || [ ! -d "frontend/node_modules" ]; then
  echo -e "${YELLOW}Dependencies not installed. Running setup...${NC}"
  ./setup.sh
fi

# Copy .env if not present
if [ ! -f "backend/.env" ] && [ -f "backend/.env.example" ]; then
  cp backend/.env.example backend/.env
  echo -e "${YELLOW}Created backend/.env from .env.example${NC}"
fi

echo -e "${BLUE}Starting backend (port 3001)...${NC}"
cd backend && npm run dev 2>&1 &
BACKEND_PID=$!
cd ..

# Wait for backend to start
sleep 2

echo -e "${BLUE}Starting frontend (port 3000)...${NC}"
cd frontend && npm run dev 2>&1 &
FRONTEND_PID=$!
cd ..

sleep 2

echo ""
echo "════════════════════════════════════════"
echo -e "${GREEN}${BOLD}🫧  Bubbly is running!${NC}"
echo ""
echo -e "  Open: ${BOLD}http://localhost:3000${NC}"
echo ""
echo -e "  ${YELLOW}First time? Go to Settings (gear icon) and set:${NC}"
echo -e "    • Your workspace path"
echo -e "    • Anthropic API key (for Claude) or Ollama URL"
echo ""
echo -e "  Press ${BOLD}Ctrl+C${NC} to stop"
echo "════════════════════════════════════════"
echo ""

# Wait for either process to exit
wait $BACKEND_PID $FRONTEND_PID
