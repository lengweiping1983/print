# 全局一致坐标系与裁片自动适配说明

> 本文档说明当前项目中“全局设计画布 / 全局一致坐标系”的架构、流程、技术实现和适用场景。它面向后续开发、算法迭代和生产打样使用。

---

## 一、为什么需要全局坐标系

全局坐标系的核心思想是：

```text
先生成一张“完整衣服的虚拟设计画布”
    ↓
把纹理、主视觉、logo、文字先放到这张设计画布
    ↓
每个裁片只记录自己在设计画布中的取样区域
    ↓
导出时从同一张设计画布里切出各裁片 PNG
```

这样所有裁片共享同一套纹理坐标，整件衣服看起来像从同一张大图中裁出来。

---

## 二、核心概念

### 2.1 设计画布（Design Canvas）

设计画布是一张虚拟的大图，不等同于模板原图，也不等同于导出的排版图。

它表示“衣服在二维平面中的展开设计空间”。

当前配置保存在 `projects.export_config.design_canvas` 中，主要字段包括：

| 字段 | 说明 |
|------|------|
| `width` / `height` | 全局设计画布尺寸 |
| `unit` | 单位，当前为 `px` |
| `base_size` | 基码预留字段，后续用于多尺码联动 |
| `global_texture_angle` | 全局纹理方向 |
| `texture_scale` | 全局纹理缩放 |
| `texture_offset_x` / `texture_offset_y` | 全局纹理偏移 |
| `tile` | 是否平铺纹理 |
| `mirror` | 是否镜像扩展纹理 |
| `symmetry` | 左右规则：`continuous` 或 `mirror` |
| `anchor` | 主视觉锚点，如前胸中心、后背中心 |
| `design_anchors` | 项目级主视觉锚点集合 |
| `size_mapping` | 多尺码映射预留字段 |

### 2.2 裁片设计区域（Design Region）

每个裁片仍然保留原始的 `mask_path`、`bbox`、`source_x/source_y` 等信息。

全局坐标系新增的是：裁片在设计画布中的取样区域。

当前这些字段存放在 `pieces.transform` JSON 中：

| 字段 | 说明 |
|------|------|
| `mode` | `local` 或 `global_canvas` |
| `design_x` / `design_y` | 裁片在设计画布上的取样起点 |
| `design_width` / `design_height` | 取样区域尺寸 |
| `design_rotation` | 设计画布取样方向，当前默认 0 |
| `grainline_angle` | 布纹/印花方向 |
| `piece_role` | 裁片角色，如 `front_left`、`back`、`sleeve_left` |
| `fit_confidence` | 自动识别置信度 |
| `fit_note` | 自动适配说明或人工确认提示 |

### 2.3 裁片角色（Piece Role）

当前自动识别支持以下角色：

| 角色 | 中文含义 |
|------|----------|
| `front_left` | 左前片 |
| `front_right` | 右前片 |
| `back` | 后片 |
| `sleeve_left` | 左袖 |
| `sleeve_right` | 右袖 |
| `collar` | 领片 |
| `placket` | 门襟 |
| `strip` | 条带 |
| `unknown` | 未识别 |

第一版使用启发式识别：面积、长宽比、左右成对关系、原始排版位置等。

---

## 三、系统架构

### 3.1 后端模块

全局坐标系相关代码主要分布在：

```text
apps/api/app/
├── main.py          # API 路由、job 编排、数据库写回
├── schemas.py       # Pydantic 请求/响应模型
├── layout_ops.py    # 裁片角色识别、设计画布布局、映射字段生成
├── design_ops.py    # 全局设计画布纹理生成、预览生成
└── image_ops.py     # 本地/全局两种渲染模式
```

核心职责：

- `layout_ops.py`
  - 生成 `design_canvas` 配置。
  - 根据裁片特征推断 `piece_role`。
  - 把裁片放到设计画布中的逻辑区域。
  - 生成 `safe_zones`、`avoid_zones`、`seam_links` 的第一版结构。

- `design_ops.py`
  - 根据原始纹理生成全局设计画布 PNG。
  - 支持缩放、旋转、平铺、镜像、整体偏移。
  - 生成全局适配预览。

- `image_ops.py`
  - `render_piece` 单片局部渲染模式。
  - `render_piece_from_design_canvas` 支持从全局设计画布取样。
  - `render_layout` 复用同一套逻辑，因此预览和导出都会自动支持全局模式。

### 3.2 前端模块

前端相关代码主要在：

```text
apps/web/
├── components/StudioPage.tsx       # 全局适配面板、状态管理、任务触发
├── components/KonvaWorkspace.tsx   # 单片校正、整套排版、全局设计画布视图
└── lib/api.ts                      # auto-map / fit-global API 封装
```

前端提供三个视角：

- 「单片校正」：看当前裁片在 mask 中的纹理效果，支持微调。
- 「整套排版」：按模板原始坐标回排所有裁片。
- 「全局设计画布」：查看整张虚拟衣服大画布，以及每个裁片从哪里取样。

