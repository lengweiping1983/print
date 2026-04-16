# 全局一致坐标系与裁片自动适配说明

> 本文档说明当前项目中“全局设计画布 / 全局一致坐标系”的架构、流程、技术实现和适用场景。它面向后续开发、算法迭代和生产打样使用。

---

## 一、为什么需要全局坐标系

全局坐标系的核心思想是：

```text
先生成一张“完整衣服的虚拟设计画布”
    ↓
把面料、主视觉、logo、文字先放到这张设计画布
    ↓
每个裁片只记录自己在设计画布中的取样区域
    ↓
导出时从同一张设计画布里切出各裁片 PNG
```

这样所有裁片共享同一套面料坐标，整件衣服看起来像从同一张大图中裁出来。

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
| `global_texture_angle` | 全局面料方向 |
| `texture_scale` | 全局面料缩放 |
| `texture_offset_x` / `texture_offset_y` | 全局面料偏移 |
| `tile` | 是否平铺面料 |
| `mirror` | 是否镜像扩展面料 |
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
├── design_ops.py    # 全局设计画布面料生成、预览生成
└── image_ops.py     # 本地/全局两种渲染模式
```

核心职责：

- `layout_ops.py`
  - 生成 `design_canvas` 配置。
  - 根据裁片特征推断 `piece_role`。
  - 把裁片放到设计画布中的逻辑区域。
  - 生成 `safe_zones`、`avoid_zones`、`seam_links` 的第一版结构。

- `design_ops.py`
  - 根据原始面料生成全局设计画布 PNG。
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

- 「单片校正」：看当前裁片在 mask 中的面料效果，支持微调。
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
- 不重新生成面料设计画布。

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

适合在没有面料时先做裁片角色确认。

### 4.2 全局面料适配

接口：

```http
POST /api/projects/{project_id}/textures/{texture_id}/fit-global
```

用途：

- 生成全局设计画布 PNG。
- 自动识别裁片并写入全局取样区域。
- 更新面料记录，使前端使用全局设计画布作为当前面料。
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
   - 全局面料方向。
   - 面料缩放。
   - 偏移 X / Y。
   - 左右规则。
   - 主视觉中心。
7. 点击「自动适配面料」。
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
  面料在单裁片 mask 内独立平铺、缩放、旋转、平移。

mode = "global_canvas"
  从全局设计画布的 design_region 取样，再用裁片 mask 裁切。
```

没有 `mode` 字段的 transform 默认按 `local` 处理。

---

## 六、关键技术实现

### 6.1 全局设计画布生成

`build_design_texture_canvas` 使用 Pillow 生成画布：

1. 读取原始面料图。
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

- `global_canvas` 模式下，面料图片不再被局部平移/旋转到 mask 外。
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

## 七、当前方案的缺点

当前全局坐标系已经把“前端预览、后端渲染、导出打样包”统一到同一套 `transform.mode = global_canvas` 字段上，这是正确方向。但它仍是第一版二维方案，缺点需要在后续开发中明确消化。

### 7.1 角色识别依赖启发式

当前 `layout_ops.py` 主要通过面积、长宽比、左右位置和相似裁片配对来识别前片、后片、袖片、领片、门襟等角色。

缺点：

- 异形裁片、连体裁片、不规则袖片、帽片、裤片、裙片容易识别错误。
- 面积最大的裁片默认偏向 `back`，对马甲、短裙、围裙、包袋等品类不一定成立。
- 裁片旋转摆放后，左右关系仍按模板原始 `source_x` 判断，可能把左右片反过来。

优化方向：

- 增加人工裁片角色选择器，把自动识别作为初始建议。
- 在 `PieceTransform` 中补充 `role_confirmed`、`pair_id`、`pair_side` 等字段。
- 对不同 `garment_type` 建立独立识别规则，不再用一套 shirt 规则覆盖所有品类。

### 7.2 设计画布是逻辑平面，不是真实 3D 展开

全局设计画布当前是一张二维虚拟图。它能保证裁片从同一张大图取样，但不能表达真实人体曲面、缝合后形变、布料拉伸和省道收量。

缺点：

- 大图案跨侧缝、肩缝、袖窿时，只能做到“取样坐标接近”，不能保证缝后完全对齐。
- 对弹力布、斜纹布、曲线袖山、腰省、胸省等结构，二维矩形取样会有视觉误差。
- `design_rotation` 当前只是简单旋转取样结果，不是沿裁片布纹或缝线做局部变形。

