#!/usr/bin/env bash
#
# 启动桌面端开发环境：
#   ./dev.sh           # 前台运行，Ctrl+C 退出
#   ./dev.sh --clean   # 先清理残留的 electron / vite 进程
#
# 原理：electron-vite dev 会同时构建 main / preload 并启动 Vite 开发服务器（1420），
# 然后拉起 Electron。渲染层热更新，main / preload 改动会自动重启窗口。

set -euo pipefail
cd "$(dirname "$0")"

PORT=1420

clean_stale() {
  if lsof -ti :"$PORT" >/dev/null 2>&1; then
    echo "[dev] 端口 $PORT 被占用，清理残留 Vite 进程…"
    lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
  fi
  if pgrep -f "node_modules/electron/dist/Electron.app" >/dev/null 2>&1; then
    echo "[dev] 清理残留的 Electron 进程…"
    pkill -f "node_modules/electron/dist/Electron.app" 2>/dev/null || true
  fi
}

case "${1:-}" in
  --clean)
    clean_stale
    echo "[dev] 清理完成"
    exit 0
    ;;
esac

clean_stale

if [ ! -d node_modules ]; then
  echo "[dev] 安装依赖…"
  pnpm install
fi

echo "[dev] 启动桌面端开发环境"
exec pnpm dev
