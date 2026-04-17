#!/bin/bash
set -e

echo "停止 Print Studio 服务..."
pkill -f "uvicorn app.main:app --host 0.0.0.0 --port 8000" 2>/dev/null && echo "后端已停止" || echo "后端未运行"
pkill -f "next start --port 3000" 2>/dev/null && echo "前端已停止" || echo "前端未运行"
echo "完成"
