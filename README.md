# 服装裁片贴图系统

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
5. 生成镜像/offset 无缝大布料图。
6. 在 Web 工作台里调节单裁片平移、缩放、旋转、镜像。
7. 导出整套预览、单裁片透明 PNG、manifest 和 ZIP 打样包。

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

旧的纯前端原型仍保留在根目录的 `index.html`、`app.js`、`styles.css` 中，可继续作为算法验证参考。

---

## 旧版纯前端原型说明

这是一个纯前端、可直接运行的最小可落地版本，用来完成下面这条链路：

- 上传一张小参考图
- 上传一张整套总 mask PNG
- 自动按 alpha 连通区域拆成多个裁片
- 给每个裁片单独调节平移、缩放、旋转、镜像
- 左边看单片，右边看整套排版回排
- 导出整套预览 PNG
- 导出全部单裁片 PNG

## 适用的 mask 标准

推荐使用：

- PNG
- 透明背景
- 裁片区域有 alpha，不要求必须是白色或黑色
- 一张图里可以包含整套多个裁片

本工具优先按 **alpha 通道** 识别裁片，不是按黑白颜色识别。

## 主要功能

1. 自动拆总 mask
2. 按面积排序裁片，默认先选最大主片
3. 小参考图平铺生成大面料图
4. 当前裁片支持：
   - 平移 X / Y
   - 缩放
   - 旋转
   - 左右镜像
   - 上下镜像
   - 画布里直接拖拽
5. 整套预览自动按原始位置回排
6. 导出：
   - 整套预览 PNG
   - 全部裁片 PNG

## 当前版本定位

这是一个“先能跑起来、先能改图”的版本，适合先验证流程。

它还没有做：

- AI 扩图
- 自动最佳花位推荐
- 左右联动规则模板
- 项目保存 / 读取
- DXF / SVG 输出
- 裁片边界编辑

## 文件说明

- `index.html`：页面结构
- `styles.css`：界面样式
- `app.js`：核心逻辑
- `INSTALL.md`：安装与运行说明
# print
