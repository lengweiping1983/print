from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat

import logging

logger = logging.getLogger(__name__)

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy 缺失时走纯 Python 回退
    np = None


SOURCE_KEYWORDS = {
    "logo",
    "text",
    "number",
    "fish",
    "main",
    "placement",
    "胸前",
    "主图",
    "主视觉",
    "定位",
    "文字",
    "号码",
    "数字",
    "鱼",
    "图标",
    "标志",
    "商标",
}

SEAMLESS_KEYWORDS = {
    "pattern",
    "texture",
    "water",
    "camo",
    "camouflage",
    "floral",
    "fabric",
    "print",
    "repeat",
    "水纹",
    "迷彩",
    "花纹",
    "花卉",
    "满版",
    "布料",
    "面料",
    "底纹",
    "连续",
    "重复",
    "抽象",
}


def analyze_texture_fit_source(
    image_path: Path,
    *,
    source_type: str,
    prompt: str = "",
    filename: str = "",
) -> dict[str, Any]:
    text = f"{prompt} {filename}".lower()
    reasons: list[str] = []
    source_score = 0.0
    seamless_score = 0.0

    if source_type == "garment_photo":
        source_score += 3.0
        reasons.append("衣服参考图默认按原图定位。")

    source_hits = sorted(keyword for keyword in SOURCE_KEYWORDS if keyword in text)
    seamless_hits = sorted(keyword for keyword in SEAMLESS_KEYWORDS if keyword in text)
    if source_hits:
        source_score += 2.2 + min(1.0, len(source_hits) * 0.2)
        reasons.append(f"命中定位图案关键词：{', '.join(source_hits[:4])}。")
    if seamless_hits:
        seamless_score += 2.0 + min(1.0, len(seamless_hits) * 0.2)
        reasons.append(f"命中满版面料关键词：{', '.join(seamless_hits[:4])}。")

    image_stats = _image_stats(image_path)
    transparent_ratio = image_stats["transparent_ratio"]
    edge_alpha_ratio = image_stats["edge_alpha_ratio"]
    edge_similarity = image_stats["edge_similarity"]
    if transparent_ratio > 0.08 or edge_alpha_ratio < 0.92:
        source_score += 2.5
        reasons.append("图片含明显透明区域，按主体图案处理。")
    elif edge_similarity < 0.82:
        seamless_score += 0.8
        reasons.append("图片整体不透明且边缘连续性一般，适合先做无缝预处理。")
    else:
        seamless_score += 0.35
        reasons.append("图片整体不透明，允许作为满版面料平铺。")

    if not source_hits and not seamless_hits and source_type in {"ai", "library"}:
        seamless_score += 0.6
        reasons.append("生成面料默认偏向满版面料。")

    delta = seamless_score - source_score
    if delta >= 1.0:
        recommendation = "seamless"
        confidence = min(0.95, 0.58 + abs(delta) * 0.08)
    else:
        recommendation = "source"
        confidence = min(0.95, 0.58 + abs(delta) * 0.08)
        if abs(delta) < 0.7:
            reasons.append("判断置信度不高，保守使用原图。")

    repeat_period = detect_repeat_period(image_path, image_stats=image_stats)
    content_centroid = detect_content_centroid(image_path, image_stats=image_stats)

    return {
        "recommendation": recommendation,
        "confidence": round(confidence, 3),
        "source_score": round(source_score, 3),
        "seamless_score": round(seamless_score, 3),
        "transparent_ratio": round(transparent_ratio, 4),
        "edge_alpha_ratio": round(edge_alpha_ratio, 4),
        "edge_similarity": round(edge_similarity, 4),
        "source_keywords": source_hits,
        "seamless_keywords": seamless_hits,
        "repeat_period": repeat_period,
        "content_centroid": content_centroid,
        "reasons": reasons,
    }