### 3.3 共享类型

前端共享类型在：

```text
packages/shared-types/src/index.ts
```

主要新增：

- `PieceTransform.mode`
- `design_x/design_y/design_width/design_height`
- `piece_role`
- `fit_confidence`
- `DesignCanvas`
- `GlobalFitOptions`

---

## 四、后端 API 与任务流程

### 4.1 自动裁片映射

接口：

```http
POST /api/projects/{project_id}/layout/auto-map
```

用途：

- 只识别裁片角色。
- 只建立设计画布和裁片映射。
- 不重新生成纹理设计画布。

请求示例：

```json
{
  "garment_type": "shirt",
  "strategy": "heuristic_v1",
  "apply": true
}
```

输出内容：

- `design_canvas`
- `mappings`
- 更新后的 `pieces`
- `warnings`

适合在没有纹理时先做裁片角色确认。

### 4.2 全局纹理适配

接口：

```http
POST /api/projects/{project_id}/textures/{texture_id}/fit-global
```

用途：

- 生成全局设计画布 PNG。
- 自动识别裁片并写入全局取样区域。
- 更新纹理记录，使前端使用全局设计画布作为当前纹理。
- 生成整套全局适配预览。

请求示例：

```json
{
  "garment_type": "shirt",
  "strategy": "continuous_unified_v1",
  "apply": true,
  "texture_scale": 1,
  "texture_angle": 0,
  "texture_offset_x": 0,
  "texture_offset_y": 0,
  "tile": true,
  "mirror": false,
  "anchor": "front_center",
  "symmetry": "continuous"
}
```

输出内容：

- `texture`
- `design_canvas`
- `design_canvas_url`
- `fit_preview_url`
- `mappings`
- 更新后的 `pieces`
- `warnings`

---

## 五、完整业务流程

### 5.1 UI 操作流程

1. 启动前后端。
2. 打开 `http://127.0.0.1:3000/`。
3. 上传裁片模板 PNG/WebP，或白底排版图。
4. 后端自动拆裁片。
5. 上传图案、水纹、迷彩、花纹或衣服参考图。
6. 在「全局适配」面板设置：
   - 衣服类型。
   - 全局纹理方向。
   - 纹理缩放。
   - 偏移 X / Y。
   - 左右规则。
   - 主视觉中心。
7. 点击「自动适配纹理」。
8. 在「全局设计画布」视图检查裁片取样框。
9. 在「单片校正」中微调当前裁片。
10. 导出打样包。

### 5.2 数据流

```text
裁片模板
  ↓
extract_alpha_components
  ↓
pieces(mask/bbox/source_x/source_y/transform)
  ↓
auto_map_pieces
  ↓
design_canvas + piece design_region
  ↓
build_design_texture_canvas
  ↓
全局设计画布 PNG
  ↓
render_piece_from_design_canvas
  ↓
单裁片透明 PNG / 整套预览 / ZIP 打样包
```

### 5.3 渲染模式切换

每个裁片通过 `transform.mode` 决定渲染方式：

```text
mode = "local"
  纹理在单裁片 mask 内独立平铺、缩放、旋转、平移。

mode = "global_canvas"
  从全局设计画布的 design_region 取样，再用裁片 mask 裁切。
```

没有 `mode` 字段的 transform 默认按 `local` 处理。

---

## 六、关键技术实现

### 6.1 全局设计画布生成

`build_design_texture_canvas` 使用 Pillow 生成画布：

1. 读取原始纹理图。
2. 按 `texture_scale` 缩放。
3. 如果 `mirror=true`，先做 2x2 镜像扩展。
4. 按 `global_texture_angle` 旋转。
5. 按 `texture_offset_x/y` 平铺到设计画布。
6. 绘制主视觉锚点提示。
7. 保存为 `storage/projects/{project_id}/textures/{texture_id}_design_canvas.png`。

### 6.2 裁片自动布局

`auto_map_pieces` 当前使用启发式规则：

- 面积最大的主体裁片优先识别为 `back`。
- 长条形裁片识别为 `collar`、`placket` 或 `strip`。
- 面积和长宽接近的成对裁片识别为左右前片或左右袖。
- 无法判断时标记为 `unknown`，并输出 warning。

每种角色会被放到设计画布中的固定逻辑区域：

- 前片：设计画布左上区域。
- 后片：设计画布右上区域。
- 袖片：设计画布下方区域。
- 领片、门襟、条带：独立条带区域。

这是第一版可落地策略，后续可以替换成更强的服装结构识别模型。

### 6.3 全局取样渲染

`render_piece_from_design_canvas` 的核心逻辑：

1. 打开裁片 mask。
2. 打开全局设计画布。
3. 根据 `design_x/design_y/design_width/design_height` 取样。
4. 将取样结果缩放到裁片 mask 尺寸。
5. 应用左右/上下镜像。
6. 使用 mask 作为 alpha 通道。
7. 合成红色对位标记。
8. 输出透明 PNG。

