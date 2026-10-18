#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

LOG_FILE="$PROJECT_ROOT/update.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=========================================="
echo " Cloudix System Update"
echo " Started: $(date)"
echo "=========================================="

echo "[1/4] Pulling latest changes from Git..."
git fetch --all
git reset --hard origin/main

echo "[2/4] Building backend..."
cd "$PROJECT_ROOT/backend"
npm install
npx prisma generate
npm run build
npx prisma migrate deploy

echo "[3/4] Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
npm run build

echo "[4/4] Restarting services..."
cd "$PROJECT_ROOT"
if command -v pm2 >/dev/null 2>&1; then
  echo "Restarting via PM2..."
  pm2 restart cloudix-backend || pm2 restart all || true
elif command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  echo "Restarting Docker containers..."
  docker compose down && docker compose up -d --build
else
  echo "Update complete. Please restart your running backend/frontend processes."
fi

echo "=========================================="
echo " Cloudix System Update Completed Successfully"
echo " Finished: $(date)"
echo "=========================================="
