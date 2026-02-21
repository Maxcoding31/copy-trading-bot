#!/bin/bash
# =============================================================
# VPS Setup Script for Solana Copy-Trading Bot
# Run this ON the VPS after cloning the repo
# Usage: bash setup-vps.sh
# =============================================================

set -e

echo "========================================="
echo "  Copy-Trading Bot - VPS Setup"
echo "========================================="

# 1. System updates
echo "[1/6] Updating system..."
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Install Node.js 20 LTS
echo "[2/6] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Install build tools (needed for better-sqlite3 native compilation)
echo "[3/6] Installing build tools..."
sudo apt-get install -y build-essential python3

# 4. Install pm2 globally
echo "[4/6] Installing pm2..."
sudo npm install -g pm2

# 5. Install project dependencies and build
echo "[5/6] Installing dependencies and building..."
npm install
npm run build

# 6. Create required directories
echo "[6/6] Creating directories..."
mkdir -p data logs

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "  Next steps:"
echo "  1. Create your .env file:  cp .env.example .env"
echo "  2. Edit it:                nano .env"
echo "  3. Start the bot:          pm2 start ecosystem.config.js"
echo "  4. Check status:           pm2 status"
echo "  5. View logs:              pm2 logs copy-bot"
echo "  6. Auto-start on reboot:   pm2 startup && pm2 save"
echo ""
