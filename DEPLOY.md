# 阿里云最简部署指南（2G 内存 · 无 Nginx）

> 针对 **2G 内存** 的轻量服务器，不部署 Nginx 等额外服务，直接暴露端口运行。

---

## 一、前置说明

- **服务器配置**：阿里云 ECS / 轻量应用服务器，**2G 内存**
- **操作系统**：Ubuntu 22.04 LTS / 24.04 LTS
- **访问方式**：浏览器直接访问 `http://<服务器IP>:3000`
- **无需修改源码**：`next.config.mjs` 中对后端的 rewrite 指向 `127.0.0.1:8000`，这在服务器内部是通的（rewrite 发生在 Next.js 服务端），**不需要写死外网 IP**

### ⚠️ 2G 内存必须做的一件事：加 Swap

Next.js 构建非常吃内存，2G 机器几乎一定会 OOM。`deploy/start.sh` 启动脚本会自动检测并创建 2G swap（包括写入 `/etc/fstab` 持久化）。

如果你希望手动提前创建，也可以执行：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

验证：
```bash
free -h
```
看到 `Swap: 2.0G` 即可。

---

## 二、环境准备

SSH 登录服务器后执行：

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装基础工具
sudo apt install -y git curl wget python3 python3-pip

# 安装 Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 确认版本
python3 --version   # >= 3.10
node -v             # >= 20.x
```

---

## 三、上传项目代码

```bash
cd /opt
# 方式 1：git 克隆
sudo git clone <你的仓库地址> print

# 方式 2：本机 scp 上传（在本地执行）
# scp -r /本地路径/print root@<你的IP>:/opt/

sudo chown -R $(whoami):$(whoami) /opt/print
cd /opt/print
```

---

## 四、配置环境变量

项目根目录已自带 `.env`，其中已写入 `NEODOMAIN_ACCESS_TOKEN`。如果你需要修改或补充其他 Token，编辑 `/opt/print/.env`：

```bash
cat > /opt/print/.env << 'EOF'
# Neodomain AI 生图服务（必须）
NEODOMAIN_ACCESS_TOKEN=eyJhbGciOiJIUzUxMiJ9.eyJ1c2VySWQiOiIyMDM4OTYyMTUwNjIxMjYxODI0IiwiZW1haWwiOiIxMzY2MTYyMTE2MCIsInVzZXJUeXBlIjoiUEVSU09OQUwiLCJzdWIiOiIyMDM4OTYyMTUwNjIxMjYxODI0IiwiaWF0IjoxNzc2MzMzOTIzLCJuYmYiOjE3NzYzMzM5MjMsImV4cCI6MTc3ODkyNTkyMywiaXNzIjoid2xpbmstc3lzdGVtIiwiYXVkIjpbIndsaW5rLWNsaWVudHMiXSwianRpIjoiZmZhMTg5MDMtZmQzZi00YmE3LTk0MDktZWEzMjA2YWY3MGM4In0.TXIgK8CMoKJRQY7RQL1l78EIgV7owZLevGY1Uk5mc0Mrpgwy84gMFvGSQQKjQepakv6qQbVQqU5Mx48UnAaGWA

# 可选：其他 AI provider
OPENAI_API_KEY=
REPLICATE_API_TOKEN=
EOF
```

> `.env` 已在 `.gitignore` 中，不会被提交到仓库。

---

## 五、安装依赖

```bash
cd /opt/print

# Python 依赖
pip3 install -r apps/api/requirements.txt

# Node 依赖
npm install
```

---

## 六、构建与启动（推荐一键脚本）

项目已提供一键启停脚本，适合简单部署：

```bash
cd /opt/print
./deploy/start.sh
```

脚本会帮你做以下事情：
1. 加载 `.env` 环境变量
2. 检查 swap（未配置会提示）
3. 启动后端 `uvicorn`（监听 `0.0.0.0:8000`）
4. 构建前端（限制 Node 内存为 1536MB，避免 OOM）
5. 启动前端 `next start`（监听 `0.0.0.0:3000`）
6. 输出访问地址和日志路径

停止服务：
```bash
./deploy/stop.sh
```

查看实时日志：
```bash
tail -f /opt/print/logs-api.log
tail -f /opt/print/logs-web.log
```

---

## 七、使用 systemd 托管（可选，更稳定）

如果你希望服务器重启后服务自动启动，可以配置 systemd。

### 后端服务
```bash
sudo tee /etc/systemd/system/print-api.service > /dev/null << 'EOF'
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
EOF
```

### 前端服务
```bash
sudo systemctl daemon-reload
sudo systemctl enable print-api
sudo systemctl start print-api

