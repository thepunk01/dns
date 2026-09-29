#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dns-guardian}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-dns-guardian}"

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl restart "$SERVICE_NAME"
else
  NODE_BIN="$(command -v node)"
  if [ -f "$APP_DIR/data/dns-guardian.pid" ]; then
    kill "$(cat "$APP_DIR/data/dns-guardian.pid")" 2>/dev/null || true
  fi
  nohup "$NODE_BIN" "$APP_DIR/server.js" \
    >> "$APP_DIR/data/dns-guardian.log" 2>&1 < /dev/null &
  echo "$!" > "$APP_DIR/data/dns-guardian.pid"
  echo "未检测到已启用的 systemd 服务，已使用后台进程重启。"
fi

echo "DNS Guardian 已更新到：$(git rev-parse --short HEAD)"