def detect_content_centroid(image_path: Path, *, image_stats: dict[str, float] | None = None) -> dict[str, Any]:
    result = {
        "has_content": False,
        "centroid": {"x": 0.0, "y": 0.0},
        "centroid_unit": "px",
        "content_bbox": {"x": 0, "y": 0, "width": 0, "height": 0},
        "opaque_ratio": 0.0,
        "confidence": 0.0,
        "method": "none",
    }
    stats = image_stats or _image_stats(image_path)
    with Image.open(image_path).convert("RGBA") as img:
        width, height = img.size
        if stats["transparent_ratio"] > 0.08 or stats["edge_alpha_ratio"] < 0.92:
            alpha = img.getchannel("A")
            mask = [value > 10 for value in alpha.tobytes()]
            return _content_result_from_mask(mask, width, height, "alpha_centroid_v1", max_coverage=0.85)

        rgb = img.convert("RGB")
        stat = ImageStat.Stat(rgb)
        channel_std = sum(stat.stddev[:3]) / 3
        if channel_std < 8:
            return result
        bg = _edge_average_rgb(rgb)
        mask = _foreground_mask(rgb, bg, _foreground_threshold(channel_std))
        return _content_result_from_mask(mask, width, height, "foreground_centroid_v1", max_coverage=0.65)


def detect_repeat_period(image_path: Path, *, image_stats: dict[str, float] | None = None) -> dict[str, Any]:
    result = {
        "has_repeat": False,
        "period_x": 0,
        "period_y": 0,
        "confidence_x": 0.0,
        "confidence_y": 0.0,
        "method": "autocorrelation_v1",
    }
    stats = image_stats or _image_stats(image_path)

    with Image.open(image_path).convert("RGBA") as img:
        if stats["transparent_ratio"] > 0.08 or stats["edge_alpha_ratio"] < 0.92:
            cropped = _crop_repeatable_alpha_region(img)
            if cropped is None:
                return result
            img = cropped
        width, height = img.size
        scale = min(1.0, 512 / max(width, height))
        if scale < 1:
            sample_size = (max(1, int(width * scale)), max(1, int(height * scale)))
            img = img.resize(sample_size, Image.Resampling.BOX)
        else:
            sample_size = (width, height)

        gray = img.convert("L")
        if ImageStat.Stat(gray).stddev[0] < 2.0:
            return result

        x_period, x_confidence = _detect_axis_period(_axis_projection(gray, "x"))
        y_period, y_confidence = _detect_axis_period(_axis_projection(gray, "y"))

    scale_x = sample_size[0] / max(1, width)
    scale_y = sample_size[1] / max(1, height)
    period_x = int(round(x_period / scale_x)) if x_period else 0
    period_y = int(round(y_period / scale_y)) if y_period else 0

    result.update(
        {
            "period_x": period_x,
            "period_y": period_y,
            "confidence_x": round(x_confidence, 3),
            "confidence_y": round(y_confidence, 3),
        }
    )
    result["has_repeat"] = bool(period_x or period_y)
    return result


def _image_stats(image_path: Path) -> dict[str, float]:
    try:
        with Image.open(image_path).convert("RGBA") as img:
            alpha = img.getchannel("A")
            alpha_stat = ImageStat.Stat(alpha)
            transparent_ratio = 1 - (alpha_stat.mean[0] / 255)
            width, height = img.size
            edge_alpha_ratio = _edge_alpha_ratio(alpha)

            rgb = img.convert("RGB")
            left = rgb.crop((0, 0, 1, height)).resize((1, 64))
            right = rgb.crop((width - 1, 0, width, height)).resize((1, 64))
            top = rgb.crop((0, 0, width, 1)).resize((64, 1))
            bottom = rgb.crop((0, height - 1, width, height)).resize((64, 1))
            horizontal = _normalized_diff(left, right)
            vertical = _normalized_diff(top, bottom)
            edge_similarity = 1 - ((horizontal + vertical) / 2)
            return {
                "transparent_ratio": transparent_ratio,
                "edge_alpha_ratio": edge_alpha_ratio,
                "edge_similarity": max(0.0, min(1.0, edge_similarity)),
            }
    except Exception as exc:
        logger.exception("分析图片统计信息失败: %s", image_path)
        raise RuntimeError(f"无法分析图片统计信息 {image_path}: {exc}") from exc


