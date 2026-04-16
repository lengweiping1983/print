import base64
import math
import warnings
from collections import deque
from io import BytesIO
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageOps
from PIL.Image import DecompressionBombWarning

from .config import MAX_IMAGE_PIXELS, MIN_COMPONENT_AREA

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("error", DecompressionBombWarning)

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - fallback keeps Pillow-only installs usable
    cv2 = None
    np = None


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as img:
        ensure_dimensions_within_limit(*img.size)
        return img.size


def ensure_dimensions_within_limit(width: int, height: int) -> None:
    pixels = int(width) * int(height)
    if pixels > MAX_IMAGE_PIXELS:
        raise ValueError(f"图片尺寸过大：{width}x{height}，超过 {MAX_IMAGE_PIXELS} 像素上限。")


def ensure_image_within_limit(path: Path) -> tuple[int, int]:
    return image_size(path)


def has_transparent_alpha(image_path: Path, transparent_threshold: int = 250) -> bool:
    ensure_image_within_limit(image_path)
    with Image.open(image_path) as img:
        return has_transparent_alpha_image(img, transparent_threshold)


def has_transparent_alpha_image(img: Image.Image, transparent_threshold: int = 250) -> bool:
    if img.mode not in {"RGBA", "LA"} and "transparency" not in img.info:
        return False
    alpha = img.convert("RGBA").getchannel("A")
    min_alpha, _ = alpha.getextrema()
    return min_alpha < transparent_threshold


def make_layout_template(
    image_path: Path,
    out_path: Path,
    white_threshold: int = 240,
    channel_delta: int = 28,
) -> Path:
    ensure_image_within_limit(image_path)
    with Image.open(image_path) as img:
        return make_layout_template_from_image(img.convert("RGBA"), out_path, white_threshold, channel_delta)


def make_layout_template_from_image(
    img: Image.Image,
    out_path: Path,
    white_threshold: int = 240,
    channel_delta: int = 28,
) -> Path:
    ensure_dimensions_within_limit(*img.size)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rgba = img.convert("RGBA")
    r, g, b, alpha = rgba.split()
    white = r.point(lambda value: 255 if value >= white_threshold else 0)
    white = ImageChops.multiply(white, g.point(lambda value: 255 if value >= white_threshold else 0))
    white = ImageChops.multiply(white, b.point(lambda value: 255 if value >= white_threshold else 0))
    max_channel = ImageChops.lighter(r, ImageChops.lighter(g, b))
    min_channel = ImageChops.darker(r, ImageChops.darker(g, b))
    neutral = ImageChops.subtract(max_channel, min_channel).point(lambda value: 255 if value <= channel_delta else 0)
    candidate = ImageChops.multiply(white, neutral)
    transparent = alpha.point(lambda value: 255 if value <= 10 else 0)
    candidate = ImageChops.lighter(candidate, transparent)
    width, height = candidate.size
    background = _edge_connected_background(candidate)
    if background is None:
        background = _scanline_edge_connected_background(candidate.tobytes(), width, height)
        alpha_bytes = bytearray(width * height)
        for idx, is_background in enumerate(background):
            alpha_bytes[idx] = 0 if is_background else 255
        alpha_mask = Image.frombytes("L", (width, height), bytes(alpha_bytes))
    else:
        alpha_mask = Image.fromarray(np.where(background, 0, 255).astype("uint8"))

    out = rgba.copy()
    out.putalpha(alpha_mask)
    out.save(out_path)
    return out_path


def make_red_marker_mask(
    image_path: Path,
    out_path: Path,
    red_min: int = 145,
    red_delta: int = 45,
) -> Path | None:
    ensure_image_within_limit(image_path)
    with Image.open(image_path) as img:
        return make_red_marker_mask_from_image(img.convert("RGBA"), out_path, red_min, red_delta)


def make_red_marker_mask_from_image(
    img: Image.Image,
    out_path: Path,
    red_min: int = 145,
    red_delta: int = 45,
) -> Path | None:
    ensure_dimensions_within_limit(*img.size)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rgba = img.convert("RGBA")
    r, g, b, alpha = rgba.split()
    max_non_red = ImageChops.lighter(g, b)
    strong_red = ImageChops.subtract(r, max_non_red)
    mask = r.point(lambda value: 255 if value >= red_min else 0)
    mask = ImageChops.multiply(mask, strong_red.point(lambda value: 255 if value >= red_delta else 0))
    mask = ImageChops.multiply(mask, alpha.point(lambda value: 255 if value > 10 else 0))

    if not mask.getbbox():
        out_path.unlink(missing_ok=True)
        return None

    mask.save(out_path)
    return out_path


