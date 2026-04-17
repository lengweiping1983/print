#!/bin/bash
set -e

echo "停止 Print Studio 服务..."
pkill -f "uvicorn app.main:app --host 0.0.0.0 --port 8000" 2>/dev/null && echo "后端已停止" || echo "后端未运行"
pkill -f "next start --port 3000" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 1
if ! pgrep -f "next-server" > /dev/null; then
    echo "前端已停止"
else
    echo "前端未运行"
fi
echo "完成"