def _crop_repeatable_alpha_region(img: Image.Image) -> Image.Image | None:
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        return None
    width, height = img.size
    bbox_w = bbox[2] - bbox[0]
    bbox_h = bbox[3] - bbox[1]
    if bbox_w < 12 or bbox_h < 12:
        return None

    coverage = (bbox_w * bbox_h) / max(1, width * height)
    if coverage < 0.35:
        return None

    cropped = img.crop(bbox)
    cropped_alpha = cropped.getchannel("A")
    cropped_alpha_stat = ImageStat.Stat(cropped_alpha)
    transparent_ratio = 1 - (cropped_alpha_stat.mean[0] / 255)
    if transparent_ratio > 0.08 or _edge_alpha_ratio(cropped_alpha) < 0.92:
        return None
    return cropped


def _edge_points(width: int, height: int) -> list[tuple[int, int]]:
    points: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for x in range(width):
        for y in (0, height - 1):
            point = (x, y)
            if point not in seen:
                points.append(point)
                seen.add(point)
    for y in range(height):
        for x in (0, width - 1):
            point = (x, y)
            if point not in seen:
                points.append(point)
                seen.add(point)
    return points


def _edge_alpha_ratio(alpha: Image.Image) -> float:
    pixels = alpha.load()
    if pixels is None:
        return 0.0
    points = _edge_points(*alpha.size)
    if not points:
        return 0.0
    return min(1.0, sum(float(pixels[x, y]) for x, y in points) / (len(points) * 255))


def _normalized_diff(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a, b)
    stat = ImageStat.Stat(diff)
    return min(1.0, sum(stat.mean[:3]) / (3 * 255))


def _axis_projection(image: Image.Image, axis: str) -> list[float]:
    width, height = image.size
    if np is not None:
        arr = np.asarray(image, dtype=np.float32)
        return arr.mean(axis=0 if axis == "x" else 1).tolist()
    pixels = list(image.tobytes())
    if axis == "x":
        return [sum(pixels[y * width + x] for y in range(height)) / height for x in range(width)]
    return [sum(pixels[y * width + x] for x in range(width)) / width for y in range(height)]