# 查看状态
sudo systemctl status print-api
```

### 4. 初始化数据说明
后端在**首次启动**时会自动执行 `init_db()`，完成以下初始化：
- 创建 SQLite 数据库表结构（`storage/print_studio.sqlite3`）
- 自动导入 **20 条默认面料/Logo 提示词**（10 条面料纹理 + 10 条 Logo 标识）

> 这些数据来源于 `apps/api/app/init_data/fabric_prompts.json`，通过 `INSERT ... ON CONFLICT(id) DO UPDATE` 写入数据库：新增记录会自动插入，已有记录会自动同步最新内容，已存在时不会重复插入。升级时无需额外操作。

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
sudo tee /etc/systemd/system/print-web.service > /dev/null << 'EOF'
[Unit]
Description=Print Studio Web
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/print/apps/web
Environment="NODE_OPTIONS=--max-old-space-size=1536"
Environment="NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8000"
ExecStartPre=/usr/bin/npm --prefix /opt/print run build
ExecStart=/usr/bin/npx next start --port 3000
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

### 启动并设为开机自启
```bash
sudo systemctl daemon-reload
sudo systemctl enable print-api print-web
sudo systemctl start print-api print-web

# 查看状态
sudo systemctl status print-api
sudo systemctl status print-web
```

---

## 八、防火墙 / 安全组配置

### 阿里云安全组（必须）
控制台 → ECS → 安全组 → 配置规则，放行：

| 端口 | 用途 | 授权对象 |
|------|------|----------|
| 22 | SSH | 你的本地 IP 或 0.0.0.0/0 |
| 3000 | Next.js 前端 | 0.0.0.0/0 |
| 8000 | FastAPI 后端 | 0.0.0.0/0 |

### 服务器本地防火墙（如果开了 ufw）
```bash
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 8000/tcp
sudo ufw reload
```

---

## 九、访问验证

在浏览器打开：

```text
http://<你的服务器IP>:3000
```

如果能看到工作台页面，说明部署成功。

后端接口文档：
```text
http://<你的服务器IP>:8000/docs
```

---

## 十、项目升级步骤

```bash
cd /opt/print

# 拉取最新代码
git pull

# 更新依赖
pip3 install -r apps/api/requirements.txt
npm install

# 重新构建并启动
./deploy/stop.sh
./deploy/start.sh
```

如果用 systemd：
```bash
cd /opt/print
git pull
pip3 install -r apps/api/requirements.txt
npm install
sudo systemctl restart print-api print-web
```

> ⚠️ **注意**：`storage/` 目录包含 SQLite 数据库和所有用户数据，升级时切勿删除或覆盖。

---

## 十一、内存优化贴士

| 优化项 | 说明 |
|--------|------|
| **Swap 2G** | 必须，避免构建或并发处理时 OOM |
| **限制 Node 内存** | 构建时设置 `NODE_OPTIONS=--max-old-space-size=1536` |
| **控制图片尺寸** | 后端 `MAX_UPLOAD_BYTES = 100MB`，上传超大图会占用大量内存 |
| **并发控制** | 后端任务队列 `ThreadPoolExecutor(max_workers=2)`，已设为较低值 |
| **定期清理** | `storage/projects/` 下的旧项目文件会累积，可定期清理释放磁盘 |

---

## 十二、常见问题

### Q1: 访问 `http://<IP>:3000` 页面能打开，但 API 请求报错？
- 检查后端是否启动：`curl http://127.0.0.1:8000/docs`
- 检查安全组是否放行了 8000 端口
- 检查后端日志：`tail -f /opt/print/logs-api.log`

### Q2: 前端构建时进程被 Kill？
- 几乎肯定是内存不足导致 OOM
- 先确认 swap 是否已开启：`free -h`
- 构建时是否设置了 `NODE_OPTIONS=--max-old-space-size=1536`

### Q3: AI 生图一直返回本地占位图？
- 检查 `/opt/print/.env` 中 `NEODOMAIN_ACCESS_TOKEN` 是否正确
- 检查启动脚本或 systemd 是否加载了 `.env`
- 查看后端日志确认具体报错

### Q4: 需要绑定域名或用 HTTPS 吗？
- 当前方案是纯 IP + 端口访问，无需域名
- 如需 HTTPS，最简单的方式是在阿里云控制台购买/上传 SSL 证书，通过 **SLB/ALB** 做 HTTPS 卸载，后端仍然保持 HTTP 3000/8000
- 也可以在服务器上加 Nginx 做反向代理和 HTTPS，但这会额外占用内存
