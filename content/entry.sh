#!/bin/sh
# wanspilot 容器入口。
#
# 容器内以 `entrypoint: /bin/sh /lzcapp/pkg/content/entry.sh` 启动，
# 本机调试时直接 `sh content/entry.sh` 也能跑，所以用脚本自身位置解析代码目录。
set -e

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export WP_DATA_DIR="${WP_DATA_DIR:-/data}"
export WP_DOWNLOAD_DIR="${WP_DOWNLOAD_DIR:-/downloads}"
export WP_CACHE_DIR="${WP_CACHE_DIR:-/cache/wanspilot}"
export WP_PORT="${WP_PORT:-3000}"

# /lzcapp/var 与 /lzcapp/cache 之外的目录重启即丢，所以只在这些位置建目录。
mkdir -p "$WP_DATA_DIR/logs" "$WP_CACHE_DIR" "$WP_DOWNLOAD_DIR" 2>/dev/null || true

echo "[entry] wanspilot starting: data=$WP_DATA_DIR downloads=$WP_DOWNLOAD_DIR port=$WP_PORT"

# exec 让 node 成为 PID 1 的子进程，平台发来的 SIGTERM 能直接到达并触发优雅退出。
exec node --max-old-space-size=768 "$SELF_DIR/server/index.mjs"
