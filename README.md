# 服装裁片系统

## 2026 生产打样版

当前目录已经升级为一个可落地的前后端工程：

- `apps/api`：FastAPI 后端，使用 SQLite + 本地 `storage/` 文件存储，不依赖 Redis、S3 或 MinIO。
- `apps/web`：Next.js + React + TypeScript + Tailwind + Konva 工作台。
- `packages/shared-types`：前后端共享的 TypeScript 数据类型。
- `storage`：项目素材、裁片、纹理、导出包的本地存储目录。

核心链路：

1. 创建项目。
2. 上传透明 PNG/WebP 裁片模板。
3. 后端按 alpha 连通域拆裁片并保存 mask、bbox、坐标和 transform。
4. 上传图案、衣服参考图，或用 prompt 生成本地占位纹理。
5. 可选择生成镜像/offset 无缝大布料图。
6. 可选择启用全局一致坐标系，把整件衣服作为一张虚拟设计画布，再从同一张设计画布切出各裁片。
7. 在 Web 工作台里调节单裁片平移、缩放、旋转、镜像或全局取样区域。
8. 导出整套预览、单裁片透明 PNG、manifest 和 ZIP 打样包。

全局坐标系、架构流程、技术实现和适用场景详见 [`GLOBAL_COORDINATE_SYSTEM.md`](GLOBAL_COORDINATE_SYSTEM.md)。

启动方式：

```bash
# 后端
cd apps/api
python3 -m uvicorn app.main:app --reload --port 8000

# 前端，需先安装 npm 依赖
cd apps/web
npm install
npm run dev
```

生产部署（阿里云 ECS / 轻量服务器，直接使用 IP 访问，无需域名）：
- 详见 [`DEPLOY.md`](DEPLOY.md)，包含完整的安装、配置、Nginx 反向代理和升级步骤。
- **无需改动任何业务代码**（`db.py`、`image_ops.py` 等逻辑完全不用改）。

旧的纯前端原型已经移除，当前根目录只保留生产版 FastAPI + Next.js 工程相关文件。
