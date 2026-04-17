# 阿里云部署指南（IP 访问版）

> 本文档面向需要在阿里云服务器上通过**公网 IP 直接访问**本项目的用户。无需购买域名，也无需改动业务代码。

---

## 一、方案概述

本项目采用 **FastAPI + Next.js + SQLite + 本地文件存储**。由于后端依赖本地 SQLite 数据库和磁盘文件（`storage/` 目录），**最适合部署在带有持久化硬盘的云服务器上**。

**推荐机型**：
- 阿里云 **ECS 云服务器**（推荐，稳定可控）
- 阿里云 **轻量应用服务器**（性价比高，适合小团队验证）

> 不推荐：阿里云函数计算 FC、Serverless 应用引擎 SAE（无状态环境，不支持 SQLite 本地文件持久化）。

---

## 二、服务器选购建议

| 配置项 | 建议 | 说明 |
|--------|------|------|
| **CPU / 内存** | 2 核 4G 起步 | Next.js 构建和 Pillow 图像处理都占内存，4G 更稳妥 |
| **操作系统** | Ubuntu 22.04 LTS / 24.04 LTS | 文档和兼容性最好 |
| **带宽** | 3~5 Mbps 起步 | 需要上传/下载图片素材，带宽太低会卡 |
| **磁盘** | 40 GB 起步 | 存储 SQLite 数据库、项目素材、导出包 |
| **安全组** | 放行 TCP **22、80、3000、8000** | 22 用于 SSH；80/3000/8000 用于访问服务 |

购买完成后，记下服务器的**公网 IP 地址**（例如 `123.45.67.89`）。

---

## 三、环境准备

用 SSH 登录服务器后，依次执行以下命令安装依赖：

```bash
# 1. 更新系统
sudo apt update && sudo apt upgrade -y

# 2. 安装基础工具
sudo apt install -y git curl wget nginx

# 3. 安装 Python 及 pip
sudo apt install -y python3 python3-pip python3-venv

# 4. 安装 Node.js 20.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 5. 确认版本
python3 --version   # 建议 >= 3.10
node -v             # 建议 >= 20.x
npm -v
```

---

## 四、上传项目代码

### 方式 A：通过 Git 拉取（推荐）
```bash
cd /opt
sudo git clone <你的仓库地址> print
sudo chown -R $(whoami):$(whoami) print
cd print
```

### 方式 B：通过本地上传
使用 `scp`、`rsync` 或 FTP 工具把项目上传到服务器（例如 `/opt/print` 目录）：
```bash
# 在本地执行
scp -r /本地路径/print root@123.45.67.89:/opt/
```

---

## 五、环境变量配置（重要）

项目支持通过环境变量配置 AI 面料生成 provider 和外部服务接入。建议在生产环境创建 `.env` 文件：

```bash
cd /opt/print
sudo tee /opt/print/.env > /dev/null << 'EOFENV'
# AI 面料生成（可选，未配置时自动回退到本地占位图）
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
REPLICATE_API_TOKEN=xxxxxxxxxxxxxxxx

# Neodomain 生图服务接入（可选）
NEODOMAIN_ACCESS_TOKEN=xxxxxxxxxxxxxxxx
DEFAULT_MODEL_NAME=gemini-3-pro-image-preview
EOFENV
```

> 若使用 systemd 托管后端，需要在 service 文件中通过 `EnvironmentFile=/opt/print/.env` 加载这些变量（见下文）。

---

## 六、部署后端（FastAPI）

### 1. 安装 Python 依赖
```bash
cd /opt/print/apps/api
pip3 install -r requirements.txt
```

### 2. 验证后端能否启动
```bash
cd /opt/print
export $(grep -v '^#' .env | xargs)
cd apps/api
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```
- 看到 `Uvicorn running on http://0.0.0.0:8000` 即表示成功。
- 此时在浏览器访问 `http://<你的服务器IP>:8000/docs` 应能看到 Swagger 接口文档。
- **按 `Ctrl + C` 停止**。

> ⚠️ 注意：必须加 `--host 0.0.0.0`，否则外网无法访问。

### 3. 使用 systemd 后台托管（推荐）
生产环境建议用 systemd 管理，避免 SSH 断开后服务停止。

```bash
sudo tee /etc/systemd/system/print-api.service > /dev/null << 'EOFSYSTEMD'
[Unit]
Description=Print Studio API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/print/apps/api
EnvironmentFile=/opt/print/.env
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFSYSTEMD
```

启动并设为开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable print-api
sudo systemctl start print-api

# 查看状态
sudo systemctl status print-api
```

---

## 七、部署前端（Next.js）

### 1. 安装 npm 依赖
项目使用 npm workspaces，直接在根目录安装即可：
```bash
cd /opt/print
npm install
```

### 2. 配置前端 API 地址

项目通过 `NEXT_PUBLIC_API_BASE_URL` 环境变量指定后端地址。`next.config.mjs` 中默认使用 `http://127.0.0.1:8000`，与后端部署在同一台服务器时**通常无需修改**。

如果你希望显式配置（例如静态导出场景）：
```bash
export NEXT_PUBLIC_API_BASE_URL="http://123.45.67.89:8000"
```

### 3. 构建并启动前端

```bash
cd /opt/print/apps/web
npm run build
```

构建成功后，用生产模式启动：
```bash
nohup npx next start --port 3000 &
```

此时访问 `http://<你的服务器IP>:3000` 即可看到页面。

### 4. 使用 systemd 托管前端（推荐）