前端 `KonvaWorkspace` 也使用同样概念：

- `global_canvas` 模式下，纹理图片不再被局部平移/旋转到 mask 外。
- 平移操作改为移动 crop 取样坐标。
- 旋转不再直接旋转裁片内图片本体，避免出现白块。
- 线框大小由「显示线框」后的线宽选择器统一控制，默认 5px。

### 6.4 预览与导出一致性

当前设计要求：

- 前端预览和后端导出都基于相同字段：`transform.mode` 和 `design_region`。
- `render_layout` 会调用 `render_piece`。
- `render_piece` 内部根据 `mode` 自动选择本地模式或全局模式。

这保证：

```text
单片预览 ≈ 整套预览 ≈ 导出 PNG
```

---

## 七、当前可以支持的场景

### 7.1 水纹、云纹、迷彩、花纹

推荐配置：

- 左右规则：`连续统一`
- 主视觉中心：按默认前胸中心即可
- 纹理方向：按图案主方向设置
- 纹理缩放：控制图案密度

效果：

- 所有裁片共享同一张全局纹理。
- 前片、后片、袖片的方向和密度更一致。
- 不会出现每个裁片各自铺满导致的纹理比例跳变。

### 7.2 左右对称设计

推荐配置：

- 左右规则：`左右镜像`

效果：

- 右前片、右袖等可按规则镜像。
- 适合正式、规整、需要左右对称的图案。

当前注意：

- 镜像规则仍是第一版启发式。
- 如果裁片角色识别错误，需要后续增加人工指定角色能力。

### 7.3 胸口主图案、鱼、logo、文字

当前支持“锚点概念”和设计画布位置预留：

- `front_center`
- `back_center`
- `left_chest`
- `right_chest`
- `hem_center`
- `sleeve_center`

第一版不会自动识别图中主体元素，也不会自动避开所有缝份。

当前建议：

- 先通过全局设计画布确定大图案大致位置。
- 再在单片校正中微调取样区域。
- 后续可以在 `design_ops.py` 中加入主体图案图层、文字图层、logo 图层。

### 7.4 单片局部打样

支持单片局部打样：

- 上传纹理。
- 不点击「自动适配纹理」。
- 使用平移、缩放、旋转、镜像单独调每个裁片。

适合：

- 快速看效果。
- 每个裁片独立花位。
- 不需要整衣纹理连续的打样。

---

## 八、当前限制

第一版不是完整的 3D 服装展开系统，当前限制包括：

- 不能从单张衣服照片精确反推出真实 3D 纹理。
- 裁片角色识别是启发式，不保证所有版型都正确。
- `seam_links`、`safe_zones`、`avoid_zones` 已有数据结构，但还没有完整 UI 编辑。
- 拼缝连续性当前主要依赖全局取样坐标，没有做 seam-aware warp。
- 多尺码联动只预留 `base_size` 和 `size_mapping`，尚未实现尺码映射。
- 主图案、logo、文字还没有独立图层系统。

---

## 九、后续扩展方向

### 9.1 人工指定裁片角色

在前端裁片参数面板增加：

- 裁片角色选择器。
- 左右配对选择。
- 布纹方向编辑。
- 是否参与全局连续。

### 9.2 拼缝关系编辑

增加 seam editor：

- 选择裁片边。
- 标记肩缝、侧缝、袖山、袖窿、领口。
- 建立裁片边之间的连接关系。
- 根据连接关系做边缘颜色差异检测。

### 9.3 主图案图层系统

设计画布应支持多图层：

```text
底纹层：水纹 / 迷彩 / 花纹
主体层：鱼 / logo / 插画
文字层：文案 / 标语
标记层：对位点 / 工艺线
```

每个图层可以有自己的：

- 锚点。
- 缩放。
- 旋转。
- 安全区检查。
- 是否跨中缝。

### 9.4 多尺码联动

建议以基码为核心：

1. 在 M 码建立设计画布。
2. 其他尺码通过人体关键点或裁片关键点映射。
3. 主图案相对胸点、后背中心、下摆中心保持稳定。
4. 纹理密度尽量不随尺码过度拉伸。

### 9.5 更强图像算法

可逐步引入：

- 主体分割：SAM / MediaPipe / OpenCV GrabCut。
- 纹理合成：PatchMatch / Image Quilting。
- 无缝扩图：AI outpainting。
- 拼缝优化：seam-aware local warp。
- 结构识别：基于裁片 polygon 的版型分类。

---

## 十、开发注意事项

- 不要修改根目录旧版原型 `index.html`、`app.js`、`styles.css`。
- 新功能优先落在 `apps/api` 和 `apps/web`。
- 与全局坐标系相关的新增数据，第一阶段优先放在 JSON 字段中，避免频繁迁移 SQLite schema。
- 保持 `local` 和 `global_canvas` 两种模式兼容。
- 前端预览逻辑必须和后端导出逻辑保持一致，避免“页面看起来对，导出不对”。
- 对用户可见文案保持简体中文。