优化方向：

- 先做 seam-aware 的二维边缘对齐，再考虑 3D 模型。
- 为每个裁片记录关键点，例如领口点、肩点、腋点、袖山点、下摆点。
- 用关键点建立局部仿射或薄板样条变换，替代纯矩形 crop。

### 7.3 拼缝连续性还没有闭环校验

当前已经预留 `seam_links`、`safe_zones`、`avoid_zones`，但它们主要存在于映射结果中，还没有完整 UI 编辑、数据库持久化和质量评分。

缺点：

- 系统不会提醒肩缝、侧缝、袖缝两侧颜色是否断裂。
- 设计师无法在画布上直接指定“这条边要对那条边”。
- 导出前没有自动生成拼缝风险报告。

优化方向：

- 增加拼缝编辑器，允许选择裁片边并建立连接关系。
- 后端读取 seam 两侧边缘像素，计算色差、面料相位差和方向差。
- 导出 manifest 中输出 seam 检查结果，标注高风险拼缝。

### 7.4 主视觉、logo、文字还没有图层系统

当前全局设计画布只把上传面料整体平铺或居中放置，并绘制锚点提示。logo、鱼、文字、号码、队名等还没有作为独立图层保存。

缺点：

- 主图案无法单独拖拽、缩放、旋转、锁定。
- 文字无法保持矢量或高分辨率输出。
- 无法按安全区自动提示“logo 离缝线太近”。

优化方向：

- 在 `export_config.design_canvas.layers` 中保存图层数组。
- 图层类型包括 `texture`、`image`、`text`、`marker`。
- `build_design_texture_canvas` 改为按图层顺序合成，而不是只处理一张面料。

### 7.5 多尺码只预留字段，尚未形成生产流程

当前 `base_size` 和 `size_mapping` 已预留，但没有实现从基码向其他尺码复制设计的逻辑。

缺点：

- S/M/L/XL 需要逐个重新适配。
- 主视觉可能在不同尺码中相对胸点、后背中心、下摆位置漂移。
- 图案密度和 logo 大小是否随尺码缩放，目前没有规则。

优化方向：

- 以基码为设计源，只允许在基码上编辑主视觉。
- 每个尺码模板导入后，先识别同名角色和关键点。
- 通过角色和关键点把基码图层投射到其他尺码。

### 7.6 前端可调参数还偏少

当前前端可调全局面料方向、缩放、偏移、左右规则、主视觉中心，也能微调单裁片全局 X/Y。

缺点：

- 不能拖动设计画布上的取样框。
- 不能编辑 `design_width/design_height`。
- 不能锁定某个裁片、批量复制参数、撤销重做。
- 不能按裁片分组显示安全区、避让区、缝线风险。

优化方向：

- 在「全局设计画布」视图中支持拖拽取样框，直接更新 `design_x/design_y`。
- 增加裁片角色、参与全局连续、锁定、成对镜像等控件。
- 增加局部历史栈，至少支持撤销最近一次参数变化。

---

## 八、优化优先级

建议按“先让生产可控，再让算法更聪明”的顺序推进。

### 8.1 第一优先级：人工校正能力

目标：

- 自动识别不准时，设计师可以立即修正，而不是等待算法升级。

落地点：

- 前端：`StudioPage.tsx` 当前裁片参数区增加角色选择、是否参与全局、左右配对、锁定。
- 后端：`PATCH /api/projects/{id}/pieces/{piece_id}` 继续复用 transform JSON。
- 类型：`PieceTransform` 增加 `role_confirmed`、`global_enabled`、`pair_id`、`pair_side`。

### 8.2 第二优先级：图层系统

目标：

- 支持底纹、主图、logo、文字、号码、对位标记分层编辑。

落地点：

- 数据：`projects.export_config.design_canvas.layers`。
- 后端：`design_ops.py` 新增 `render_design_layers`，按图层类型合成设计画布。
- 前端：全局设计画布视图增加图层列表、显示隐藏、锁定、层级排序。

### 8.3 第三优先级：拼缝编辑与检查

目标：

- 把“看起来差不多连续”升级成“可检测、可提示、可复查”。

落地点：

- 数据：把 `seam_links` 从临时 mapping 提升到 transform 或 project export_config。
- 后端：增加 seam 边缘取样和色差评分函数。
- 前端：设计画布或排版画布中支持点击裁片边，建立 seam link。

### 8.4 第四优先级：多品类模板规则

目标：

