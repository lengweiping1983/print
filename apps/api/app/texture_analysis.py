from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageStat


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
    "纹理",
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
        reasons.append(f"命中满版纹理关键词：{', '.join(seamless_hits[:4])}。")

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
        reasons.append("图片整体不透明，允许作为满版纹理平铺。")

    if not source_hits and not seamless_hits and source_type in {"ai", "library"}:
        seamless_score += 0.6
        reasons.append("生成纹理默认偏向满版纹理。")

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
        "reasons": reasons,
    }


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
    if stats["transparent_ratio"] > 0.08 or stats["edge_alpha_ratio"] < 0.92:
        return result

    with Image.open(image_path).convert("RGBA") as img:
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
    with Image.open(image_path).convert("RGBA") as img:
        alpha = img.getchannel("A")
        alpha_stat = ImageStat.Stat(alpha)
        transparent_ratio = 1 - (alpha_stat.mean[0] / 255)
        width, height = img.size
        edge = Image.new("L", img.size, 0)
        edge_pixels = edge.load()
        if edge_pixels is not None:
            for x in range(width):
                edge_pixels[x, 0] = 255
                edge_pixels[x, height - 1] = 255
            for y in range(height):
                edge_pixels[0, y] = 255
                edge_pixels[width - 1, y] = 255
        edge_alpha = ImageChops.multiply(alpha, edge)
        edge_alpha_stat = ImageStat.Stat(edge_alpha)
        edge_pixels_count = max(1, width * 2 + height * 2 - 4)
        edge_alpha_ratio = min(1.0, edge_alpha_stat.sum[0] / (edge_pixels_count * 255))

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


def _normalized_diff(a: Image.Image, b: Image.Image) -> float:
    diff = ImageChops.difference(a, b)
    stat = ImageStat.Stat(diff)
    return min(1.0, sum(stat.mean[:3]) / (3 * 255))


def _axis_projection(image: Image.Image, axis: str) -> list[float]:
    width, height = image.size
    pixels = list(image.tobytes())
    if axis == "x":
        return [sum(pixels[y * width + x] for y in range(height)) / height for x in range(width)]
    return [sum(pixels[y * width + x] for x in range(width)) / width for y in range(height)]


def _detect_axis_period(values: Any) -> tuple[int, float]:
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
