#!/usr/bin/env sh
# DSH InnateOS 启动器（Linux / macOS）。
# 优先启动打包产物（dist-package 下 linux-unpacked 或 *.app），找不到则回退 dev 模式。
# userData 固定为 live-user-data：保证 dev 模式与已保存的工作区 root，
# 不会落到首启的「选择使用方式」模式门。
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/innate-dogic/apps/desktop"
DIST="$APP_DIR/dist-package"
USER_DATA="$DIST/live-user-data"
mkdir -p "$USER_DATA"

# macOS：dist-package 里任意 *unpacked* 目录下的 .app 包
APP_BUNDLE="$(find "$DIST" -maxdepth 2 -name '*.app' -path '*unpacked*' 2>/dev/null | head -n 1 || true)"
if [ -n "$APP_BUNDLE" ]; then
  # 直接调二进制以透传 --user-data-dir（open -a 不好带参数）
  BIN_DIR="$APP_BUNDLE/Contents/MacOS"
  BIN="$(ls "$BIN_DIR" 2>/dev/null | head -n 1)"
  if [ -n "$BIN" ]; then
    echo "[launch] $BIN_DIR/$BIN"
    (cd "$ROOT" && exec "$BIN_DIR/$BIN" --user-data-dir="$USER_DATA") &
    exit 0
  fi
fi

# Linux：linux-unpacked 下的可执行文件（排除 .so 等库文件）
BIN="$(find "$DIST" -maxdepth 3 -type f -perm -u+x -path '*unpacked*' ! -name '*.so*' ! -name '*.dylib' 2>/dev/null | head -n 1 || true)"
if [ -n "$BIN" ]; then
  echo "[launch] $BIN"
  (cd "$ROOT" && exec "$BIN" --user-data-dir="$USER_DATA") &
  exit 0
fi

echo "[launch] 未找到打包产物，回退 dev 模式（Ctrl+C 退出）..."
cd "$APP_DIR"
exec npm run dev
