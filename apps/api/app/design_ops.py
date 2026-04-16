from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageColor, ImageDraw, ImageFont

from .image_ops import ensure_dimensions_within_limit, ensure_image_within_limit, make_mirror_tile_image, paint_tiled

import logging

logger = logging.getLogger(__name__)


def build_design_texture_canvas(
    texture_path: Path,
    out_path: Path,
    design_canvas: dict[str, Any],
    asset_paths: dict[str, Path] | None = None,
) -> Path:
    width = int(design_canvas.get("width") or 2048)
    height = int(design_canvas.get("height") or 2048)
    scale = max(0.05, float(design_canvas.get("texture_scale", 1) or 1))
    angle = float(design_canvas.get("global_texture_angle", 0) or 0)
    offset_x = int(float(design_canvas.get("texture_offset_x", 0) or 0))
    offset_y = int(float(design_canvas.get("texture_offset_y", 0) or 0))
    tile_enabled = bool(design_canvas.get("tile", True))
    mirror = bool(design_canvas.get("mirror", False))
    ensure_dimensions_within_limit(width, height)
    ensure_image_within_limit(texture_path)

    try:
        with Image.open(texture_path).convert("RGBA") as src:
            tile_w = max(1, int(src.width * scale))
            tile_h = max(1, int(src.height * scale))
            tile = src.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
            if mirror:
                tile = make_mirror_tile_image(tile)
            if angle:
                tile = tile.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
            canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
            if tile_enabled:
                start_x = -tile.width + (offset_x % max(1, tile.width))
                start_y = -tile.height + (offset_y % max(1, tile.height))
                paint_tiled(canvas, tile, start_x, start_y)
            else:
                canvas.alpha_composite(tile, ((width - tile.width) // 2 + offset_x, (height - tile.height) // 2 + offset_y))
    except Exception as exc:
        logger.exception("加载纹理图片失败: %s", texture_path)
        raise RuntimeError(f"无法加载纹理图片 {texture_path}: {exc}") from exc

    layer_warnings = _draw_design_layers(canvas, design_canvas, asset_paths or {})
    if layer_warnings:
        design_canvas["safety_report"] = [*(design_canvas.get("safety_report") or []), *layer_warnings]
    _draw_anchor_guides(canvas, design_canvas)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path


def build_safety_report(pieces: list[dict[str, Any]], design_canvas: dict[str, Any]) -> list[dict[str, Any]]:
    report: list[dict[str, Any]] = []
    layers = [layer for layer in design_canvas.get("layers", []) if layer.get("visible", True)]
    global_pieces = [
        piece
        for piece in pieces
        if not piece.get("mirror_of")
        and piece.get("transform", {}).get("mode") == "global_canvas"
        and piece.get("transform", {}).get("global_enabled", True)
    ]
    for layer in layers:
        rect = _layer_rect(layer)
        target_roles = {str(role) for role in layer.get("target_roles", []) if role}
        candidates = [
            piece
            for piece in global_pieces
            if _piece_matches_layer(piece, rect, target_roles)
        ]
        if not candidates:
            report.append(_report_item(layer, "warning", "图层没有落在任何全局裁片取样区域内。"))
            continue
        layer_ok = False
        for piece in candidates:
            transform = piece.get("transform", {})
            region = _piece_design_rect(piece)
            if not _rects_intersect(rect, region):
                report.append(_report_item(layer, "warning", "图层超出裁片取样区域。", piece))
                continue
            if _intersects_any_avoid(rect, piece):
                report.append(_report_item(layer, "warning", "图层压到缝份或避让区，建议调整位置。", piece))
                continue
            if not _inside_any_safe(rect, piece):
                report.append(_report_item(layer, "warning", "图层未完全落在安全区内。", piece))
                continue
            layer_ok = True
        if layer_ok:
            report.append(_report_item(layer, "ok", "图层位于安全区内。", candidates[0]))
    return report


def build_fit_preview(
    pieces: list[dict[str, Any]],
    design_canvas_path: Path,
    out_path: Path,
    canvas_size: tuple[int, int],
) -> Path:
    from .image_ops import render_layout

    return render_layout(pieces, design_canvas_path, out_path, canvas_size)


def _draw_design_layers(canvas: Image.Image, design_canvas: dict[str, Any], asset_paths: dict[str, Path]) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    for layer in design_canvas.get("layers", []):
        if not layer.get("visible", True):
            continue
        layer_type = layer.get("type")
        if layer_type == "image":
            warning = _draw_image_layer(canvas, layer, asset_paths)
            if warning:
                warnings.append(warning)
        elif layer_type == "text":
            _draw_text_layer(canvas, layer)
    return warnings


def _draw_image_layer(canvas: Image.Image, layer: dict[str, Any], asset_paths: dict[str, Path]) -> dict[str, Any] | None:
    asset_id = str(layer.get("asset_id") or "")
    source = asset_paths.get(asset_id)
    if not source or not source.exists():
        logger.warning("图片图层素材缺失，渲染时已跳过: layer_id=%s asset_id=%s", layer.get("id", ""), asset_id)
        return _report_item(layer, "warning", "图片图层素材缺失，渲染时已跳过。")
    width = max(1, int(float(layer.get("width") or 1)))
    height = max(1, int(float(layer.get("height") or 1)))
    with Image.open(source).convert("RGBA") as src:
        item = src.resize((width, height), Image.Resampling.LANCZOS)
        _paste_layer(canvas, item, layer)
    return None


def _draw_text_layer(canvas: Image.Image, layer: dict[str, Any]) -> None:
    content = str(layer.get("content") or "")
    if not content:
        return
    font_size = max(8, int(float(layer.get("font_size") or 96)))
    font = _load_font(font_size)
    stroke_width = max(0, int(float(layer.get("stroke_width") or 0)))
    fill = _color(layer.get("fill") or "#111111")
    stroke = _color(layer.get("stroke") or "#ffffff")
    probe = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    draw = ImageDraw.Draw(probe)
    bbox = draw.multiline_textbbox((0, 0), content, font=font, stroke_width=stroke_width)
    width = max(1, int(float(layer.get("width") or (bbox[2] - bbox[0] + stroke_width * 2))))
    height = max(1, int(float(layer.get("height") or (bbox[3] - bbox[1] + stroke_width * 2))))
    item = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(item)
    layer_draw.multiline_text(
        (stroke_width, stroke_width),
        content,
        font=font,
        fill=fill,
        stroke_width=stroke_width,
        stroke_fill=stroke,
        spacing=max(4, font_size // 8),
    )
    _paste_layer(canvas, item, layer)


def _paste_layer(canvas: Image.Image, item: Image.Image, layer: dict[str, Any]) -> None:
    opacity = max(0, min(1, float(layer.get("opacity", 1) if layer.get("opacity", 1) is not None else 1)))
    if opacity < 1:
        alpha = item.getchannel("A").point(lambda value: int(value * opacity))
        item.putalpha(alpha)
    rotation = float(layer.get("rotation", 0) or 0)
    if rotation:
        item = item.rotate(rotation, expand=True, resample=Image.Resampling.BICUBIC)
    x = int(round(float(layer.get("x", 0) or 0)))
    y = int(round(float(layer.get("y", 0) or 0)))
    canvas.alpha_composite(item, (x, y))


def _load_font(font_size: int) -> ImageFont.ImageFont:
    for name in ("Arial Unicode.ttf", "PingFang.ttc", "Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, font_size)
        except OSError:
            continue
    return ImageFont.load_default()


def _color(value: str) -> tuple[int, int, int, int]:
    try:
        return ImageColor.getcolor(value, "RGBA")
    except ValueError:
        return (17, 17, 17, 255)


def _draw_anchor_guides(canvas: Image.Image, design_canvas: dict[str, Any]) -> None:
    anchors = design_canvas.get("design_anchors") or {}
    if not anchors:
        return
    draw = ImageDraw.Draw(canvas, "RGBA")
    active = design_canvas.get("anchor") or "front_center"
    for name, point in anchors.items():
        x = float(point.get("x", 0))
        y = float(point.get("y", 0))
        color = (20, 184, 166, 90) if name == active else (15, 23, 42, 35)
        draw.ellipse((x - 10, y - 10, x + 10, y + 10), outline=color, width=2)


def _layer_rect(layer: dict[str, Any]) -> dict[str, float]:
    return {
        "x": float(layer.get("x", 0) or 0),
        "y": float(layer.get("y", 0) or 0),
        "width": max(1, float(layer.get("width", 1) or 1)),
        "height": max(1, float(layer.get("height", 1) or 1)),
    }


def _piece_design_rect(piece: dict[str, Any]) -> dict[str, float]:
    transform = piece.get("transform", {})
    return {
        "x": float(transform.get("design_x", piece.get("source_x", 0)) or 0) + float(transform.get("offset_x", 0) or 0),
        "y": float(transform.get("design_y", piece.get("source_y", 0)) or 0) + float(transform.get("offset_y", 0) or 0),
        "width": max(1, float(piece.get("width", 1) or 1)),
        "height": max(1, float(piece.get("height", 1) or 1)),
    }


def _piece_matches_layer(piece: dict[str, Any], rect: dict[str, float], target_roles: set[str]) -> bool:
    transform = piece.get("transform", {})
    if target_roles and str(transform.get("piece_role") or "") not in target_roles:
        return False
    return _rects_intersect(rect, _piece_design_rect(piece))


def _inside_any_safe(rect: dict[str, float], piece: dict[str, Any]) -> bool:
    safe_zones = piece.get("transform", {}).get("safe_zones") or []
    if not safe_zones:
        return True
    return any(_rect_contains(_zone_to_design_rect(zone, piece), rect) for zone in safe_zones)


def _intersects_any_avoid(rect: dict[str, float], piece: dict[str, Any]) -> bool:
    avoid_zones = piece.get("transform", {}).get("avoid_zones") or []
    return any(_rects_intersect(rect, _zone_to_design_rect(zone, piece)) for zone in avoid_zones)


def _zone_to_design_rect(zone: dict[str, Any], piece: dict[str, Any]) -> dict[str, float]:
    region = _piece_design_rect(piece)
    piece_w = max(1, float(piece.get("width", region["width"]) or region["width"]))
    piece_h = max(1, float(piece.get("height", region["height"]) or region["height"]))
    sx = region["width"] / piece_w
    sy = region["height"] / piece_h
    return {
        "x": region["x"] + float(zone.get("x", 0) or 0) * sx,
        "y": region["y"] + float(zone.get("y", 0) or 0) * sy,
        "width": max(1, float(zone.get("width", 1) or 1) * sx),
        "height": max(1, float(zone.get("height", 1) or 1) * sy),
    }


def _rects_intersect(a: dict[str, float], b: dict[str, float]) -> bool:
    return not (
        a["x"] + a["width"] <= b["x"]
        or b["x"] + b["width"] <= a["x"]
        or a["y"] + a["height"] <= b["y"]
        or b["y"] + b["height"] <= a["y"]
    )


def _rect_contains(outer: dict[str, float], inner: dict[str, float]) -> bool:
    return (
        inner["x"] >= outer["x"]
        and inner["y"] >= outer["y"]
        and inner["x"] + inner["width"] <= outer["x"] + outer["width"]
        and inner["y"] + inner["height"] <= outer["y"] + outer["height"]
    )


def _report_item(layer: dict[str, Any], level: str, message: str, piece: dict[str, Any] | None = None) -> dict[str, Any]:
    transform = piece.get("transform", {}) if piece else {}
    return {
        "layer_id": str(layer.get("id") or ""),
        "layer_name": str(layer.get("name") or "未命名图层"),
        "level": level,
        "message": message,
        "piece_id": str(piece.get("id") or "") if piece else "",
        "piece_role": str(transform.get("piece_role") or "") if piece else "",
    }
