#!/bin/bash
# start.sh — 启动聊天服务器
# 使用方法: chmod +x start.sh && ./start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR"

# 环境变量配置
export HOST="114.212.122.10"
export PORT="5005"
export CHAT_SECRET_KEY="change-this-to-a-real-secret-key"
export DB_PATH="chat.db"
export BOX_REPO_ID="26fa0b5f-a7e0-429f-9d7f-8ecda8ef1a66"
export BOX_TOKEN_FILE="/tmp/box_token_raw.txt"
export HERMES_API_BASE="http://127.0.0.1:8080"
export HERMES_API_KEY=""
export HERMES_AUTO_REPLY="true"

echo "=== 聊天服务器启动 ==="
echo "服务器地址: http://$HOST:$PORT"
echo "数据库路径: $DB_PATH"
echo "NJU Box 仓库: $BOX_REPO_ID"
echo "Hermes API: $HERMES_API_BASE"
echo "自动回复: $HERMES_AUTO_REPLY"
echo ""

cd "$SCRIPT_DIR"
# Use hermes-agent venv Python which has Flask and all dependencies
PYTHON3="/home/dmt/.hermes/hermes-agent/venv/bin/python3"

# Read token from file if exists
if [ -f "/tmp/box_token_raw.txt" ]; then
    export BOX_TOKEN_RAW=$(cat /tmp/box_token_raw.txt)
fi

exec "$PYTHON3" app.py
