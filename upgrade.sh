#!/bin/bash
# Hermes Web UI upgrade script for systemd-based deployments
# Usage: ./upgrade.sh [--check]
#   --check  Only report if an update is available; do not apply
set -euo pipefail

# Derive the repo directory from the script location, not a hardcoded path
WEBUI_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$WEBUI_DIR"

# Allow git to operate when the repo owner differs from the running user
git config --global --add safe.directory "$WEBUI_DIR" 2>/dev/null || true

# Detect the systemd service name (common variants: hermes-webui, hermes-web-ui)
SERVICE_NAME=""
for svc in hermes-webui hermes-web-ui; do
  if systemctl list-unit-files "${svc}.service" > /dev/null 2>&1; then
    SERVICE_NAME="$svc"
    break
  fi
done

current_version() {
  node -p "require('./package.json').version" 2>/dev/null || echo "unknown"
}

# Fetch latest from origin
git fetch origin main 2>&1

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "NO_UPDATE: Already at latest (v$(current_version))"
  exit 0
fi

if [ "${1:-}" = "--check" ]; then
  NEW_VERSION=$(git show origin/main:package.json | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).version")
  echo "UPDATE_AVAILABLE: v$(current_version) -> v$NEW_VERSION"
  exit 0
fi

PREV_VERSION="$(current_version)"
PREV_SHA="$LOCAL"

echo "=== Upgrading from v$PREV_VERSION ($PREV_SHA) ==="

# Stash any local changes so git pull does not fail
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "=== Stashing local changes ==="
  git stash push -m "auto-stash before upgrade $(date -Iseconds)" 2>&1
fi

echo "=== Pulling latest code ==="
git pull origin main 2>&1

echo "=== Installing dependencies ==="
npm install --include=dev 2>&1 | tail -5

echo "=== Building ==="
npm run build 2>&1 | tail -10

echo "=== Restarting server ==="
if [ -n "$SERVICE_NAME" ]; then
  # systemd-managed deployment: use systemctl to restart cleanly
  systemctl restart "$SERVICE_NAME"
  sleep 2
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "UPGRADE_COMPLETE: v$(current_version) (service: $SERVICE_NAME)"
  else
    echo "UPGRADE_FAILED: service $SERVICE_NAME did not start"
    echo "Attempting rollback..."
    git reset --hard "$PREV_SHA"
    npm run build 2>&1 | tail -5
    systemctl restart "$SERVICE_NAME"
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      echo "ROLLBACK_OK: reverted to v$PREV_VERSION"
    else
      echo "ROLLBACK_FAILED: service still down after rollback to $PREV_SHA"
    fi
    exit 1
  fi
else
  # Non-systemd fallback: kill and restart manually
  OLD_PID=$(pgrep -f "node.*dist/server/index.js" || true)
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
  PORT="${PORT:-6060}"
  UPSTREAM="${UPSTREAM:-http://127.0.0.1:8642}"
  HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
  NODE_ENV=production PORT="$PORT" UPSTREAM="$UPSTREAM" HERMES_HOME="$HERMES_HOME" \
    nohup node dist/server/index.js > /dev/null 2>&1 &
  sleep 3
  NEW_PID=$(pgrep -f "node.*dist/server/index.js" || true)
  if [ -n "$NEW_PID" ]; then
    echo "UPGRADE_COMPLETE: v$(current_version) (PID $NEW_PID)"
  else
    echo "UPGRADE_FAILED: server did not start"
    exit 1
  fi
fi