- 让系统从“衬衫/T 恤优先”扩展到裤子、裙子、帽子、包、围裙、旗帜等品类。

落地点：

- 后端：`layout_ops.py` 按 `garment_type` 分派不同 role 规则。
- 前端：全局适配面板增加品类下拉。
- 文档：每个品类维护默认角色、锚点、安全区和拼缝规则。

### 8.5 第五优先级：多尺码联动

目标：

- 让一套设计可以稳定迁移到 S/M/L/XL。

落地点：

- 数据：`size_mapping` 保存不同尺码 project_id、角色对应关系、关键点映射。
- 后端：新增 `POST /api/projects/{id}/layout/size-transfer`。
- 前端：增加“从基码同步设计”入口。

---

## 九、可扩展场景与实现方案

本节列出建议优先支持的更多生产场景。每个场景都说明用户目标、当前能力、需要补强的数据结构和实现步骤。

### 9.1 连续底纹：水纹、云纹、迷彩、花纹

用户目标：

- 整件衣服共享同一张底纹，前片、后片、袖片面料密度一致。

当前可支持：

- 使用 `fit-global` 生成全局设计画布。
- 所有裁片写入 `mode = global_canvas`。
- 从同一张设计画布切出裁片。

实现步骤：

1. 前端选择 `symmetry = continuous`。
2. 上传面料后调用 `POST /textures/{texture_id}/fit-global`。
3. 后端 `build_design_canvas_config` 写入全局面料方向、缩放、偏移。
4. 后端 `build_design_texture_canvas` 平铺面料。
5. `auto_map_pieces` 给每个裁片分配 `design_x/design_y/design_width/design_height`。
6. 导出时 `render_piece_from_design_canvas` 统一取样。

增强点：

- 增加“面料密度锁定”，使缩放只影响底纹，不影响 logo 和文字。
- 增加“随机相位偏移”，用于迷彩、石纹等不要求严格拼缝的花型。

### 9.2 左右镜像：对称球衣、队服、制服

用户目标：

- 左右前片、左右袖片图案对称，看起来规整。

当前可支持：

- `symmetry = mirror` 时，`front_right`、`sleeve_right` 会自动 `mirror_x = true`。

实现步骤：

1. 前端选择左右规则为“左右镜像”。
2. `auto_map_pieces` 根据角色调用 `_mirror_role`。
3. `merge_mapping_into_transform` 把 `mirror_x` 写入裁片 transform。
4. 后端渲染时 `render_piece_from_design_canvas` 对取样结果做 `ImageOps.mirror`。
5. 前端预览时 `KonvaImage` 使用 `scaleX = -1` 保持视觉一致。

增强点：

- 增加左右配对编辑，避免角色识别错误导致镜像错片。
- 增加“镜像轴”字段，例如 `mirror_axis_x`，支持以衣服中心线而不是裁片中心线镜像。

### 9.3 胸口主图：鱼、插画、大 logo

用户目标：

- 主图固定在前胸、后背或下摆中心，不能被缝线切坏。

当前可支持：

- 有 `front_center`、`back_center`、`hem_center` 等锚点。
- 设计画布会绘制锚点提示。

需要补强：

- 图层系统。
- 安全区检查。
- 主图层与底纹层分离。

实现步骤：

1. 数据中增加图层：

```json
{
  "type": "image",
  "name": "前胸主图",
  "asset_id": "asset_xxx",
  "anchor": "front_center",
  "x": 0,
  "y": 0,
  "width": 900,
  "height": 600,
  "rotation": 0,
  "locked": false,
  "avoid_seams": true
}
```

2. 前端在全局设计画布里显示主图层，并允许拖拽。
3. 后端 `design_ops.py` 先渲染底纹层，再把主图层按锚点贴到设计画布。
4. 后端根据 `safe_zones/avoid_zones` 检查主图 bbox 是否压到缝份。
5. 导出 manifest 增加主图安全区检查结果。

增强点：

- 主图可选择“跨前中线”“只在左胸”“只在后背”。
- 可增加自动居中、按胸宽缩放、避开门襟等快捷按钮。

### 9.4 文字与号码：队名、姓名、尺码标识

用户目标：

- 文字保持清晰，号码位置统一，导出后不糊。

当前能力：

- 只能把文字作为图片面料的一部分上传。

需要补强：

- 独立 `text` 图层。
- 字体、字号、字重、描边、字距、行距、对齐方式。

实现步骤：

1. `design_canvas.layers` 增加文本图层：

