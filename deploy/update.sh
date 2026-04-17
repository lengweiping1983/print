#!/bin/bash
set -e

PROJECT_DIR="/opt/print"
API_DIR="$PROJECT_DIR/apps/api"
WEB_DIR="$PROJECT_DIR/apps/web"

echo "========================================"
echo "  Print Studio 自动更新部署脚本"
echo "========================================"

cd "$PROJECT_DIR"

# 1. 拉取最新代码
echo "[1/5] 拉取最新代码..."
git pull --rebase

# 2. 更新依赖
echo "[2/5] 更新 Python 依赖..."
pip3 install -r "$API_DIR/requirements.txt"

echo "[3/5] 更新 Node 依赖..."
npm install

# 4. 停止旧服务
echo "[4/5] 停止旧服务..."
"$PROJECT_DIR/deploy/stop.sh"
sleep 2

# 5. 重新启动
echo "[5/5] 重新构建并启动服务..."
"$PROJECT_DIR/deploy/start.sh"

echo ""
echo "========================================"
echo "  更新部署完成"
echo "========================================"
