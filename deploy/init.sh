#!/bin/bash
set -e

PROJECT_DIR="/opt/print"

echo "========================================"
echo "  Print Studio 环境初始化脚本"
echo "  适用: Ubuntu 22.04+ 全新机器"
echo "========================================"

# 1. 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 请使用 root 用户运行此脚本"
    exit 1
fi

# 2. 加 swap（2G 内存机器必须）
if ! swapon --show | grep -q /swapfile; then
    echo "创建 2G swapfile..."
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    if ! grep -q "^/swapfile " /etc/fstab; then
        echo "/swapfile none swap sw 0 0" >> /etc/fstab
    fi
    echo "swap 已启用"
    free -h | grep -i swap
else
    echo "swap 已存在"
fi

# 3. 更新系统并安装基础工具
echo "安装系统依赖..."
apt update && apt upgrade -y
apt install -y git curl wget python3 python3-pip

# 4. 安装 Node.js 20.x
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "20" ]; then
    echo "安装 Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
else
    echo "Node.js 已安装: $(node -v)"
fi

# 5. 确认版本
echo ""
echo "环境版本确认:"
python3 --version
node -v
npm -v

# 6. 拉取代码（如果目录不存在）
if [ ! -d "$PROJECT_DIR/.git" ]; then
    echo ""
    echo "拉取项目代码到 $PROJECT_DIR ..."
    # 注意: 需要提前配置好 SSH key 或改为 HTTPS 地址
    git clone git@github.com:lengweiping1983/print.git "$PROJECT_DIR" || {
        echo "克隆失败，请检查 git 权限或手动上传代码"
        exit 1
    }
    chown -R "$(whoami):$(whoami)" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"

# 7. 安装项目依赖
echo ""
echo "安装 Python 依赖..."
pip3 install -r apps/api/requirements.txt

echo "安装 Node 依赖..."
npm install

# 8. 提示配置 .env
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo ""
    echo "========================================"
    echo "  初始化完成，请配置环境变量"
    echo "========================================"
    echo "请创建 $PROJECT_DIR/.env 并写入 NEODOMAIN_ACCESS_TOKEN 等配置"
    echo "参考: $PROJECT_DIR/apps/api/.env"
else
    echo ""
    echo "========================================"
    echo "  初始化完成"
    echo "========================================"
fi

echo "下一步: 运行 $PROJECT_DIR/deploy/start.sh 启动服务"
