#!/usr/bin/env bash
#
# 一键打包 macOS dmg：装依赖（如缺）→ stage agent-browser → 类型检查 →
# 编译 → electron-builder 打 dmg/zip → 在 Finder 里定位产物。
#
#   ./scripts/dist-mac.sh             # 全流程
#   ./scripts/dist-mac.sh --no-check  # 跳过类型检查，其余不变
#
# Electron 运行时与 electron-builder 二进制固定走 npmmirror 镜像下载
# （直连 GitHub 容易超时）。产物在 release/，未签名（electron-builder.yml
# 里 identity: null），对外分发前需 Developer ID 签名 + 公证。

set -euo pipefail
cd "$(dirname "$0")/.."

TYPECHECK=1

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --no-check) TYPECHECK=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

if [ ! -d node_modules ]; then
  step "安装依赖"
  pnpm install
fi

step "Staging agent-browser 二进制"
node scripts/stage-agent-browser.mjs

if [ "$TYPECHECK" = 1 ]; then
  step "类型检查"
  pnpm typecheck
else
  step "跳过类型检查（--no-check）"
fi

step "编译（electron-vite build）"
pnpm build

step "打包 dmg（electron-builder）"
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
  pnpm exec electron-builder --mac

step "打包完成"
DMG="$(ls -t release/*.dmg 2>/dev/null | head -1)"
if [ -z "$DMG" ]; then
  echo "  没找到 dmg 产物，请检查上方 electron-builder 日志" >&2
  exit 1
fi
ls -lh release/*.dmg release/*.zip 2>/dev/null || true
echo "  Finder 定位：open -R \"$DMG\""
open -R "$DMG"