def write_piece_marker_masks(pieces: list[dict], marker_mask_path: Path | None) -> int:
    if not marker_mask_path or not marker_mask_path.exists():
        return 0

    count = 0
    with Image.open(marker_mask_path).convert("L") as full_marker:
        for piece in pieces:
            bbox = piece["bbox"]
            box = (bbox["x"], bbox["y"], bbox["x"] + bbox["width"], bbox["y"] + bbox["height"])
            marker = full_marker.crop(box)
            with Image.open(piece["mask_path"]).convert("L") as piece_mask:
                marker = ImageChops.multiply(marker, piece_mask)
            marker_path = marker_path_for_mask(Path(piece["mask_path"]))
            if marker.getbbox():
                marker.save(marker_path)
                piece["marker_path"] = marker_path
                count += 1
            else:
                marker_path.unlink(missing_ok=True)
    return count


def marker_path_for_mask(mask_path: Path) -> Path:
    stem = mask_path.stem
    marker_stem = f"{stem[:-5]}_markers" if stem.endswith("_mask") else f"{stem}_markers"
    return mask_path.with_name(f"{marker_stem}.png")


def _scanline_edge_connected_background(candidate: bytes, width: int, height: int) -> bytearray:
    background = bytearray(width * height)
    queue: deque[tuple[int, int, int]] = deque()

    def add_span(seed_x: int, y: int) -> None:
        idx = y * width + seed_x
        if candidate[idx] == 0 or background[idx]:
            return

        left = seed_x
        while left > 0:
            next_idx = y * width + left - 1
            if candidate[next_idx] == 0 or background[next_idx]:
                break
            left -= 1

        right = seed_x
        while right + 1 < width:
            next_idx = y * width + right + 1
            if candidate[next_idx] == 0 or background[next_idx]:
                break
            right += 1

        row_start = y * width
        for x in range(left, right + 1):
            background[row_start + x] = 1
        queue.append((left, right, y))

    for x in range(width):
        add_span(x, 0)
        add_span(x, height - 1)
    for y in range(height):
        add_span(0, y)
        add_span(width - 1, y)

    while queue:
        left, right, y = queue.popleft()
        for next_y in (y - 1, y + 1):
            if next_y < 0 or next_y >= height:
                continue
            x = left
            row_start = next_y * width
            while x <= right:
                idx = row_start + x
                if candidate[idx] and not background[idx]:
                    add_span(x, next_y)
                    while x <= right and candidate[row_start + x] and background[row_start + x]:
                        x += 1
                x += 1

    return background


def _edge_connected_background(candidate: Image.Image):
    if cv2 is None or np is None:
        return None

    data = np.asarray(candidate, dtype=np.uint8)
    if data.ndim != 2 or data.size == 0:
        return None

    foreground = (data > 0).astype(np.uint8)
    label_count, labels, _stats, _centroids = cv2.connectedComponentsWithStats(foreground, connectivity=4)
    if label_count <= 1:
        return np.zeros_like(foreground, dtype=bool)

    edge_labels = np.unique(np.concatenate((labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1])))
    edge_labels = edge_labels[edge_labels > 0]
    if edge_labels.size == 0:
        return np.zeros_like(foreground, dtype=bool)
    return np.isin(labels, edge_labels)


def extract_alpha_components(
    image_path: Path,
    out_dir: Path,
    min_area: int = MIN_COMPONENT_AREA,
) -> list[dict]:
    ensure_image_within_limit(image_path)
    with Image.open(image_path).convert("RGBA") as img:
        return extract_alpha_components_from_image(img, out_dir, min_area)


