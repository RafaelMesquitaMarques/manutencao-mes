#!/bin/bash
# ─── Initial setup of the Kaizo MES project ──────────────────────────────────
# Run: bash scripts/setup.sh

set -e

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        Kaizo MES · Initial setup                         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Check dependencies
command -v docker   >/dev/null 2>&1 || { echo "❌  Docker not found. Install it from https://docs.docker.com/get-docker/"; exit 1; }
command -v git      >/dev/null 2>&1 || { echo "❌  Git not found."; exit 1; }

echo "✅  Docker and Git found"

# Create .env if it does not exist
if [ ! -f .env ]; then
    cp .env.example .env
    # Generate a random SECRET_KEY
    SECRET=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i.bak "s/change-this-key-in-production/$SECRET/" .env && rm -f .env.bak
    echo "✅  .env file created with a generated secret key"
else
    echo "ℹ️   .env file already exists, keeping the current settings"
fi

# Create the backups directory
mkdir -p backups
echo "✅  Backups directory created"

# Start the containers
echo ""
echo "🚀  Starting Docker containers..."
docker compose up -d --build

echo ""
echo "⏳  Waiting for the database to be ready..."
sleep 8

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅  Platform is running!                                ║"
echo "║                                                          ║"
echo "║  🌐  Frontend:  http://localhost                         ║"
echo "║  📡  API:       http://localhost/api                     ║"
echo "║  📚  API docs:  http://localhost/docs                    ║"
echo "║  🔌  MQTT:      localhost:1883                           ║"
echo "║                                                          ║"
echo "║  Stop:        docker compose down                        ║"
echo "║  Logs:        docker compose logs -f                     ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
