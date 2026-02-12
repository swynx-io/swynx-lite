#!/bin/bash
# Swynx Lite installer
# Usage: curl -fsSL https://lite.swynx.io/install.sh | bash

set -euo pipefail

BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[1;96m'
RED='\033[1;31m'
GREEN='\033[1;32m'
RESET='\033[0m'

echo ""
echo -e "  ${CYAN}swynx lite${RESET} ${DIM}installer${RESET}"
echo ""

# ── Check Node.js ─────────────────────────────────────────

if ! command -v node &> /dev/null; then
  echo -e "  ${RED}Error:${RESET} Node.js is required but not installed."
  echo ""
  echo "  Install Node.js 18+ from https://nodejs.org"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${RED}Error:${RESET} Node.js 18+ is required (found v$(node -v | tr -d 'v'))"
  echo ""
  echo "  Upgrade at https://nodejs.org"
  echo ""
  exit 1
fi

# ── Check npm ─────────────────────────────────────────────

if ! command -v npm &> /dev/null; then
  echo -e "  ${RED}Error:${RESET} npm is required but not installed."
  echo ""
  exit 1
fi

# ── Install ───────────────────────────────────────────────

echo -e "  ${DIM}Installing swynx-lite globally via npm...${RESET}"
echo ""

npm install -g swynx-lite

echo ""
echo -e "  ${GREEN}Installed.${RESET}"
echo ""
echo -e "  ${BOLD}Quick start:${RESET}"
echo ""
echo "    cd your-project"
echo "    swynx-lite              # scan for dead code"
echo "    swynx-lite clean        # remove dead code (with undo)"
echo ""
echo -e "  ${DIM}Docs: https://lite.swynx.io${RESET}"
echo ""
