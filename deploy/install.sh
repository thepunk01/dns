#!/usr/bin/env bash
set -Eeuo pipefail

# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/deploy/install.sh \
#     | sudo bash -s -- --repo https://github.com/OWNER/REPO.git

APP_NAME="dns-guardian"
APP_DIR="${APP_DIR:-/opt/dns-guardian}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
SERVICE_NAME="dns-guardian"

log() {
  printf '[DNS Guardian] %s\n' "$*"
}

fail() {
  printf '[DNS Guardian] 安装失败：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法：
  install.sh --repo https://github.com/OWNER/REPO.git [选项]

选项：
  --repo URL       GitHub 仓库地址，必填
  --dir PATH       安装目录，默认 /opt/dns-guardian
  --branch NAME    Git 分支，默认 main
  --help           显示帮助

也可以通过环境变量设置：REPO_URL、APP_DIR、BRANCH。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || fail "--repo 缺少参数"
      REPO_URL="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || fail "--dir 缺少参数"
      APP_DIR="$2"
      shift 2
      ;;
    --branch)
      [ "$#" -ge 2 ] || fail "--branch 缺少参数"
      BRANCH="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[ -n "$REPO_URL" ] || {
  usage
  fail "必须提供 GitHub 仓库地址"
}

[ "$(id -u)" -eq 0 ] || fail "请使用 root 或 sudo 运行"

export DEBIAN_FRONTEND=noninteractive

install_base_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    log "检测到 Debian/Ubuntu 系统"
    apt-get update -y
    apt-get install -y ca-certificates curl git
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    log "检测到 Fedora/RHEL/Alma/Rocky 系统"
    dnf install -y ca-certificates curl git
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    log "检测到 CentOS/RHEL 系统"
    yum install -y ca-certificates curl git
    return
  fi

  if command -v apk >/dev/null 2>&1; then
    log "检测到 Alpine 系统"
    apk add --no-cache ca-certificates curl git bash
    return
  fi

  command -v curl >/dev/null 2>&1 || fail "未找到受支持的包管理器，也没有 curl"
  command -v git >/dev/null 2>&1 || fail "未找到受支持的包管理器，也没有 git"
  log "未识别发行版，继续使用现有系统工具"
}

install_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
    log "Node.js 版本满足要求：$(node --version)"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log "安装 Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    log "安装 Node.js 22"
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y nodejs
    else
      yum install -y nodejs
    fi
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  else
    fail "无法自动安装 Node.js，请先安装 Node.js 20 或更高版本"
  fi

  command -v node >/dev/null 2>&1 || fail "Node.js 安装后仍不可用"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || \
    fail "Node.js 版本低于 20：$(node --version)"
}

sync_source() {
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then
    log "更新已有项目：$APP_DIR"
    git -C "$APP_DIR" fetch origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  else
    log "克隆项目到：$APP_DIR"
    [ ! -e "$APP_DIR" ] || fail "$APP_DIR 已存在但不是 Git 仓库"
    git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  fi
}

configure_app() {
  cd "$APP_DIR"
  [ -f .env ] || cp .env.example .env
  mkdir -p data
  chmod +x deploy/update.sh
  npm install --omit=dev
}

install_systemd_service() {
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    return 1
  fi

  local node_bin
  node_bin="$(command -v node)"
  sed \
    -e "s|/opt/dns-guardian|$APP_DIR|g" \
    -e "s|/usr/bin/node|$node_bin|g" \
    "$APP_DIR/deploy/dns-guardian.service" \
    > "/etc/systemd/system/${SERVICE_NAME}.service"

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  log "systemd 服务已启动：$SERVICE_NAME"
  return 0
}

start_without_systemd() {
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$APP_DIR/data"

  if [ -f "$APP_DIR/data/dns-guardian.pid" ]; then
    kill "$(cat "$APP_DIR/data/dns-guardian.pid")" 2>/dev/null || true
  fi

  nohup "$node_bin" "$APP_DIR/server.js" \
    >> "$APP_DIR/data/dns-guardian.log" 2>&1 < /dev/null &
  echo "$!" > "$APP_DIR/data/dns-guardian.pid"
  log "当前系统没有 systemd，已使用后台进程启动"
}

main() {
  install_base_packages
  install_node
  sync_source
  configure_app

  if ! install_systemd_service; then
    start_without_systemd
  fi

  cat <<EOF

安装完成。
管理地址：http://服务器IP:8787
配置文件：$APP_DIR/.env
更新命令：sudo bash $APP_DIR/deploy/update.sh
查看日志：sudo journalctl -u $SERVICE_NAME -f
EOF
}

main "$@"