def _detect_axis_period(values: Any) -> tuple[int, float]:
    if np is not None:
        series_np = np.asarray(values, dtype=np.float64)
        if series_np.size < 12:
            return 0, 0.0
        series_np = series_np - float(series_np.mean())
        variance = float(np.dot(series_np, series_np))
        if variance <= 1e-6:
            return 0, 0.0
        min_period = 4
        max_period = min(int(series_np.size) // 2, 256)
        if max_period < min_period:
            return 0, 0.0
        scores = []
        for shift in range(1, max_period + 1):
            left = series_np[:-shift]
            right = series_np[shift:]
            denom = math.sqrt(float(np.dot(left, left))) * math.sqrt(float(np.dot(right, right)))
            scores.append(float(np.dot(left, right)) / denom if denom > 1e-6 else 0.0)
        return _best_period_from_scores(scores, min_period)

    series = [float(value) for value in values]
    if len(series) < 12:
        return 0, 0.0
    mean = sum(series) / len(series)
    series = [value - mean for value in series]
    variance = sum(value * value for value in series)
    if variance <= 1e-6:
        return 0, 0.0

    min_period = 4
    max_period = min(len(series) // 2, 256)
    if max_period < min_period:
        return 0, 0.0

    scores: list[float] = []
    for shift in range(1, max_period + 1):
        left = series[:-shift]
        right = series[shift:]
        left_norm = math.sqrt(sum(value * value for value in left))
        right_norm = math.sqrt(sum(value * value for value in right))
        denom = left_norm * right_norm
        scores.append(sum(a * b for a, b in zip(left, right)) / denom if denom > 1e-6 else 0.0)

    return _best_period_from_scores(scores, min_period)


def _best_period_from_scores(scores: list[float], min_period: int) -> tuple[int, float]:
    best_period = 0
    best_score = 0.0
    for index in range(min_period - 1, len(scores)):
        previous_score = scores[index - 1] if index > 0 else -1.0
        current_score = scores[index]
        next_score = scores[index + 1] if index + 1 < len(scores) else -1.0
        shift = index + 1
        if current_score >= 0.55 and current_score >= previous_score and current_score >= next_score:
            best_period = shift
            best_score = current_score
            break

    if not best_period:
        index = max(range(min_period - 1, len(scores)), key=lambda item: scores[item])
        if scores[index] >= 0.72:
            best_period = index + 1
            best_score = scores[index]

    return best_period, max(0.0, min(1.0, best_score))


def _foreground_threshold(channel_std: float) -> float:
    return max(30.0, min(80.0, channel_std * 2.5 + 20.0))


def _foreground_mask(image: Image.Image, bg: tuple[float, float, float], threshold: float) -> Any:
    if np is not None:
        arr = np.asarray(image, dtype=np.float32)
        bg_arr = np.asarray(bg, dtype=np.float32)
        return np.linalg.norm(arr - bg_arr, axis=2) > threshold

    pixels = image.tobytes()
    mask = []
    for index in range(0, len(pixels), 3):
        dr = int(pixels[index]) - bg[0]
        dg = int(pixels[index + 1]) - bg[1]
        db = int(pixels[index + 2]) - bg[2]
        mask.append(math.sqrt(dr * dr + dg * dg + db * db) > threshold)
    return mask


def _content_result_from_mask(
    mask: Any,
    width: int,
    height: int,
    method: str,
    *,
    max_coverage: float,
) -> dict[str, Any]:
    total = max(1, width * height)
    if np is not None:
        mask_arr = np.asarray(mask, dtype=bool).reshape((height, width))
        count = int(mask_arr.sum())
    else:
        mask_arr = None
        count = sum(1 for value in mask if value)
    opaque_ratio = count / total
    result = {
        "has_content": False,
        "centroid": {"x": 0.0, "y": 0.0},
        "centroid_unit": "px",
        "content_bbox": {"x": 0, "y": 0, "width": 0, "height": 0},
        "opaque_ratio": round(opaque_ratio, 4),
        "confidence": 0.0,
        "method": method,
    }
    if count == 0 or opaque_ratio < 0.002 or opaque_ratio > max_coverage:
        return result

    if mask_arr is not None:
        ys, xs = np.nonzero(mask_arr)
        min_x = int(xs.min())
        min_y = int(ys.min())
        max_x = int(xs.max())
        max_y = int(ys.max())
        sum_x = float(xs.sum())
        sum_y = float(ys.sum())
    else:
        min_x = width
        min_y = height
        max_x = 0
        max_y = 0
        sum_x = 0.0
        sum_y = 0.0
        for index, value in enumerate(mask):
            if not value:
                continue
            x = index % width
            y = index // width
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
            sum_x += x
            sum_y += y

    bbox_w = max_x - min_x + 1
    bbox_h = max_y - min_y + 1
    bbox_ratio = (bbox_w * bbox_h) / total
    if bbox_ratio > max_coverage:
        return result

    confidence = 0.9 if method == "alpha_centroid_v1" else 0.68
    result.update(
        {
            "has_content": True,
            "centroid": {"x": round(sum_x / count, 2), "y": round(sum_y / count, 2)},
            "content_bbox": {"x": min_x, "y": min_y, "width": bbox_w, "height": bbox_h},
            "confidence": confidence,
        }
    )
    return result


def _edge_average_rgb(image: Image.Image) -> tuple[float, float, float]:
    width, height = image.size
    pixels = image.load()
    if pixels is None:
        return (0.0, 0.0, 0.0)
    samples = [pixels[x, y] for x, y in _edge_points(width, height)]
    count = max(1, len(samples))
    return (
        sum(sample[0] for sample in samples) / count,
        sum(sample[1] for sample in samples) / count,
        sum(sample[2] for sample in samples) / count,
    )
