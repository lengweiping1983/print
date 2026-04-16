# Agent 项目指南

> 本文档面向 AI 编程助手。`print/` 是 **生产级服装裁片系统**，采用 FastAPI + Next.js 前后端分离架构，本地 SQLite + 文件存储，不依赖 Redis/S3。

---

## 项目概览

本项目实现了一条完整的服装印花打样工作流：

1. 创建项目并上传透明 PNG/WebP 裁片模板。
2. 后端按 alpha 连通域自动拆分裁片，保存 mask、bbox、坐标和 transform。
3. 上传图案/衣服参考图，或用 prompt 调用 AI 生图纹理。
4. 生成镜像或 offset 无缝大布料图。
5. 在 Web 工作台中调节单裁片的平移、缩放、旋转、镜像，支持画布直接拖拽。
6. 导出整套预览 PNG、单裁片透明 PNG、manifest JSON 和 ZIP 打样包。

---

## 技术栈

- **后端**：Python 3.x + FastAPI + Pillow + reportlab
- **前端**：Next.js 16 + React 19 + TypeScript 5.7 + Tailwind CSS 3.4
- **画布引擎**：Konva 9.x + react-konva 19.x
- **包管理**：npm workspaces（根目录统一管理）
- **存储**：本地 SQLite (`storage/print_studio.sqlite3`) + 文件系统 (`storage/projects/{project_id}`)
- **测试**：后端使用 pytest；前端使用 `tsc --noEmit` 做类型检查

---

## 目录结构

```text
print/
├── package.json                     # workspaces 根配置，含并发启动脚本
├── README.md                        # 中文项目说明
├── apps/
│   ├── api/                         # FastAPI 后端
│   │   ├── app/
│   │   │   ├── main.py              # FastAPI 路由与业务编排入口
│   │   │   ├── schemas.py           # Pydantic 请求/响应模型
│   │   │   ├── db.py                # SQLite 连接、schema、JSON 辅助
│   │   │   ├── image_ops.py         # Pillow 图像算法（拆片、无缝化、渲染）
│   │   │   ├── jobs.py              # 基于 ThreadPoolExecutor 的异步任务队列
│   │   │   ├── providers.py         # AI 纹理生成 provider（local / openai / replicate）
│   │   │   └── config.py            # 路径与常量配置
│   │   ├── tests/
│   │   │   ├── conftest.py          # pytest 路径注入
│   │   │   ├── test_api_preview.py  # API 集成测试（预览链路）
│   │   │   └── test_image_ops.py    # 图像操作单元测试
│   │   └── requirements.txt         # Python 依赖清单
│   │
│   └── web/                         # Next.js 前端
│       ├── app/
│       │   ├── layout.tsx           # 根布局（中文 lang）
│       │   ├── page.tsx             # 入口页，渲染 StudioPage
│       │   ├── globals.css          # Tailwind + 全局样式 + checkerboard 背景
│       │   └── templates/           # 模板套装配置管理页面
│       │       ├── page.tsx         # 套装列表
│       │       ├── new/page.tsx     # 新建套装
│       │       ├── [setId]/page.tsx # 套装详情（尺寸管理）
│       │       └── [setId]/sizes/[sizeId]/page.tsx # 尺寸裁片校正
│       ├── components/
│       │   ├── StudioPage.tsx       # 主业务页面：左侧素材/裁片、中间画布、右侧参数
│       │   └── KonvaWorkspace.tsx   # 双画布 Konva 工作区（单片校正 + 整套排版）
│       ├── lib/
│       │   └── api.ts               # 前端 API 封装与轮询工具
│       ├── next.config.mjs          # Next 配置，含 /api 和 /files 的 rewrite 代理
│       ├── tailwind.config.ts       # Tailwind 主题扩展（ink、mist、action 等色值）
│       └── tsconfig.json            # TS 严格模式，paths: @/* -> ./*
│
├── packages/
│   └── shared-types/
│       ├── package.json
│       └── src/index.ts             # 前后端共享的 TS 类型（Project、Piece、Texture、Job 等）
│
└── storage/                         # 运行时数据（已加入 .gitignore）
    ├── print_studio.sqlite3         # SQLite 数据库
    └── projects/                    # 项目文件：assets、pieces、textures、exports
```

---

## 启动与开发命令