def extract_alpha_components_from_image(
    img: Image.Image,
    out_dir: Path,
    min_area: int = MIN_COMPONENT_AREA,
) -> list[dict]:
    ensure_dimensions_within_limit(*img.size)
    out_dir.mkdir(parents=True, exist_ok=True)
    alpha = img.convert("RGBA").getchannel("A")
    width, height = alpha.size
    alpha_bytes = alpha.tobytes()
    cv2_pieces = _extract_alpha_components_cv2(alpha, out_dir, min_area)
    if cv2_pieces is not None:
        return cv2_pieces

    mask = bytearray(1 if a > 10 else 0 for a in alpha_bytes)
    visited = bytearray(width * height)
    pieces: list[dict] = []

    start = 0
    while True:
        start = mask.find(1, start)
        if start == -1:
            break

        spans, area, min_x, min_y, max_x, max_y, sum_x, sum_y = _collect_component_spans(start, mask, visited, width, height)
        for left, right, y in spans:
            row_start = y * width
            mask[row_start + left : row_start + right + 1] = b"\0" * (right - left + 1)
        start += 1
        if area < min_area:
            continue

        piece_w = max_x - min_x + 1
        piece_h = max_y - min_y + 1
        piece = Image.new("L", (piece_w, piece_h), 0)
        draw = ImageDraw.Draw(piece)
        for left, right, y in spans:
            draw.line((left - min_x, y - min_y, right - min_x, y - min_y), fill=255)

        piece_index = len(pieces) + 1
        mask_name = f"piece_{piece_index:02d}_mask.png"
        mask_path = out_dir / mask_name
        piece.save(mask_path)
        polygon = bbox_polygon(min_x, min_y, max_x, max_y)

        pieces.append(
            {
                "mask_path": mask_path,
                "polygon": polygon,
                "bbox": {"x": min_x, "y": min_y, "width": piece_w, "height": piece_h},
                "source_x": min_x,
                "source_y": min_y,
                "width": piece_w,
                "height": piece_h,
                "area": area,
                "centroid_x": sum_x / area,
                "centroid_y": sum_y / area,
            }
        )

    pieces.sort(key=lambda p: p["area"], reverse=True)
    return pieces


