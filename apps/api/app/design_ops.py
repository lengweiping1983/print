from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageOps


def build_design_texture_canvas(texture_path: Path, out_path: Path, design_canvas: dict[str, Any]) -> Path:
    width = int(design_canvas.get("width") or 2048)
    height = int(design_canvas.get("height") or 2048)
    scale = max(0.05, float(design_canvas.get("texture_scale", 1) or 1))
    angle = float(design_canvas.get("global_texture_angle", 0) or 0)
    offset_x = int(float(design_canvas.get("texture_offset_x", 0) or 0))
    offset_y = int(float(design_canvas.get("texture_offset_y", 0) or 0))
    tile_enabled = bool(design_canvas.get("tile", True))
    mirror = bool(design_canvas.get("mirror", False))

    with Image.open(texture_path).convert("RGBA") as src:
        tile_w = max(1, int(src.width * scale))
        tile_h = max(1, int(src.height * scale))
        tile = src.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
        if mirror:
            tile = _mirror_tile(tile)
        if angle:
            tile = tile.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC)
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        if tile_enabled:
            start_x = -tile.width + (offset_x % max(1, tile.width))
            start_y = -tile.height + (offset_y % max(1, tile.height))
            for y in range(start_y, height + tile.height, tile.height):
                for x in range(start_x, width + tile.width, tile.width):
                    canvas.alpha_composite(tile, (x, y))
        else:
            canvas.alpha_composite(tile, ((width - tile.width) // 2 + offset_x, (height - tile.height) // 2 + offset_y))

    _draw_anchor_guides(canvas, design_canvas)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path


def build_fit_preview(
    pieces: list[dict[str, Any]],
    design_canvas_path: Path,
    out_path: Path,
    canvas_size: tuple[int, int],
) -> Path:
    from .image_ops import render_layout

    return render_layout(pieces, design_canvas_path, out_path, canvas_size)


def _mirror_tile(src: Image.Image) -> Image.Image:
    tile = Image.new("RGBA", (src.width * 2, src.height * 2), (0, 0, 0, 0))
    tile.alpha_composite(src, (0, 0))
    tile.alpha_composite(ImageOps.mirror(src), (src.width, 0))
    tile.alpha_composite(ImageOps.flip(src), (0, src.height))
    tile.alpha_composite(ImageOps.mirror(ImageOps.flip(src)), (src.width, src.height))
    return tile


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