```json
{
  "type": "text",
  "name": "后背号码",
  "content": "23",
  "anchor": "back_center",
  "font_family": "Noto Sans CJK",
  "font_size": 260,
  "font_weight": "700",
  "fill": "#ffffff",
  "stroke": "#111111",
  "stroke_width": 8,
  "x": 0,
  "y": 120
}
```

2. 前端提供文字输入、字体大小、颜色和描边控件。
3. 后端用 Pillow `ImageDraw` 或 reportlab 渲染文字层。
4. PNG 导出使用高分辨率 raster，后续 PDF/SVG 可保留文字矢量。
5. 安全区检查提示文字是否进入缝份或裁片外。

增强点：

- 支持批量名单和号码。
- 支持号码跨尺码保持相对后背中心不漂移。

### 9.5 门襟连续图案：衬衫、拉链衫、开衫

用户目标：

- 左右门襟闭合后，前胸图案或横向条纹能对齐。

当前能力：

- 只能靠左右前片的全局取样区域接近。

需要补强：

- 明确 `placket` 与左右前片的 seam link。
- 增加前中线锚点和闭合预览。

实现步骤：

1. 在角色识别中稳定识别 `front_left`、`front_right`、`placket`。
2. `seam_links` 增加：

```json
{
  "from_piece_role": "front_left",
  "from_edge": "center_front",
  "to_piece_role": "front_right",
  "to_edge": "center_front",
  "mode": "match_pattern"
}
```

3. 前端增加“闭合预览”，把左右前片按门襟线贴合显示。
4. 后端 seam 检查函数沿前中线采样，计算两边颜色差。
5. 如果差异大，前端提示微调 `design_x` 或自动做相位校正。

增强点：

- 支持纽扣位避让。
- 支持拉链牙位安全区。

### 9.6 袖子跨身连续：肩缝、袖山、袖窿

用户目标：

- 图案从身片延伸到袖子时，肩部和袖窿附近尽量不断裂。

当前能力：

- `seam_links` 有袖山到前片袖窿的第一版预留。

需要补强：

- 袖山曲线关键点。
- 曲线边缘采样。
- 局部 warp 或相位校正。

实现步骤：

1. 前端 seam editor 中让用户标记袖山边和袖窿边。
2. 数据中记录边缘 polyline，而不是只记录 `edge = sleeve_cap`。
3. 后端沿两条 polyline 等距采样面料颜色。
4. 计算平均色差、最大色差、方向差，输出风险评分。
5. 第一阶段只提示人工微调，第二阶段再实现自动微调 `design_x/design_y`。

增强点：

- 可对局部区域做轻微形变，让袖山拼接处更连续。
- 可为复杂花型生成肩部局部补丁。

### 9.7 条纹、格纹、斜纹

用户目标：

- 横条、竖条、格纹在身片、袖片、侧缝处尽量对齐。

当前能力：

- 可通过全局面料方向和缩放控制条纹密度。

需要补强：

- 条纹周期识别。
- 布纹方向和对条规则。
- 缝线相位检查。

实现步骤：

1. 后端对面料做简单投影分析，估算横向/纵向周期。
2. 在 `design_canvas` 记录 `pattern_period_x/pattern_period_y`。
3. 裁片 transform 增加 `grainline_angle` 和 `stripe_phase_lock`。
4. 对需要对条的 seam link，检查两侧采样点是否落在同一周期相位。
5. 前端显示“条纹偏移 12px”之类的可操作提示。

增强点：

- 增加“一键对齐横条”“一键对齐竖条”。
- 对格纹分别检查 X/Y 两个方向。

### 9.8 定位印花：左胸 logo、袖标、下摆标

用户目标：

- 小 logo 准确落在某个部位，不需要全衣连续。

当前能力：

- 可用全局锚点粗略定位。

需要补强：

- 局部图层绑定到角色，而不是绑定到整张设计画布。

实现步骤：

1. 图层增加 `target_roles` 字段，例如只投放到 `front_left`。
2. 图层 anchor 使用 `left_chest`、`sleeve_center`、`hem_center`。
3. 后端合成设计画布时，只在目标角色对应区域内渲染该图层。
4. 前端在裁片参数区显示该裁片包含哪些定位图层。
5. 安全区检查确保 logo 不压缝、不出血。

增强点：

- 支持 logo 批量替换。
- 支持同一 logo 在左右袖自动镜像或保持文字方向不镜像。

### 9.9 满版随机散点：星星、小花、小图标

