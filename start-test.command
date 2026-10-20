#!/usr/bin/env bash
#
# 启动一个「隔离的」测试实例：校验 → 构建 → 用独立的 userData 与数据目录运行。
#
#   ./start-test.command             # 校验 + 构建 + 启动（数据在 .tmp/test-home）
#   ./start-test.command --fresh     # 先清空 .tmp/test-home 再启动
#   ./start-test.command --no-build  # 跳过校验与构建，直接启动（改前端后用）
#   ./start-test.command --check     # 只做校验与构建，不启动
#
# 为什么需要这个脚本：正常启动会读写真实的 ~/.goodjob。测试实例通过
# GOODJOB_HOME / GOODJOB_DATA_DIR 把 Electron profile 和配置都挪到仓库内，
# 既不会污染真实配置，也不会和正在运行的真实应用抢单实例锁。
#
# macOS 上可以直接双击运行（.command 会用「终端」打开）。

set -euo pipefail
cd "$(dirname "$0")"

FRESH=0
BUILD=1
CHECK_ONLY=0

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --no-build) BUILD=0 ;;
    --check) CHECK_ONLY=1 ;;
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

TEST_HOME="$PWD/.tmp/test-home"
DATA_DIR="$TEST_HOME/data"
PID_FILE="$TEST_HOME/app.pid"
LOG_DIR="$PWD/logs"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

# 结束进程：先 TERM，最多等 2 秒，再 KILL。
kill_tree() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.4
  done
  kill -9 "$pid" 2>/dev/null || true
}

# 上一次没退干净会留下 app 进程，先按 pidfile 收掉。
# 兜底：Chromium 会把自己的 profile 路径写进 helper 的启动参数，
# 所以强杀过的实例也能按 user-data-dir 认出来。
stop_stale() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid}" ]; then
      echo "  发现上次残留的测试实例（pid ${pid}），先结束它"
      kill_tree "$pid"
    fi
    rm -f "$PID_FILE"
  fi
  pkill -f "$TEST_HOME/electron-profile" 2>/dev/null || true
}

stop_stale

if [ "$FRESH" = 1 ]; then
  step "清空测试环境"
  rm -rf "$TEST_HOME"
  echo "  已删除 $TEST_HOME"
fi

if [ ! -d node_modules ]; then
  step "安装依赖"
  pnpm install
fi

if [ "$BUILD" = 1 ]; then
  step "类型检查"
  pnpm typecheck

  step "构建"
  pnpm build
else
  step "跳过校验与构建（--no-build）"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n\033[32m✓ 校验与构建通过，未启动应用（--check）\033[0m\n'
  exit 0
fi

mkdir -p "$TEST_HOME" "$DATA_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/test-$(date +%Y%m%d-%H%M%S).log"

step "启动测试实例"
echo "  Electron profile : $TEST_HOME/electron-profile"
echo "  数据目录         : $DATA_DIR"
echo "  日志             : $LOG_FILE"
echo "  退出应用（Cmd+Q）后回到这里"

# 用独立 HOME 启动：单实例锁、缓存、配置都与真实安装互不干扰。
GOODJOB_HOME="$TEST_HOME" \
  GOODJOB_DATA_DIR="$DATA_DIR" \
  ./node_modules/.bin/electron . >"$LOG_FILE" 2>&1 &
APP_PID=$!
echo "$APP_PID" >"$PID_FILE"

cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

STATUS=0
wait "$APP_PID" || STATUS=$?

# Ctrl+C / kill 掉脚本不算异常，顺手把 app 一起收掉即可。
case "$STATUS" in
  130 | 143)
    printf '\n\033[32m✓ 已手动结束测试实例\033[0m\n'
    exit 0
    ;;
esac

if [ "$STATUS" -ne 0 ]; then
  step "应用异常退出（code ${STATUS}）"
  grep -v "sandbox_extension_issue_file" "$LOG_FILE" | tail -20 || true
  printf '\n完整日志：%s\n' "$LOG_FILE"
else
  printf '\n\033[32m✓ 应用已正常退出\033[0m\n'
  printf '日志：%s\n' "$LOG_FILE"
fi

# 双击运行时留住窗口，方便看输出。
if [ -t 0 ]; then
  printf '\n按回车关闭此窗口…'
  read -r _
fi

exit "$STATUS"