```bash
# 安装依赖（从前端 workspace 角度）
npm install

# 同时启动前后端（推荐）
npm run dev
# 等价于：
#   npm run dev:api   -> cd apps/api && python3 -m uvicorn app.main:app --reload --port 8000
#   npm run dev:web   -> cd apps/web && next dev --port 3000

# 单独启动后端
cd apps/api
python3 -m uvicorn app.main:app --reload --port 8000

# 单独启动前端
cd apps/web
npm run dev
```

前端默认端口 `3000`，后端默认端口 `8000`。`next.config.mjs` 中将 `/api/*` 和 `/files/*` rewrite 到 `http://127.0.0.1:8000`，因此开发时前端页面直接访问相对路径即可。

---

## 测试命令

```bash
# 后端测试（ pytest ）
cd apps/api
python3 -m pytest

# 前端类型检查
cd apps/web
npm run typecheck
# 或从根目录：
npm run typecheck
```

---

## 后端架构详解

### FastAPI 路由分组

| 路由前缀 | 说明 |
|---------|------|
| `POST /api/projects` | 创建项目 |
| `GET /api/projects` / `GET /api/projects/{id}` | 查询项目列表/详情 |
| `POST /api/projects/{id}/assets` | 上传素材（template、pattern、garment_photo） |
| `POST /api/projects/{id}/templates/import` | 导入模板并按 alpha 拆裁片 |
| `GET /api/projects/{id}/pieces` | 列出裁片（按面积降序） |
| `PATCH /api/projects/{id}/pieces/{piece_id}` | 更新裁片 transform |
| `POST /api/projects/{id}/textures/generate` | 创建纹理生成任务 |
| `POST /api/projects/{id}/textures/{texture_id}/seamless` | 创建无缝化任务（mirror/offset） |
| `GET /api/projects/{id}/textures` | 列出纹理 |
| `POST /api/projects/{id}/render/preview` | 创建整套预览渲染任务 |
| `POST /api/projects/{id}/exports` | 创建导出 ZIP 任务 |
| `GET /api/jobs/{job_id}` | 查询任务状态 |
| `POST /api/template-sets` / `GET /api/template-sets` | 创建/查询模板套装 |
| `POST /api/template-sets/{id}/sizes/import` | 导入尺寸模板并自动拆片识别 |
| `GET /api/template-sets/{id}/piece-defs` | 获取套装级裁片定义 |
| `POST /api/projects/from-template-set` | 从已配置的套装+尺寸创建项目 |
| `/files/{path}` | 静态文件服务（挂载 `storage/`） |

### 任务队列（jobs.py）

- 使用 `concurrent.futures.ThreadPoolExecutor(max_workers=2)` 做后台任务执行。
- 任务类型：`texture_generate`、`texture_seamless`、`render_preview`、`export_render`。
- 任务状态：`queued -> running -> succeeded | failed`。
- 前端通过轮询 `/api/jobs/{job_id}` 获取结果（参考 `lib/api.ts` 中的 `waitForJob`）。

### 数据库（db.py）

SQLite 核心表：

- `projects`：项目基础信息（dpi、unit、canvas 尺寸、export_config）
- `assets`：上传的原始素材（kind、path、sha256、metadata）
- `pieces`：拆分后的裁片（mask_path、polygon、bbox、source_x/y、transform JSON）
- `textures`：纹理记录（source_path、seamless_path、provider、prompt）
- `jobs`：异步任务记录（status、progress、input/output JSON）
- `template_sets`：模板套装（名称、衣服类型、版本、基准尺寸 ID、design_canvas）
- `set_piece_defs`：套装级裁片定义（piece_role、name、sort_order、base_transform）
- `size_templates`：各尺寸模板实例（关联 template_sets，含 template_path、is_base）
- `size_template_pieces`：尺寸下的裁片几何实例（mask、bbox、scale_to_base、关联 piece_def_id）

所有 JSON 字段在 Python 层通过 `json.dumps` / `json.loads` 读写。

### 图像算法（image_ops.py）

- `extract_alpha_components`：基于 alpha 通道的 Flood Fill（四连通），过滤小于 `MIN_COMPONENT_AREA` (1000) 像素的噪点，输出单裁片 mask PNG。
- `match_pieces_to_base`（`template_ops.py`）：将新尺寸拆出的裁片按面积、长宽比、水平位置匹配到基准模板的 `piece_def_id`，并计算 `scale_to_base`。
- `make_mirror_tile`：2x2 镜像平铺生成无缝图。
- `make_offset_tile`：Offset 位移法生成无缝图。
- `render_piece`：按 transform（scale、rotation、mirror、offset）将纹理渲染到单裁片 mask 上。
- `render_layout`：将所有裁片按原始坐标回排，绘制边框与标签，输出整套预览。