用户目标：

- 满版图案自然随机，但不能在缝线附近出现半个主体。

当前能力：

- 可以作为普通面料平铺。

需要补强：

- 程序化散点图层。
- 避让区检测。

实现步骤：

1. 新增 `scatter` 图层类型，包含素材列表、密度、随机种子、最小间距。
2. 后端在设计画布上按 seed 生成稳定散点。
3. 生成时避开 `avoid_zones` 和主要 seam。
4. 裁片取样后自然得到一致散点。
5. 导出 manifest 记录 seed，方便复现。

增强点：

- 支持按裁片角色调整密度。
- 支持散点不跨缝、允许跨缝两种模式。

### 9.10 旗帜、横幅、围巾、方巾

用户目标：

- 非服装裁片也可以使用统一坐标系，尤其适合大幅连续图案。

当前能力：

- 透明模板拆片和全局取样已经可复用。

需要补强：

- 增加 `garment_type = flag/banner/scarf`。
- 角色不再按前后袖识别，而按面料块、包边、挂带识别。

实现步骤：

1. `GlobalFitOptions.garment_type` 增加 `flag`、`banner`、`scarf`。
2. `layout_ops.py` 增加对应规则：
   - 最大矩形为 `main_panel`。
   - 长条为 `edge_binding`。
   - 小片为 `loop` 或 `reinforcement`。
3. 设计画布锚点增加 `center`、`top_left`、`top_right`、`bottom_center`。
4. 主图层默认铺满 `main_panel`。
5. 包边和挂带可选择连续取样或纯色填充。

增强点：

- 支持出血区和裁切安全线。
- 支持正反双面旗帜镜像检查。

### 9.11 裤子、短裤、裙片

用户目标：

- 支持下装版型，保证左右裤腿或裙片图案方向统一。

当前能力：

- 可作为未知裁片进行全局取样，但角色识别不准。

需要补强：

- 下装角色规则。
- 裤腿内外侧 seam link。

实现步骤：

1. `garment_type` 增加 `pants`、`shorts`、`skirt`。
2. 角色增加 `leg_left_front`、`leg_right_front`、`leg_left_back`、`leg_right_back`、`waistband`、`skirt_panel`。
3. 根据长宽比、成对关系和上下位置识别裤腿与腰头。
4. 设计画布 lane 由上衣区域改为左右裤腿区域。
5. seam link 增加内侧缝、外侧缝、裆缝、腰头。

增强点：

- 支持裤腿外侧大图案连续。
- 支持裙片环绕连续花型。

### 9.12 帽子、包袋、配饰

用户目标：

- 支持小裁片多、形状碎、角色复杂的配饰类产品。

当前能力：

- 透明 alpha 拆片和单片打样可用。

需要补强：

- 更多角色类型。
- 手工角色确认优先于自动识别。

实现步骤：

1. `garment_type` 增加 `cap`、`bag`、`accessory`。
2. 角色增加 `crown_panel`、`brim`、`side_panel`、`front_panel`、`strap`、`pocket`。
3. 默认先把所有裁片设为 `unknown`，要求用户确认关键角色。
4. 全局设计画布按“主体面板、侧片、带子、小片”分区。
5. 对帽檐、带子等窄长片默认不参与连续，除非用户勾选。

增强点：

- 支持小片自动编号。
- 支持同一图案批量应用到多个小裁片。

### 9.13 白底模板导入与半透明模板

用户目标：

- 不只有透明 PNG，有时只有白底裁片图、扫描件或低透明度模板。

当前能力：

- 主要依赖 alpha 连通域拆片。

需要补强：

- 白底去背。
- 阈值调节。
- 人工合并/拆分裁片。

实现步骤：

1. 上传模板时允许选择“透明模板”或“白底模板”。
2. 后端对 RGB 接近白色的区域生成 alpha。
3. 前端提供阈值滑杆和预览。
4. 拆片后允许合并误拆的小区域，或删除噪点。
5. 保存原始模板和处理后的 alpha 模板，便于回溯。

增强点：

- 支持扫描阴影校正。
- 支持按颜色线条提取裁片边界。

### 9.14 工艺标记与对位点

用户目标：

- 导出裁片时保留对位点、刀口、缝份提示、裁剪编号。

当前能力：

- `composite_piece_markers` 已支持把 mask 对应 marker 合成到导出图。

需要补强：

- 前端编辑标记。
- manifest 明确输出标记信息。

实现步骤：

1. 数据中增加 `markers`：