为避免 SSH 断开后前端停止，建议也配置 systemd：

```bash
sudo tee /etc/systemd/system/print-web.service > /dev/null << 'EOFSYSTEMD'
[Unit]
Description=Print Studio Web
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/print/apps/web
ExecStart=/usr/bin/npx next start --port 3000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOFSYSTEMD
```

启动并设为开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable print-web
sudo systemctl start print-web
sudo systemctl status print-web
```

---

## 八、使用 Nginx 反向代理（强烈推荐）

如果你不想让用户记忆 `3000`、`8000` 两个端口，可以用 **Nginx 统一代理到 80 端口**。用户只需要访问 `http://<你的服务器IP>` 即可。

### 1. 编辑 Nginx 配置
```bash
sudo tee /etc/nginx/sites-available/print > /dev/null << 'EOFNGINX'
server {
    listen 80;
    server_name _;  # 使用 IP 访问，无需域名

    client_max_body_size 100M;  # 允许上传较大图片（与后端 MAX_UPLOAD_BYTES 对齐）

    # 前端页面
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # API 接口（包含 /api/ 下所有路由，以及 neodomain 扩展路由）
    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # 文件资源
    location /files/ {
        proxy_pass http://127.0.0.1:8000/files/;
        proxy_set_header Host $host;
    }
}
EOFNGINX
```

### 2. 启用配置并重启 Nginx
```bash
sudo ln -sf /etc/nginx/sites-available/print /etc/nginx/sites-enabled/print
sudo nginx -t
sudo systemctl restart nginx
```

### 3. 测试访问
在浏览器打开：
```text
http://<你的服务器IP>
```

如果一切正常，你应该能看到完整的工作台页面。

---

## 九、防火墙 / 安全组配置

### 1. 阿里云安全组（必须）
登录阿里云控制台 → ECS → 安全组 → 配置规则，确保放行以下端口：

| 端口 | 用途 | 授权对象 |
|------|------|----------|
| 22 | SSH 远程登录 | 你的本地 IP（或 0.0.0.0/0） |
| 80 | Nginx HTTP 入口 | 0.0.0.0/0 |
| 3000 | Next.js 前端（未走 Nginx 时） | 0.0.0.0/0 |
| 8000 | FastAPI 后端（未走 Nginx 时） | 0.0.0.0/0 |

> 如果已经使用了 Nginx 反向代理，可以只保留 **22 和 80**，3000/8000 仅限内网访问更安全。

### 2. 服务器本地防火墙（可选）
如果开启了 `ufw`：
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 8000/tcp
sudo ufw reload
```

---

## 十、项目升级步骤

当代码有更新时，按以下步骤重新部署：

```bash
# 1. 进入项目目录
cd /opt/print

# 2. 拉取最新代码
git pull

# 3. 更新后端依赖（如有新增）
cd apps/api
pip3 install -r requirements.txt
cd /opt/print

# 4. 更新前端依赖并重新构建
npm install
cd apps/web
npm run build
cd /opt/print

# 5. 重启服务
sudo systemctl restart print-api
sudo systemctl restart print-web
```

> ⚠️ **重要**：`storage/` 目录包含 SQLite 数据库和所有用户数据，**升级时切勿删除或覆盖该目录**。如果通过 `scp` 或 `rsync` 上传代码，建议显式排除 `storage/` 和 `node_modules/`：
> ```bash
> rsync -av --exclude=storage --exclude=node_modules --exclude=.git ./ root@123.45.67.89:/opt/print/
> ```

---

## 十一、常见问题

### 1. 访问 `http://<IP>:3000` 页面空白或接口报错？
- 检查后端是否已启动：`curl http://127.0.0.1:8000/docs`
- 检查 `NEXT_PUBLIC_API_BASE_URL` 是否配置正确
- 检查安全组是否放行了 3000 和 8000 端口

### 2. 上传图片后报错 / 文件找不到？
- 检查 `storage/` 目录是否有写入权限：`ls -la /opt/print/storage`
- 确保运行用户（如 root 或 www-data）对项目目录有读写权限
- 检查 Nginx `client_max_body_size` 是否大于后端 `MAX_UPLOAD_BYTES`（100 MB）

### 3. 服务器重启后服务没自动启动？
- 后端：检查 systemd 是否启用 `sudo systemctl is-enabled print-api`
- 前端：检查 systemd 是否启用 `sudo systemctl is-enabled print-web`

### 4. 内存不足导致构建失败？
- Next.js 构建比较吃内存，2G 服务器容易 OOM
- 建议升级到 4G 内存，或临时加 swap：
  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  ```

### 5. AI 生图一直返回占位图？
- 检查 `.env` 中是否正确配置了 `OPENAI_API_KEY` 或 `REPLICATE_API_TOKEN`
- 检查 systemd 服务是否加载了 `EnvironmentFile=/opt/print/.env`
- 查看后端日志：`sudo journalctl -u print-api -f`

---

## 十二、最小改动清单

相比本地开发，部署到阿里云**只需以下调整**：

| 改动项 | 说明 |
|--------|------|
| 后端启动命令加 `--host 0.0.0.0` | 让外网可以访问 8000 端口 |
| 配置 `.env` 环境变量 | AI provider Token、Neodomain Token 等 |
| 可选：`NEXT_PUBLIC_API_BASE_URL` | 指定前端请求的后端地址 |
| 可选：Nginx 反向代理 | 统一 80 端口入口，隐藏 3000/8000 |
| **业务代码** | **完全不用改** |