### AI 纹理生成（providers.py）

支持三种 provider：

- `local`（默认）：生成带提示文字的几何占位图，不调用外部 API。
- `openai`：调用 `OPENAI_API_KEY` 和 `OPENAI_IMAGE_MODEL`（默认 `gpt-image-1`）。
- `replicate`：调用 `REPLICATE_API_TOKEN` 和 `REPLICATE_MODEL_VERSION` 轮询预测结果。

当环境变量未配置时，openai / replicate 会自动回退到 local 占位图，保证服务可用。

---

## 前端架构详解

### 页面与组件

- `StudioPage.tsx`：主页面，状态驱动。挂载时自动创建项目。核心状态包括 `project`、`pieces`、`textures`、`selectedPieceId`、`job`。支持"从模板套装创建"快捷入口。
- `KonvaWorkspace.tsx`：双画布交互区。
- `templates/*.tsx`：模板套装配置管理页面。支持上传多尺寸白底图、自动拆片识别、设定基准尺寸、手动修正裁片关联。
  - 左侧「单片校正」：显示当前选中裁片的 mask 轮廓 + 可拖拽的纹理图，支持鼠标拖动微调花位。
  - 右侧「整套排版」：按原始 source_x/source_y 显示所有裁片边框，可点击选中，支持缩放适配。

### API 客户端（lib/api.ts）

- 封装所有后端接口调用。
- `waitForJob`：以 650ms 间隔轮询任务状态，直到 `succeeded` 或 `failed`。

### 共享类型（packages/shared-types）

前后端对齐的核心类型：

- `Project`、`Asset`、`Piece`、`PieceTransform`、`Texture`、`Job`
- `TemplateSet`、`SetPieceDef`、`SizeTemplate`、`SizeTemplatePiece`

前端直接从 `@print-studio/shared-types` 导入；后端目前使用 Pydantic 独立定义（`schemas.py`），字段语义与共享类型保持一致。

---

## 开发约定

1. **语言**：所有 UI 文案、README、代码注释、变量标签均使用**简体中文**。
2. **编码**：UTF-8。
3. **前端框架**：React 函数组件 + Hooks，不使用类组件。
4. **样式**：Tailwind CSS 原子类为主，少量全局 CSS（`globals.css` 中的 `checkerboard`）。
5. **图标/图片**：本项目未引入图标库，按钮以文字标签为主。
6. **类型安全**：前端开启 TS `strict: true`；后端使用 Pydantic 做请求校验。
7. **文件存储**：所有持久化文件放在 `storage/` 下，路径通过 `config.py` 统一计算，禁止写项目源码目录。

---

## 安全与注意事项

- **CORS**：后端 `CORSMiddleware` 配置为 `allow_origins=["*"]`，公网部署需收紧。
- **静态文件**：`/files` 挂载了整个 `storage/` 目录，注意避免路径遍历。
- **API 密钥**：`OPENAI_API_KEY`、`REPLICATE_API_TOKEN` 通过环境变量读取，不会写入代码或数据库。
- **任务容错**：`jobs.py` 中捕获所有异常并将 traceback 写入 `jobs.error` 字段，防止后台线程崩溃导致服务不可用。
- **无认证**：当前版本未实现用户认证与权限隔离，仅作本地/内网打样使用。

---

## 常见修改场景指引

| 场景 | 目标文件 |
|------|---------|
| 新增/修改 API 接口 | `apps/api/app/main.py` + `apps/api/app/schemas.py` |
| 修改图像算法（拆片、无缝化、渲染） | `apps/api/app/image_ops.py` |
| 新增 AI 纹理 provider | `apps/api/app/providers.py` |
| 调整前端页面布局与交互 | `apps/web/components/StudioPage.tsx` |
| 调整画布行为（拖拽、缩放、选中） | `apps/web/components/KonvaWorkspace.tsx` |
| 新增前后端共享类型 | `packages/shared-types/src/index.ts` + `apps/api/app/schemas.py` |
| 修改任务调度逻辑 | `apps/api/app/jobs.py` |
| 修改数据库 schema | `apps/api/app/db.py`（注意已有数据的兼容性） |
| 新增/修改模板套装逻辑 | `apps/api/app/main.py` + `apps/api/app/template_ops.py` |
| 调整模板配置页面 | `apps/web/app/templates/**/*.tsx` |
