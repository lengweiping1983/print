from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
from typing import Any

from PIL import Image

from .config import MAX_IMAGE_PIXELS


ROLE_LABELS = {
    "front_left": "左前片",
    "front_right": "右前片",
    "back": "后片",
    "main": "主片",
    "sleeve_left": "左袖",
    "sleeve_right": "右袖",
    "collar": "领片",
    "placket": "门襟",
    "strip": "条带",
    "unknown": "未识别",
}


@dataclass
class PieceBox:
    id: str
    width: int
    height: int
    area: int
    source_x: int
    source_y: int
    mask_path: str = ""

    @property
    def aspect(self) -> float:
        return self.width / max(1, self.height)

    @property
    def center_x(self) -> float:
        return self.source_x + self.width / 2


@dataclass
class LanePlacement:
    x: float
    y: float
    clipped: bool = False


def build_design_canvas_config(
    pieces: list[dict[str, Any]],
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = payload or {}
    total_area = sum(max(1, int(piece.get("area", 0))) for piece in pieces)
    max_piece_w = max((int(piece.get("width", 0)) for piece in pieces), default=1200)
    max_piece_h = max((int(piece.get("height", 0)) for piece in pieces), default=1200)
    estimated_side = int(max(total_area, 1) ** 0.5)
    width = int(payload.get("canvas_width") or max(1600, max_piece_w * 3, estimated_side * 2.2))
    height = int(payload.get("canvas_height") or max(1200, max_piece_h * 3, estimated_side * 2.2))
    width, height = _limit_canvas_pixels(width, height)
    margin = max(80, min(width, height) // 24)
    return {
        "width": width,
        "height": height,
        "unit": "px",
        "base_size": payload.get("base_size") or "base",
        "global_texture_angle": float(payload.get("texture_angle", 0) or 0),
        "texture_scale": max(0.05, float(payload.get("texture_scale", 1) or 1)),
        "texture_offset_x": float(payload.get("texture_offset_x", 0) or 0),
        "texture_offset_y": float(payload.get("texture_offset_y", 0) or 0),
        "tile": bool(payload.get("tile", True)),
        "mirror": bool(payload.get("mirror", False)),
        "symmetry": payload.get("symmetry") or "continuous",
        "anchor": payload.get("anchor") or "front_center",
        "safe_zone_inset_x_ratio": _ratio_setting(payload, "safe_zone_inset_x_ratio", 0.16),
        "safe_zone_inset_y_ratio": _ratio_setting(payload, "safe_zone_inset_y_ratio", 0.14),
        "avoid_zone_seam_ratio": _ratio_setting(payload, "avoid_zone_seam_ratio", 0.06),
        "avoid_zone_min_px": _positive_float_setting(payload, "avoid_zone_min_px", 8),
        "margin": margin,
        "design_anchors": {
            "front_center": {"x": width * 0.3, "y": height * 0.35},
            "back_center": {"x": width * 0.7, "y": height * 0.35},
            "left_chest": {"x": width * 0.24, "y": height * 0.3},
            "right_chest": {"x": width * 0.36, "y": height * 0.3},
            "hem_center": {"x": width * 0.3, "y": height * 0.72},
            "sleeve_center": {"x": width * 0.5, "y": height * 0.72},
        },
        "layers": payload.get("layers") or [],
        "safety_report": payload.get("safety_report") or [],
        "size_mapping": {},
    }


def _limit_canvas_pixels(width: int, height: int) -> tuple[int, int]:
    width = max(1, int(width))
    height = max(1, int(height))
    pixels = width * height
    if pixels <= MAX_IMAGE_PIXELS:
        return width, height
    scale = math.sqrt(MAX_IMAGE_PIXELS / pixels)
    return max(1, int(width * scale)), max(1, int(height * scale))


def auto_map_pieces(
    pieces: list[dict[str, Any]],
    design_canvas: dict[str, Any],
    garment_type: str = "unknown",
) -> list[dict[str, Any]]:
    boxes = [_box(piece) for piece in pieces]
    roles = _assign_roles(boxes)
    lanes = _role_lanes(design_canvas)
    snap = _texture_snap_settings(design_canvas)
    lane_offsets: dict[str, int] = {}
    role_counts = {role: sum(1 for value in roles.values() if value == role) for role in set(roles.values())}
    mapped: list[dict[str, Any]] = []
    for piece in pieces:
        box = _box(piece)
        role = roles.get(box.id, "unknown")
        lane = lanes.get(role, lanes["unknown"])
        local_index = lane_offsets.get(role, 0)
        lane_offsets[role] = local_index + 1
        placement = _place_in_lane(box, lane, local_index, design_canvas, role_counts.get(role, 1))
        design_x, design_y = placement.x, placement.y
        snapped = False
        if snap:
            design_x, design_y, snapped = _snap_to_texture_period(box, lane, design_x, design_y, snap)
        confidence = _role_confidence(role, box)
        note = _fit_note(role, confidence, garment_type)
        rotation, orientation_note = _orientation_rotation(box, role)
        if snapped:
            note = f"{note} 已按纹理周期吸附取样坐标。"
        if placement.clipped:
            note = f"{note} 裁片尺寸接近或超出自动车道，已夹在画布范围内，建议人工确认。"
        if orientation_note:
            note = f"{note} {orientation_note}"
        mapped.append(
            {
                "id": box.id,
                "piece_role": role,
                "role_label": ROLE_LABELS.get(role, ROLE_LABELS["unknown"]),
                "grainline_angle": float(design_canvas.get("global_texture_angle", 0) or 0),
                "orientation_rotation": rotation,
                "design_region": {
                    "x": round(design_x, 2),
                    "y": round(design_y, 2),
                    "width": box.width,
                    "height": box.height,
                    "rotation": rotation,
                    "mirror_x": _mirror_role(role, design_canvas),
                    "mirror_y": False,
                },
                "seam_links": _default_seam_links(role),
                "safe_zones": _default_safe_zones(box, design_canvas),
                "avoid_zones": _default_avoid_zones(box, design_canvas),
                "fit_confidence": confidence,
                "fit_note": note,
            }
        )
    _filter_seam_links(mapped)
    if snap:
        _apply_seam_alignment(mapped, snap)
    return mapped


def merge_mapping_into_transform(transform: dict[str, Any], mapping: dict[str, Any]) -> dict[str, Any]:
    region = mapping["design_region"]
    next_transform = dict(transform or {})
    role_confirmed = bool(next_transform.get("role_confirmed", False))
    position_confirmed = bool(next_transform.get("position_confirmed", False))
    piece_role = next_transform.get("piece_role") if role_confirmed else mapping["piece_role"]
    update = {
        "mode": "global_canvas",
        "design_width": region["width"],
        "design_height": region["height"],
        "design_rotation": region["rotation"],
        "rotation": region["rotation"],
        "mirror_x": bool(region["mirror_x"]),
        "mirror_y": bool(region["mirror_y"]),
        "grainline_angle": mapping["grainline_angle"],
        "piece_role": piece_role or mapping["piece_role"],
        "role_confirmed": role_confirmed,
        "position_confirmed": position_confirmed,
        "global_enabled": bool(next_transform.get("global_enabled", True)),
        "safe_zones": mapping.get("safe_zones", []),
        "avoid_zones": mapping.get("avoid_zones", []),
        "fit_confidence": mapping["fit_confidence"],
        "fit_note": mapping["fit_note"],
    }
    if not position_confirmed:
        update["design_x"] = region["x"]
        update["design_y"] = region["y"]
    next_transform.update(update)
    return next_transform


def _box(piece: dict[str, Any]) -> PieceBox:
    return PieceBox(
        id=str(piece["id"]),
        width=int(piece.get("width", 0) or piece.get("bbox", {}).get("width", 0)),
        height=int(piece.get("height", 0) or piece.get("bbox", {}).get("height", 0)),
        area=int(piece.get("area", 0) or 0),
        source_x=int(piece.get("source_x", 0) or 0),
        source_y=int(piece.get("source_y", 0) or 0),
        mask_path=str(piece.get("mask_path") or ""),
    )


def _assign_roles(boxes: list[PieceBox]) -> dict[str, str]:
    if not boxes:
        return {}
    ordered = sorted(boxes, key=lambda item: item.area, reverse=True)
    roles: dict[str, str] = {}
    strips = [box for box in ordered if box.aspect >= 3 or box.aspect <= 0.28]
    for index, box in enumerate(strips):
        roles[box.id] = "collar" if index == 0 else "placket" if index == 1 else "strip"
    body_candidates = [box for box in ordered if box.id not in roles]
    if len(body_candidates) == 1:
        roles[body_candidates[0].id] = "main"
    elif len(body_candidates) == 2:
        pair = _pair_score(body_candidates[0], body_candidates[1])
        left, right = _left_right(body_candidates[0], body_candidates[1])
        if pair["score"] <= 0.08 and pair["height_delta"] <= 0.08 and pair["area_delta"] <= 0.12:
            roles[left.id] = "front_left"
            roles[right.id] = "front_right"
        else:
            roles[body_candidates[0].id] = "main"
    elif body_candidates:
        roles[body_candidates[0].id] = "back"
    pairs = _find_similar_pairs([box for box in body_candidates[1:] if box.id not in roles])
    if pairs and _pair_score(pairs[0][0], pairs[0][1])["score"] <= 0.05:
        left, right = _left_right(pairs[0][0], pairs[0][1])
        roles[left.id] = "front_left"
        roles[right.id] = "front_right"
    if len(pairs) > 1:
        left, right = _left_right(pairs[1][0], pairs[1][1])
        roles[left.id] = "sleeve_left"
        roles[right.id] = "sleeve_right"
    for box in ordered:
        roles.setdefault(box.id, "unknown")
    return roles


def _find_similar_pairs(boxes: list[PieceBox]) -> list[tuple[PieceBox, PieceBox]]:
    candidates: list[tuple[float, PieceBox, PieceBox]] = []
    for i, left in enumerate(boxes):
        for right in boxes[i + 1 :]:
            pair = _pair_score(left, right)
            # 镜像主片应非常接近；袖片等近似配对允许稍宽松但仍避免明显错配。
            if pair["score"] <= 0.15 and pair["area_delta"] <= 0.21:
                candidates.append((pair["score"], left, right))
    pairs: list[tuple[PieceBox, PieceBox]] = []
    used: set[str] = set()
    for _, left, right in sorted(candidates, key=lambda item: item[0]):
        if left.id in used or right.id in used:
            continue
        pairs.append((left, right))
        used.add(left.id)
        used.add(right.id)
    return pairs


def _pair_score(left: PieceBox, right: PieceBox) -> dict[str, float]:
    area_delta = abs(left.area - right.area) / max(left.area, right.area, 1)
    width_delta = abs(left.width - right.width) / max(left.width, right.width, 1)
    height_delta = abs(left.height - right.height) / max(left.height, right.height, 1)
    score = area_delta * 0.5 + width_delta * 0.25 + height_delta * 0.25
    return {"score": score, "area_delta": area_delta, "width_delta": width_delta, "height_delta": height_delta}


def _left_right(a: PieceBox, b: PieceBox) -> tuple[PieceBox, PieceBox]:
    return (a, b) if a.center_x <= b.center_x else (b, a)


def _role_lanes(canvas: dict[str, Any]) -> dict[str, tuple[float, float, float, float]]:
    w = float(canvas["width"])
    h = float(canvas["height"])
    margin = float(canvas.get("margin", 96))
    return {
        "front_left": (margin, margin, w * 0.24, h * 0.48),
        "front_right": (w * 0.26, margin, w * 0.24, h * 0.48),
        "back": (w * 0.56, margin, w * 0.34, h * 0.52),
        "main": (w * 0.3, h * 0.22, w * 0.4, h * 0.52),
        "sleeve_left": (margin, h * 0.6, w * 0.28, h * 0.26),
        "sleeve_right": (w * 0.34, h * 0.6, w * 0.28, h * 0.26),
        "collar": (w * 0.66, h * 0.62, w * 0.25, h * 0.12),
        "placket": (w * 0.66, h * 0.78, w * 0.25, h * 0.1),
        "strip": (margin, h * 0.9, w * 0.82, h * 0.08),
        "unknown": (margin, h * 0.82, w * 0.82, h * 0.12),
    }


def _place_in_lane(
    box: PieceBox,
    lane: tuple[float, float, float, float],
    index: int,
    canvas: dict[str, Any],
    role_count: int = 1,
) -> LanePlacement:
    x, y, lane_w, lane_h = lane
    margin = float(canvas.get("margin", 96))
    canvas_w = float(canvas["width"])
    canvas_h = float(canvas["height"])
    lane_w = max(lane_w, min(canvas_w - margin - x, box.width + margin))
    lane_h = max(lane_h, min(canvas_h - margin - y, box.height + margin))
    columns = max(1, min(3, int(lane_w // max(1, box.width + 24))))
    if role_count <= 2 and lane_w >= (box.width * 2 + 24):
        columns = min(2, columns)
    step = max(box.width + 24, lane_w / max(1, columns))
    row_step = max(box.height + 24, min(max(box.height + 24, lane_h / 3), box.height * 1.5 + 24))
    raw_x = x + (index % columns) * step
    raw_y = y + int(index // columns) * row_step
    max_x = max(margin, canvas_w - margin - box.width)
    max_y = max(margin, canvas_h - margin - box.height)
    next_x = min(max(raw_x, margin), max_x)
    next_y = min(max(raw_y, margin), max_y)
    clipped = abs(next_x - raw_x) > 0.01 or abs(next_y - raw_y) > 0.01 or box.width > lane_w or box.height > lane_h
    return LanePlacement(next_x, next_y, clipped)


def _texture_snap_settings(canvas: dict[str, Any]) -> tuple[float, float] | None:
    if not canvas.get("tile", True):
        return None
    angle = float(canvas.get("global_texture_angle", 0) or 0) % 180
    if min(angle, 180 - angle) > 0.01:
        return None
    repeat = canvas.get("texture_repeat") or {}
    if not repeat.get("has_repeat"):
        return None
    scale = max(0.05, float(canvas.get("texture_scale", 1) or 1))
    period_x = float(repeat.get("period_x", 0) or 0) * scale
    period_y = float(repeat.get("period_y", 0) or 0) * scale
    period_x = period_x if period_x >= 4 else 0
    period_y = period_y if period_y >= 4 else 0
    if not period_x and not period_y:
        return None
    return period_x, period_y


def _snap_to_texture_period(
    box: PieceBox,
    lane: tuple[float, float, float, float],
    design_x: float,
    design_y: float,
    snap: tuple[float, float],
) -> tuple[float, float, bool]:
    period_x, period_y = snap
    x, y, lane_w, lane_h = lane
    max_x = max(x, x + lane_w - box.width)
    max_y = max(y, y + lane_h - box.height)
    next_x = _snap_value_in_range(design_x, period_x, x, max_x) if period_x else design_x
    next_y = _snap_value_in_range(design_y, period_y, y, max_y) if period_y else design_y
    snapped = abs(next_x - design_x) > 0.01 or abs(next_y - design_y) > 0.01
    return next_x, next_y, snapped


def _snap_value_in_range(value: float, period: float, minimum: float, maximum: float) -> float:
    if period <= 0:
        return value
    low_index = math.ceil(minimum / period)
    high_index = math.floor(maximum / period)
    if low_index > high_index:
        return min(max(value, minimum), maximum)
    target_index = round(value / period)
    snap_index = min(max(target_index, low_index), high_index)
    return snap_index * period


def _mirror_role(role: str, canvas: dict[str, Any]) -> bool:
    return canvas.get("symmetry") == "mirror" and role in {"front_right", "sleeve_right"}


def _role_confidence(role: str, box: PieceBox) -> float:
    if role == "unknown":
        return 0.35
    if role == "main":
        return 0.68
    if role in {"collar", "placket", "strip"}:
        return 0.72 if box.aspect >= 3 or box.aspect <= 0.28 else 0.5
    return 0.78


def _orientation_rotation(box: PieceBox, role: str) -> tuple[int, str]:
    if role not in {"front_left", "front_right", "back"}:
        return 0, ""
    score = _neck_opening_orientation_score(box.mask_path)
    if score is None:
        return 0, "裁片上下方向置信度偏低，建议人工确认。"
    if score <= -0.08:
        return 180, "已按版型方向旋转 180°。"
    if score >= 0.08:
        return 0, ""
    return 0, "裁片上下方向置信度偏低，建议人工确认。"


def _neck_opening_orientation_score(mask_path: str) -> float | None:
    if not mask_path:
        return None
    path = Path(mask_path)
    if not path.exists():
        return None
    try:
        with Image.open(path).convert("L") as mask:
            width, height = mask.size
            if width < 8 or height < 8:
                return None
            band_h = max(4, min(height // 3, int(height * 0.28)))
            center_left = width // 3
            center_right = max(center_left + 1, width - center_left)
            top_full = mask.crop((0, 0, width, band_h))
            bottom_full = mask.crop((0, height - band_h, width, height))
            top_center = mask.crop((center_left, 0, center_right, band_h))
            bottom_center = mask.crop((center_left, height - band_h, center_right, height))
            full_score = _transparent_ratio(top_full) - _transparent_ratio(bottom_full)
            center_score = _transparent_ratio(top_center) - _transparent_ratio(bottom_center)
            return center_score * 0.7 + full_score * 0.3
    except Exception:
        return None


def _transparent_ratio(mask: Image.Image) -> float:
    pixels = mask.tobytes()
    if not pixels:
        return 0.0
    transparent = sum(1 for value in pixels if value < 16)
    return transparent / len(pixels)


def _fit_note(role: str, confidence: float, garment_type: str) -> str:
    garment_label = {"unknown": "未知", "t_shirt": "T 恤", "shirt": "衬衫"}.get(garment_type, garment_type or "未知")
    if role == "unknown":
        return "未能可靠识别裁片部位，请在全局适配面板中人工确认。"
    if confidence < 0.65:
        return "自动识别置信度偏低，建议检查裁片方向与部位。"
    return f"{garment_label} 模板按 {ROLE_LABELS.get(role, role)} 规则映射。"


def _default_seam_links(role: str) -> list[dict[str, str]]:
    links = {
        "front_left": [
            {"edge": "shoulder", "from_position": "top", "to_role": "back", "to_edge": "shoulder", "to_position": "top"},
            {"edge": "side", "from_position": "right", "to_role": "back", "to_edge": "side", "to_position": "left"},
        ],
        "front_right": [
            {"edge": "shoulder", "from_position": "top", "to_role": "back", "to_edge": "shoulder", "to_position": "top"},
            {"edge": "side", "from_position": "left", "to_role": "back", "to_edge": "side", "to_position": "right"},
        ],
        "sleeve_left": [{"edge": "sleeve_cap", "from_position": "top", "to_role": "front_left", "to_edge": "armhole", "to_position": "left"}],
        "sleeve_right": [{"edge": "sleeve_cap", "from_position": "top", "to_role": "front_right", "to_edge": "armhole", "to_position": "right"}],
        "collar": [{"edge": "neckline", "from_position": "bottom", "to_role": "front_left", "to_edge": "neckline", "to_position": "top"}],
    }
    return links.get(role, [])


def _filter_seam_links(mapped: list[dict[str, Any]]) -> None:
    roles = {entry.get("piece_role") for entry in mapped}
    for entry in mapped:
        entry["seam_links"] = [
            link
            for link in entry.get("seam_links", [])
            if link.get("to_role") in roles
        ]


def _default_safe_zones(box: PieceBox, design_canvas: dict[str, Any] | None = None) -> list[dict[str, float]]:
    inset_x_ratio = _ratio_setting(design_canvas, "safe_zone_inset_x_ratio", 0.16)
    inset_y_ratio = _ratio_setting(design_canvas, "safe_zone_inset_y_ratio", 0.14)
    inset_x = box.width * inset_x_ratio
    inset_y = box.height * inset_y_ratio
    return [{"x": inset_x, "y": inset_y, "width": max(1, box.width - inset_x * 2), "height": max(1, box.height - inset_y * 2)}]


def _default_avoid_zones(box: PieceBox, design_canvas: dict[str, Any] | None = None) -> list[dict[str, float]]:
    seam_ratio = _ratio_setting(design_canvas, "avoid_zone_seam_ratio", 0.06)
    min_px = _positive_float_setting(design_canvas, "avoid_zone_min_px", 8)
    seam = max(min_px, min(box.width, box.height) * seam_ratio)
    return [
        {"x": 0, "y": 0, "width": box.width, "height": seam},
        {"x": 0, "y": box.height - seam, "width": box.width, "height": seam},
        {"x": 0, "y": 0, "width": seam, "height": box.height},
        {"x": box.width - seam, "y": 0, "width": seam, "height": box.height},
    ]


def _ratio_setting(design_canvas: dict[str, Any] | None, key: str, default: float) -> float:
    try:
        value = float((design_canvas or {}).get(key, default))
    except (TypeError, ValueError):
        return default
    return max(0.0, min(0.45, value))


def _positive_float_setting(design_canvas: dict[str, Any] | None, key: str, default: float) -> float:
    try:
        value = float((design_canvas or {}).get(key, default))
    except (TypeError, ValueError):
        return default
    return max(0.0, value)


# ---------------------------------------------------------------------------
# 缝线对齐约束
# ---------------------------------------------------------------------------

_EDGE_AXES: dict[str, tuple[str, ...]] = {
    "shoulder": ("x",),
    "neckline": ("x",),
    "hem": ("x",),
    "side": ("x", "y"),
    "armhole": ("x", "y"),
    "sleeve_cap": ("x", "y"),
}

# 调整优先级：越靠后越容易被调整（保持主片不动，调整附属片）
_ROLE_ADJUST_PRIORITY: dict[str, int] = {
    "back": 0,          # 后片最稳，不调
    "front_left": 1,
    "front_right": 1,
    "sleeve_left": 2,
    "sleeve_right": 2,
    "collar": 3,
    "placket": 3,
    "strip": 3,
    "main": 0,
    "unknown": 4,
}


def _apply_seam_alignment(mapped: list[dict[str, Any]], snap: tuple[float, float]) -> None:
    """
    对所有已定位的裁片执行缝线对齐约束。

    原理
    ----
    设计画布上平铺的纹理以 (period_x, period_y) 为最小重复单元。
    两个裁片 A、B 在缝合边处的花型连续，等价于：
        A 的缝合代表坐标 ≡ B 的缝合代表坐标  (mod period)

    对于每对 seam_link (A.edge → B.to_edge)：
    1. 计算 A 和 B 各自缝合边的"纹理相位代表值"：
       - 水平边（shoulder/neckline/hem）→ design_x
       - 垂直边（side/armhole/sleeve_cap）→ design_y
    2. 计算相位差 delta = phase_A - phase_B
    3. 将 delta 取整到最近周期的整数倍，得到修正量 correction
    4. 按优先级：优先调整优先级高（数值大）的裁片，保持低优先级的裁片不动
    5. 把修正量加到被调整裁片对应轴的 design_x/y 上

    注意
    ----
    - 只在平铺模式下（snap 不为 None）运行，因为非平铺时不存在周期对齐语义
    - 调整量有界，以初始取样坐标为中心，最多允许在 ±2 个周期内微调
    - 调整后把对齐信息追加到 fit_note，便于调试
    """
    period_x, period_y = snap
    # 建立 role → entry 的快速查找表（每个 role 只取第一个，多裁片同角色时跳过）
    by_role: dict[str, dict[str, Any]] = {}
    for entry in mapped:
        role = entry["piece_role"]
        if role not in by_role:
            by_role[role] = entry

    original_phase = {(entry["id"], axis): _seam_phase(entry, axis) for entry in mapped for axis in ("x", "y")}

    for entry_a in mapped:
        role_a = entry_a["piece_role"]
        for link in entry_a.get("seam_links", []):
            edge_a = link.get("edge", "")
            role_b = link.get("to_role", "")
            edge_b = link.get("to_edge", "")
            axes = _EDGE_AXES.get(edge_a) or _EDGE_AXES.get(edge_b) or ()
            if not axes:
                continue
            entry_b = by_role.get(role_b)
            if entry_b is None:
                continue

            for axis in axes:
                period = period_x if axis == "x" else period_y
                if period <= 0:
                    continue

                phase_a = _seam_phase(entry_a, axis, link.get("from_position"))
                phase_b = _seam_phase(entry_b, axis, link.get("to_position"))
                delta = phase_a - phase_b
                correction = _nearest_period_correction(delta, period)
                if abs(correction) < 0.5:
                    continue

                pri_a = _ROLE_ADJUST_PRIORITY.get(role_a, 4)
                pri_b = _ROLE_ADJUST_PRIORITY.get(role_b, 4)
                if pri_a > pri_b:
                    applied = _shift_entry(entry_a, axis, -correction, period, original_phase[(entry_a["id"], axis)])
                    _append_seam_note(entry_a, role_b, edge_a, axis, applied)
                elif pri_b > pri_a:
                    applied = _shift_entry(entry_b, axis, correction, period, original_phase[(entry_b["id"], axis)])
                    _append_seam_note(entry_b, role_a, edge_b, axis, applied)
                else:
                    half = correction / 2
                    applied_a = _shift_entry(entry_a, axis, -half, period, original_phase[(entry_a["id"], axis)])
                    applied_b = _shift_entry(entry_b, axis, half, period, original_phase[(entry_b["id"], axis)])
                    _append_seam_note(entry_a, role_b, edge_a, axis, applied_a)
                    _append_seam_note(entry_b, role_a, edge_b, axis, applied_b)


def _seam_phase(entry: dict[str, Any], axis: str, position: str | None = None) -> float:
    """返回裁片指定边在纹理轴上的代表坐标；缺少边位置时回退到起始坐标。"""
    region = entry["design_region"]
    x = float(region["x"])
    y = float(region["y"])
    width = float(region.get("width", 0) or 0)
    height = float(region.get("height", 0) or 0)
    if axis == "x":
        if position == "right":
            return x + width
        if position in {"center", "middle"}:
            return x + width / 2
        return x
    if position == "bottom":
        return y + height
    if position in {"center", "middle"}:
        return y + height / 2
    return y


def _nearest_period_correction(delta: float, period: float) -> float:
    """
    计算将 delta 修正到最近周期整数倍所需的修正量。
    例：period=100, delta=230 → nearest multiple=200 → correction=30
         period=100, delta=270 → nearest multiple=300 → correction=-30
    """
    if period <= 0:
        return 0.0
    nearest = round(delta / period) * period
    return delta - nearest


def _shift_entry(entry: dict[str, Any], axis: str, amount: float, period: float, origin: float) -> float:
    """在 design_region 中对指定轴施加偏移，并返回实际应用的偏移量。"""
    region = entry["design_region"]
    key = "x" if axis == "x" else "y"
    current = float(region[key])
    limit = abs(period) * 2
    target = min(max(current + amount, origin - limit), origin + limit)
    if axis == "x":
        region["x"] = round(target, 2)
    else:
        region["y"] = round(target, 2)
    return target - current


def _append_seam_note(entry: dict[str, Any], partner_role: str, edge: str, axis: str, amount: float) -> None:
    """把缝线对齐调整信息追加到 fit_note，便于前端展示和调试。"""
    axis_label = "水平" if axis == "x" else "垂直"
    partner_label = ROLE_LABELS.get(partner_role, partner_role)
    edge_label = {
        "shoulder": "肩缝", "neckline": "领口缝", "hem": "下摆缝",
        "side": "侧缝", "armhole": "袖窿缝", "sleeve_cap": "袖山缝",
    }.get(edge, edge)
    note_fragment = f"已按{axis_label}纹理周期对齐{partner_label}{edge_label}（调整 {amount:+.1f}px）。"
    current = entry.get("fit_note", "")
    entry["fit_note"] = f"{current} {note_fragment}".strip()
