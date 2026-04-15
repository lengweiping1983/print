import math
from collections import deque
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageChops, ImageDraw, ImageOps

from .config import MIN_COMPONENT_AREA


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as img:
        return img.size


def has_transparent_alpha(image_path: Path, transparent_threshold: int = 250) -> bool:
    with Image.open(image_path) as img:
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
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path).convert("RGBA") as img:
        r, g, b, alpha = img.split()
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
        background = _scanline_edge_connected_background(candidate.tobytes(), width, height)
        alpha_bytes = bytearray(width * height)
        for idx, is_background in enumerate(background):
            alpha_bytes[idx] = 0 if is_background else 255

        out = img.copy()
        out.putalpha(Image.frombytes("L", (width, height), bytes(alpha_bytes)))
        out.save(out_path)
    return out_path


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


def extract_alpha_components(
    image_path: Path,
    out_dir: Path,
    min_area: int = MIN_COMPONENT_AREA,
) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path).convert("RGBA") as img:
        alpha = img.getchannel("A")
        width, height = img.size
        alpha_bytes = alpha.tobytes()

    mask = bytearray(1 if a > 10 else 0 for a in alpha_bytes)
    visited = bytearray(width * height)
    pieces: list[dict] = []

    start = 0
    while True:
        start = mask.find(1, start)
        if start == -1:
            break

        spans, area, min_x, min_y, max_x, max_y, sum_x, sum_y = _collect_component_spans(start, mask, visited, width, height)
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
            mask[row_start + x] = 0

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
    with Image.open(source_path).convert("RGBA") as src:
        tile = Image.new("RGBA", (src.width * 2, src.height * 2), (0, 0, 0, 0))
        tile.alpha_composite(src, (0, 0))
        tile.alpha_composite(ImageOps.mirror(src), (src.width, 0))
        tile.alpha_composite(ImageOps.flip(src), (0, src.height))
        tile.alpha_composite(ImageOps.mirror(ImageOps.flip(src)), (src.width, src.height))
        out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for y in range(0, height, tile.height):
            for x in range(0, width, tile.width):
                out.alpha_composite(tile, (x, y))
        out.save(out_path)
    return width, height


def make_offset_tile(source_path: Path, out_path: Path, width: int, height: int) -> tuple[int, int]:
    with Image.open(source_path).convert("RGBA") as src:
        canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for y in range(0, height + src.height, src.height):
            for x in range(0, width + src.width, src.width):
                canvas.alpha_composite(src, (x - src.width // 2, y - src.height // 2))
        canvas = ImageChops.offset(canvas, width // 2, height // 2)
        canvas.save(out_path)
    return width, height


def render_piece(mask_path: Path, texture_path: Path, transform: dict, out_path: Path) -> Path:
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
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)
    return out_path


def render_layout(
    pieces: Iterable[dict],
    texture_path: Path,
    out_path: Path,
    canvas_size: tuple[int, int],
    include_outline: bool = True,
    include_labels: bool = True,
) -> Path:
    out = Image.new("RGBA", canvas_size, (255, 255, 255, 0))
    draw = ImageDraw.Draw(out)
    for piece in pieces:
        tmp_path = out_path.parent / f"_{piece['id']}.png"
        render_piece(Path(piece["mask_path"]), texture_path, piece["transform"], tmp_path)
        with Image.open(tmp_path).convert("RGBA") as rendered:
            out.alpha_composite(rendered, (piece["source_x"], piece["source_y"]))
        tmp_path.unlink(missing_ok=True)
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