```json
{
  "type": "notch",
  "piece_id": "piece_xxx",
  "x": 120,
  "y": 40,
  "label": "肩点"
}
```

2. 前端在单片校正视图增加标记工具。
3. 后端导出时把 marker 渲染到透明 PNG 或单独输出标记层。
4. manifest 中列出每个裁片的标记坐标。
5. PDF 预览中显示裁片编号和工艺标记。

增强点：

- 支持标记是否参与印花层。
- 支持只在工艺预览显示，不进入生产 PNG。

### 9.15 多尺码套版同步

用户目标：

- 一套图案设计完成后，快速同步到其他尺码。

当前能力：

- 只有 `base_size` 和 `size_mapping` 预留。

需要补强：

- 尺码间角色匹配。
- 关键点映射。
- 图层缩放规则。

实现步骤：

1. 基码项目完成角色确认和图层设计。
2. 其他尺码导入模板后，运行 `auto-map` 并人工确认角色。
3. 新增 `size_mapping`：

```json
{
  "base_project_id": "project_m",
  "target_project_id": "project_l",
  "role_map": {
    "front_left": "piece_l_01",
    "front_right": "piece_l_02"
  },
  "scale_policy": "keep_logo_size"
}
```

4. 后端把基码图层按目标尺码锚点重新计算位置。
5. 前端显示同步结果和需要人工确认的风险项。

增强点：

- 支持“logo 保持物理尺寸”和“logo 随尺码等比放大”两种策略。
- 支持批量生成全尺码 ZIP。

---

## 十、当前限制

第一版不是完整的 3D 服装展开系统，当前限制包括：

- 不能从单张衣服照片精确反推出真实 3D 面料。
- 裁片角色识别是启发式，不保证所有版型都正确。
- `seam_links`、`safe_zones`、`avoid_zones` 已有数据结构，但还没有完整 UI 编辑。
- 拼缝连续性当前主要依赖全局取样坐标，没有做 seam-aware warp。
- 多尺码联动只预留 `base_size` 和 `size_mapping`，尚未实现尺码映射。
- 主图案、logo、文字还没有独立图层系统。
- 全局设计画布当前以像素为主，尚未建立厘米、英寸、DPI、出血区之间的完整换算。
- 前端全局取样框还不能直接拖拽缩放，参数编辑效率不足。

---

## 十一、后续扩展方向

### 11.1 数据结构演进

优先在 JSON 字段中扩展，稳定后再考虑 SQLite schema 迁移。

建议新增字段：

```text
projects.export_config.design_canvas.layers
projects.export_config.design_canvas.seam_links
projects.export_config.design_canvas.size_mapping
pieces.transform.role_confirmed
pieces.transform.global_enabled
pieces.transform.pair_id
pieces.transform.pair_side
pieces.transform.keypoints
pieces.transform.markers
```

### 11.2 前端体验演进

建议新增：

- 裁片角色选择器。
- 全局设计画布取样框拖拽和缩放。
- 图层列表和图层属性面板。
- 拼缝编辑器。
- 安全区、避让区、拼缝风险覆盖层。
- 撤销重做。
- 多尺码同步入口。

### 11.3 后端算法演进

可逐步引入：

- 主体分割：SAM / MediaPipe / OpenCV GrabCut。
- 面料合成：PatchMatch / Image Quilting。
- 无缝扩图：AI outpainting。
- 拼缝优化：seam-aware local warp。
- 结构识别：基于裁片 polygon 的版型分类。
- 条纹周期识别：投影分析、傅里叶分析。
- 关键点映射：仿射变换、薄板样条。

### 11.4 推荐迭代顺序

1. 做人工角色校正和取样框拖拽，先解决“自动识别错了无法修”。
2. 做图层系统，支持 logo、文字、主图和底纹分离。
3. 做安全区和避让区检查，减少生产事故。
4. 做拼缝编辑和拼缝色差评分。
5. 扩展裤子、裙子、旗帜、围巾、帽子、包袋等品类。
6. 做多尺码同步。

---

## 十二、开发注意事项

- 新功能优先落在 `apps/api` 和 `apps/web`。
- 与全局坐标系相关的新增数据，第一阶段优先放在 JSON 字段中，避免频繁迁移 SQLite schema。
- 保持 `local` 和 `global_canvas` 两种模式兼容。
- 前端预览逻辑必须和后端导出逻辑保持一致，避免“页面看起来对，导出不对”。
- 对用户可见文案保持简体中文。
