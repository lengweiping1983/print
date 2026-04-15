from __future__ import annotations

from typing import Any


def match_pieces_to_base(
    new_pieces: list[dict[str, Any]], base_geos: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """将新尺寸拆出的裁片匹配到基准模板的 piece_def_id。

    返回列表，每个元素包含:
    - new_piece_id: 新裁片id
    - piece_def_id: 匹配到的基准定义id
    - scale_to_base: 新宽度 / 基准宽度
    - confidence: 匹配置信度 0~1
    """
    if not new_pieces or not base_geos:
        return []

    new_sorted = sorted(
        [dict(p, _index=i) for i, p in enumerate(new_pieces)],
        key=lambda p: p.get("area", 0),
        reverse=True,
    )
    base_sorted = sorted(
        [dict(g, _index=i) for i, g in enumerate(base_geos)],
        key=lambda g: g.get("area", 0),
        reverse=True,
    )

    # 预计算水平位置秩 (0~1)
    def _x_rank(items: list[dict]) -> list[float]:
        sorted_by_x = sorted(items, key=lambda x: x.get("source_x", 0))
        by_id = {id(item): i for i, item in enumerate(sorted_by_x)}
        n = len(items)
        return [by_id[id(item)] / max(1, n - 1) for item in items]

    new_x_ranks = _x_rank(new_sorted)
    base_x_ranks = _x_rank(base_sorted)

    matched: list[dict[str, Any]] = []
    used_new_indices: set[int] = set()

    for bi, base in enumerate(base_sorted):
        best_score = float("inf")
        best_ni = -1
        base_width = max(1, int(base.get("width", 1)))
        base_height = max(1, int(base.get("height", 1)))
        base_area = max(1, int(base.get("area", 1)))
        base_aspect = base_width / max(1, base_height)
        base_x_rank = base_x_ranks[bi]

        for ni, new in enumerate(new_sorted):
            if ni in used_new_indices:
                continue
            new_width = max(1, int(new.get("width", 1)))
            new_height = max(1, int(new.get("height", 1)))
            new_area = max(1, int(new.get("area", 1)))
            new_aspect = new_width / max(1, new_height)
            new_x_rank = new_x_ranks[ni]

            area_sim = abs(new_area - base_area) / max(base_area, new_area, 1)
            aspect_sim = abs(new_aspect - base_aspect) / max(base_aspect, new_aspect, 0.01)
            xrank_sim = abs(new_x_rank - base_x_rank)

            score = area_sim * 0.4 + aspect_sim * 0.3 + xrank_sim * 0.3
            if score < best_score:
                best_score = score
                best_ni = ni

        if best_ni >= 0:
            used_new_indices.add(best_ni)
            new = new_sorted[best_ni]
            scale_to_base = int(new.get("width", 1)) / max(1, base_width)
            confidence = max(0.0, 1.0 - best_score)
            matched.append(
                {
                    "new_piece_index": new["_index"],
                    "piece_def_id": base.get("piece_def_id", ""),
                    "scale_to_base": round(scale_to_base, 4),
                    "confidence": round(confidence, 4),
                }
            )

    return matched


SIZE_ORDER_MAP = {
    "XS": 0,
    "S": 1,
    "M": 2,
    "L": 3,
    "XL": 4,
    "XXL": 5,
    "3XL": 6,
    "4XL": 7,
    "5XL": 8,
}


def size_sort_key(name: str) -> tuple[int, str]:
    """尺寸排序键，支持 XS/S/M/L/XL/XXL/3XL 等。"""
    upper = name.strip().upper()
    # 处理 3XL, 4XL 等
    if upper.startswith("3XL") or upper.startswith("4XL") or upper.startswith("5XL"):
        return (SIZE_ORDER_MAP.get(upper[:3], 99), upper)
    return (SIZE_ORDER_MAP.get(upper, 99), upper)


def pick_default_base_size(size_names: list[str]) -> str:
    """默认选择最小码作为基准尺寸。"""
    if not size_names:
        return ""
    return min(size_names, key=size_sort_key)
