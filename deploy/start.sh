#!/bin/bash
set -e

PROJECT_DIR="/opt/print"
API_DIR="$PROJECT_DIR/apps/api"
WEB_DIR="$PROJECT_DIR/apps/web"

echo "========================================"
echo "  Print Studio 最简启动脚本"
echo "========================================"

# 1. 加载环境变量
if [ -f "$PROJECT_DIR/.env" ]; then
    echo "加载环境变量: $PROJECT_DIR/.env"
    export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
elif [ -f "$API_DIR/.env" ]; then
    echo "加载环境变量: $API_DIR/.env"
    export $(grep -v '^#' "$API_DIR/.env" | xargs)
else
    echo "警告: 未找到 .env 文件，AI 生图等功能可能无法使用"
fi

# 2. 自动检查并添加 swap（2G 内存机器必须）
SWAP_TOTAL=$(free -m | awk '/Swap:/ {print $2}')
if [ "$SWAP_TOTAL" = "0" ] || [ -z "$SWAP_TOTAL" ]; then
    echo "检测到系统没有 swap，正在自动创建 2G swapfile..."
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    # 持久化到 /etc/fstab（如果还没有写入）
    if ! grep -q "^/swapfile " /etc/fstab; then
        echo "/swapfile none swap sw 0 0" >> /etc/fstab
    fi
    echo "swap 创建完成"
    free -h | grep -i swap
else
    echo "swap 已存在: ${SWAP_TOTAL}MB"
fi

# 3. 停止已有的服务（如果存在）
echo "尝试停止已有进程..."
pkill -f "uvicorn app.main:app --host 0.0.0.0 --port 8000" 2>/dev/null || true
pkill -f "next start --port 3000" 2>/dev/null || true
sleep 2

# 4. 启动后端
echo "启动后端 FastAPI (0.0.0.0:8000)..."
cd "$API_DIR"
nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > "$PROJECT_DIR/logs-api.log" 2>&1 &
API_PID=$!
echo "后端 PID: $API_PID"

# 5. 构建前端（限制Node内存避免OOM）
echo "构建前端（限制 Node 内存为 1536MB）..."
cd "$WEB_DIR"
export NODE_OPTIONS="--max-old-space-size=1536"
npm run build

# 6. 启动前端
echo "启动前端 Next.js (0.0.0.0:3000)..."
nohup npx next start --port 3000 > "$PROJECT_DIR/logs-web.log" 2>&1 &
WEB_PID=$!
echo "前端 PID: $WEB_PID"

# 7. 等待后端就绪
sleep 3
if curl -s http://127.0.0.1:8000/docs > /dev/null; then
    echo "后端健康检查通过"
else
    echo "后端可能尚未就绪，请查看日志: $PROJECT_DIR/logs-api.log"
fi

# 8. 输出访问信息
echo ""
echo "========================================"
echo "  启动完成"
echo "========================================"
echo "前端地址: http://<你的服务器IP>:3000"
echo "后端地址: http://<你的服务器IP>:8000/docs"
echo "后端日志: tail -f $PROJECT_DIR/logs-api.log"
echo "前端日志: tail -f $PROJECT_DIR/logs-web.log"
echo ""
echo "提示: 安全组需放行 3000 和 8000 端口"