def _extract_alpha_components_cv2(alpha: Image.Image, out_dir: Path, min_area: int) -> list[dict] | None:
    if cv2 is None or np is None:
        return None

    data = np.asarray(alpha, dtype=np.uint8)
    if data.ndim != 2 or data.size == 0:
        return None

    binary = (data > 10).astype(np.uint8)
    label_count, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=4)
    components: list[dict] = []
    for label in range(1, label_count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        width = int(stats[label, cv2.CC_STAT_WIDTH])
        height = int(stats[label, cv2.CC_STAT_HEIGHT])
        components.append(
            {
                "label": label,
                "bbox": (x, y, width, height),
                "area": area,
                "centroid": (float(centroids[label][0]), float(centroids[label][1])),
            }
        )

    components.sort(key=lambda item: item["area"], reverse=True)
    pieces: list[dict] = []
    for index, component in enumerate(components, start=1):
        label = component["label"]
        x, y, width, height = component["bbox"]
        cropped = (labels[y : y + height, x : x + width] == label).astype(np.uint8) * 255
        mask_path = out_dir / f"piece_{index:02d}_mask.png"
        Image.fromarray(cropped).save(mask_path)
        max_x = x + width - 1
        max_y = y + height - 1
        centroid_x, centroid_y = component["centroid"]
        pieces.append(
            {
                "mask_path": mask_path,
                "polygon": bbox_polygon(x, y, max_x, max_y),
                "bbox": {"x": x, "y": y, "width": width, "height": height},
                "source_x": x,
                "source_y": y,
                "width": width,
                "height": height,
                "area": component["area"],
                "centroid_x": centroid_x,
                "centroid_y": centroid_y,
            }
        )
    return pieces


def _collect_component_spans(
    start: int,
    mask: bytearray,
    visited: bytearray,
    width: int,
    height: int,
) -> tuple[list[tuple[int, int, int]], int, int, int, int, int, int, int]:
    spans: list[tuple[int, int, int]] = []
    queue: deque[tuple[int, int, int]] = deque()
    area = 0
    min_x = width
    min_y = height
    max_x = 0
    max_y = 0
    sum_x = 0
    sum_y = 0

    def add_span(seed_x: int, y: int) -> None:
        nonlocal area, min_x, min_y, max_x, max_y, sum_x, sum_y
        idx = y * width + seed_x
        if not mask[idx] or visited[idx]:
            return

        left = seed_x
        while left > 0:
            next_idx = y * width + left - 1
            if not mask[next_idx] or visited[next_idx]:
                break
            left -= 1

        right = seed_x
        while right + 1 < width:
            next_idx = y * width + right + 1
            if not mask[next_idx] or visited[next_idx]:
                break
            right += 1

        row_start = y * width
        for x in range(left, right + 1):
            visited[row_start + x] = 1

        count = right - left + 1
        area += count
        min_x = min(min_x, left)
        min_y = min(min_y, y)
        max_x = max(max_x, right)
        max_y = max(max_y, y)
        sum_x += (left + right) * count // 2
        sum_y += y * count
        spans.append((left, right, y))
        queue.append((left, right, y))

    add_span(start % width, start // width)

    while queue:
        left, right, y = queue.popleft()
        for next_y in (y - 1, y + 1):
            if next_y < 0 or next_y >= height:
                continue
            x = left
            row_start = next_y * width
            while x <= right:
                idx = row_start + x
                if mask[idx] and not visited[idx]:
                    add_span(x, next_y)
                    while x <= right and visited[row_start + x]:
                        x += 1
                x += 1

    return spans, area, min_x, min_y, max_x, max_y, sum_x, sum_y


def bbox_polygon(min_x: int, min_y: int, max_x: int, max_y: int) -> list[list[int]]:
    return [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y]]


def make_mirror_tile(source_path: Path, out_path: Path, width: int, height: int) -> tuple[int, int]:
    ensure_image_within_limit(source_path)
    ensure_dimensions_within_limit(width, height)
    with Image.open(source_path).convert("RGBA") as src:
        tile = make_mirror_tile_image(src)
        out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for y in range(0, height, tile.height):
            for x in range(0, width, tile.width):
                out.alpha_composite(tile, (x, y))
        out.save(out_path)
    return width, height


def make_mirror_tile_image(src: Image.Image) -> Image.Image:
    tile = Image.new("RGBA", (src.width * 2, src.height * 2), (0, 0, 0, 0))
    tile.alpha_composite(src, (0, 0))
    tile.alpha_composite(ImageOps.mirror(src), (src.width, 0))
    tile.alpha_composite(ImageOps.flip(src), (0, src.height))
    tile.alpha_composite(ImageOps.mirror(ImageOps.flip(src)), (src.width, src.height))
    return tile


def make_offset_tile(source_path: Path, out_path: Path, width: int, height: int) -> tuple[int, int]:
    ensure_image_within_limit(source_path)
    ensure_dimensions_within_limit(width, height)
    with Image.open(source_path).convert("RGBA") as src:
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for y in range(0, height + src.height, src.height):
            for x in range(0, width + src.width, src.width):
                canvas.alpha_composite(src, (x - src.width // 2, y - src.height // 2))
        canvas = ImageChops.offset(canvas, width // 2, height // 2)
        canvas.save(out_path)
    return width, height


def render_piece(mask_path: Path, texture_path: Path, transform: dict, out_path: Path) -> Path:
    canvas = render_piece_image(mask_path, texture_path, transform)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    canvas.close()
    return out_path


def render_piece_image(mask_path: Path, texture_path: Path, transform: dict) -> Image.Image:
    if transform.get("mode") == "global_canvas" and transform.get("global_enabled", True):
        return render_piece_from_design_canvas_image(mask_path, texture_path, transform)
    ensure_image_within_limit(mask_path)
    ensure_image_within_limit(texture_path)
    mask = Image.open(mask_path).convert("L")
    texture = Image.open(texture_path).convert("RGBA")
    canvas = Image.new("RGBA", mask.size, (0, 0, 0, 0))
    scale = max(0.05, float(transform.get("scale", 1) or 1))
    tile_w = max(1, int(texture.width * scale))
    tile_h = max(1, int(texture.height * scale))
    tile = texture.resize((tile_w, tile_h), Image.Resampling.LANCZOS)
    if transform.get("mirror_x"):
        tile = ImageOps.mirror(tile)
    if transform.get("mirror_y"):
        tile = ImageOps.flip(tile)
    rotation = float(transform.get("rotation", 0) or 0)
    if rotation:
        tile = tile.rotate(rotation, expand=True, resample=Image.Resampling.BICUBIC)

    offset_x = int(float(transform.get("offset_x", 0) or 0))
    offset_y = int(float(transform.get("offset_y", 0) or 0))
    start_x = -tile.width + (offset_x % max(1, tile.width))
    start_y = -tile.height + (offset_y % max(1, tile.height))
    for y in range(start_y, mask.height + tile.height, tile.height):
        for x in range(start_x, mask.width + tile.width, tile.width):
            canvas.alpha_composite(tile, (x, y))
    canvas.putalpha(mask)
    composite_piece_markers(canvas, mask_path)
    mask.close()
    texture.close()
    return canvas


def render_piece_from_design_canvas(mask_path: Path, design_canvas_path: Path, transform: dict, out_path: Path) -> Path:
    sample = render_piece_from_design_canvas_image(mask_path, design_canvas_path, transform)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sample.save(out_path)
    sample.close()
    return out_path


def render_piece_from_design_canvas_image(mask_path: Path, design_canvas_path: Path, transform: dict) -> Image.Image:
    ensure_image_within_limit(mask_path)
    ensure_image_within_limit(design_canvas_path)
    mask = Image.open(mask_path).convert("L")
    with Image.open(design_canvas_path).convert("RGBA") as design_canvas:
        design_x = float(transform.get("design_x", 0) or 0) + float(transform.get("offset_x", 0) or 0)
        design_y = float(transform.get("design_y", 0) or 0) + float(transform.get("offset_y", 0) or 0)
        design_w = float(transform.get("design_width", 0) or mask.width)
        design_h = float(transform.get("design_height", 0) or mask.height)
        design_rotation = float(transform.get("design_rotation", 0) or 0)
        sample = sample_design_region(design_canvas, design_x, design_y, design_w, design_h, mask.size)
        if transform.get("mirror_x"):
            sample = ImageOps.mirror(sample)
        if transform.get("mirror_y"):
            sample = ImageOps.flip(sample)
        if design_rotation:
            rotated = sample.rotate(design_rotation, expand=False, resample=Image.Resampling.BICUBIC)
            sample = rotated
    sample.putalpha(mask)
    composite_piece_markers(sample, mask_path)
    mask.close()
    return sample


def sample_design_region(
    design_canvas: Image.Image,
    x: float,
    y: float,
    width: float,
    height: float,
    out_size: tuple[int, int],
) -> Image.Image:
    width = max(1, float(width))
    height = max(1, float(height))
    crop = Image.new("RGBA", (max(1, int(round(width))), max(1, int(round(height)))), (0, 0, 0, 0))
    start_x = int(math.floor(x))
    start_y = int(math.floor(y))
    offset_x = start_x % max(1, design_canvas.width)
    offset_y = start_y % max(1, design_canvas.height)
    for py in range(-offset_y, crop.height, design_canvas.height):
        for px in range(-offset_x, crop.width, design_canvas.width):
            crop.alpha_composite(design_canvas, (px, py))
    if crop.size != out_size:
        crop = crop.resize(out_size, Image.Resampling.LANCZOS)
    return crop


def composite_piece_markers(canvas: Image.Image, mask_path: Path) -> None:
    marker_path = marker_path_for_mask(mask_path)
    if not marker_path.exists():
        return
    with Image.open(marker_path).convert("L") as marker:
        if marker.size != canvas.size or not marker.getbbox():
            return
        overlay = Image.new("RGBA", canvas.size, (239, 0, 40, 255))
        overlay.putalpha(marker)
        canvas.alpha_composite(overlay)


def render_piece_svg(mask_path: Path, out_path: Path) -> Path:
    ensure_image_within_limit(mask_path)
    with Image.open(mask_path).convert("L") as mask:
        buffer = BytesIO()
        mask.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{mask.width}" height="{mask.height}" viewBox="0 0 {mask.width} {mask.height}">
  <title>{out_path.stem} cutting mask</title>
  <image width="{mask.width}" height="{mask.height}" href="data:image/png;base64,{encoded}" />
</svg>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(svg, encoding="utf-8")
    return out_path


def render_layout_svg(layout_png_path: Path, out_path: Path, canvas_size: tuple[int, int]) -> Path:
    width, height = canvas_size
    encoded = base64.b64encode(layout_png_path.read_bytes()).decode("ascii")
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <title>layout print preview</title>
  <image width="{width}" height="{height}" href="data:image/png;base64,{encoded}" />
</svg>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(svg, encoding="utf-8")
    return out_path


def render_layout(
    pieces: Iterable[dict],
    texture_path: Path,
    out_path: Path,
    canvas_size: tuple[int, int],
    include_outline: bool = True,
    include_labels: bool = True,
) -> Path:
    ensure_dimensions_within_limit(*canvas_size)
    ensure_image_within_limit(texture_path)
    out = Image.new("RGBA", canvas_size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(out)
    for piece in pieces:
        rendered = render_piece_image(Path(piece["mask_path"]), texture_path, piece["transform"])
        out.alpha_composite(rendered, (piece["source_x"], piece["source_y"]))
        rendered.close()
        if include_outline:
            bbox = piece["bbox"]
            draw.rectangle(
                [bbox["x"], bbox["y"], bbox["x"] + bbox["width"], bbox["y"] + bbox["height"]],
                outline=(36, 99, 235, 255),
                width=max(1, math.ceil(max(canvas_size) / 2500)),
            )
        if include_labels:
            draw.text((piece["source_x"] + 6, piece["source_y"] + 6), piece["id"], fill=(220, 38, 38, 255))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.save(out_path)
    return out_path
