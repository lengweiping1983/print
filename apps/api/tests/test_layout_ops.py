from pathlib import Path

from PIL import Image, ImageDraw

from app.layout_ops import auto_map_pieces, build_design_canvas_config


def test_auto_map_rotates_inverted_back_piece(tmp_path: Path) -> None:
    pieces = [
        _body_piece(tmp_path, "back", 120, 160, "bottom", 20000),
        _body_piece(tmp_path, "front_l", 94, 150, "top", 15000),
        _body_piece(tmp_path, "front_r", 94, 150, "top", 14900),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "shirt")
    by_role = {item["piece_role"]: item for item in mapped}

    assert by_role["back"]["design_region"]["rotation"] == 180
    assert by_role["back"]["orientation_rotation"] == 180
    assert "已按版型方向旋转 180°" in by_role["back"]["fit_note"]
    assert by_role["front_left"]["design_region"]["rotation"] == 0
    assert by_role["front_right"]["design_region"]["rotation"] == 0


def test_auto_map_keeps_upright_body_pieces(tmp_path: Path) -> None:
    pieces = [
        _body_piece(tmp_path, "back", 120, 160, "top", 20000),
        _body_piece(tmp_path, "front_l", 94, 150, "top", 15000),
        _body_piece(tmp_path, "front_r", 94, 150, "top", 14900),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "shirt")

    body = [item for item in mapped if item["piece_role"] in {"back", "front_left", "front_right"}]
    assert body
    assert all(item["design_region"]["rotation"] == 0 for item in body)
    assert all("旋转 180°" not in item["fit_note"] for item in body)


def test_auto_map_marks_uncertain_rectangular_orientation(tmp_path: Path) -> None:
    pieces = [
        _rect_piece(tmp_path, "back", 120, 160, 20000),
        _rect_piece(tmp_path, "front_l", 94, 150, 15000),
        _rect_piece(tmp_path, "front_r", 94, 150, 14900),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "shirt")
    by_role = {item["piece_role"]: item for item in mapped}

    assert by_role["back"]["design_region"]["rotation"] == 0
    assert "裁片上下方向置信度偏低" in by_role["back"]["fit_note"]


def test_auto_map_marks_single_body_piece_as_main(tmp_path: Path) -> None:
    pieces = [_rect_piece(tmp_path, "only", 120, 160, 20000)]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "unknown")

    assert mapped[0]["piece_role"] == "main"
    assert mapped[0]["role_label"] == "主片"
    assert mapped[0]["seam_links"] == []
    assert "后片" not in mapped[0]["fit_note"]


def _body_piece(tmp_path: Path, piece_id: str, width: int, height: int, neck_side: str, area: int) -> dict:
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((0, 0, width - 1, height - 1), fill=255)
    notch_w = width // 3
    notch_h = height // 5
    left = (width - notch_w) // 2
    if neck_side == "top":
        draw.ellipse((left, -notch_h // 2, left + notch_w, notch_h), fill=0)
    else:
        draw.ellipse((left, height - notch_h, left + notch_w, height + notch_h // 2), fill=0)
    path = tmp_path / f"{piece_id}.png"
    mask.save(path)
    return _piece(piece_id, path, width, height, area)


def _rect_piece(tmp_path: Path, piece_id: str, width: int, height: int, area: int) -> dict:
    path = tmp_path / f"{piece_id}.png"
    Image.new("L", (width, height), 255).save(path)
    return _piece(piece_id, path, width, height, area)


def _piece(piece_id: str, path: Path, width: int, height: int, area: int) -> dict:
    return {
        "id": piece_id,
        "mask_path": path,
        "width": width,
        "height": height,
        "area": area,
        "source_x": 0,
        "source_y": 0,
    }
