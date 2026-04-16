from pathlib import Path

from PIL import Image, ImageDraw

from app.layout_ops import _apply_seam_alignment, _seam_phase, auto_map_pieces, build_design_canvas_config


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


def test_auto_map_does_not_pair_obviously_different_two_piece_template(tmp_path: Path) -> None:
    pieces = [
        _rect_piece(tmp_path, "large", 180, 220, 39600, source_x=0),
        _rect_piece(tmp_path, "small", 86, 110, 9460, source_x=260),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "unknown")
    roles = {item["id"]: item["piece_role"] for item in mapped}

    assert roles["large"] == "main"
    assert roles["small"] == "unknown"
    assert "front_left" not in roles.values()
    assert "front_right" not in roles.values()


def test_auto_map_pairs_close_two_piece_template(tmp_path: Path) -> None:
    pieces = [
        _rect_piece(tmp_path, "left", 120, 180, 21600, source_x=0),
        _rect_piece(tmp_path, "right", 122, 180, 21960, source_x=180),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "shirt")
    roles = {item["id"]: item["piece_role"] for item in mapped}

    assert roles["left"] == "front_left"
    assert roles["right"] == "front_right"


def test_auto_map_keeps_large_and_repeated_pieces_inside_canvas(tmp_path: Path) -> None:
    pieces = [
        _rect_piece(tmp_path, f"piece_{index}", 520, 420, 218400 - index, source_x=index * 20)
        for index in range(7)
    ]
    canvas = build_design_canvas_config(pieces, {"canvas_width": 1200, "canvas_height": 900})

    mapped = auto_map_pieces(pieces, canvas, "unknown")

    assert all(0 <= item["design_region"]["x"] <= canvas["width"] - item["design_region"]["width"] for item in mapped)
    assert all(0 <= item["design_region"]["y"] <= canvas["height"] - item["design_region"]["height"] for item in mapped)
    assert any("已夹在画布范围内" in item["fit_note"] for item in mapped)


def test_auto_map_filters_seam_links_to_existing_roles(tmp_path: Path) -> None:
    pieces = [
        _rect_piece(tmp_path, "left", 120, 180, 21600, source_x=0),
        _rect_piece(tmp_path, "right", 122, 180, 21960, source_x=180),
    ]
    canvas = build_design_canvas_config(pieces)

    mapped = auto_map_pieces(pieces, canvas, "shirt")

    roles = {item["piece_role"] for item in mapped}
    assert roles == {"front_left", "front_right"}
    assert all(link["to_role"] in roles for item in mapped for link in item["seam_links"])


def test_seam_phase_uses_edge_position_when_available() -> None:
    entry = {"design_region": {"x": 200, "y": 50, "width": 400, "height": 300}}

    assert _seam_phase(entry, "x", "right") == 600
    assert _seam_phase(entry, "x", "left") == 200
    assert _seam_phase(entry, "y", "bottom") == 350
    assert _seam_phase(entry, "y") == 50


def test_seam_alignment_keeps_legacy_links_working() -> None:
    mapped = [
        {
            "id": "front",
            "piece_role": "front_left",
            "design_region": {"x": 96, "y": 80, "width": 100, "height": 160},
            "seam_links": [{"edge": "shoulder", "to_role": "back", "to_edge": "shoulder"}],
            "fit_note": "",
        },
        {
            "id": "back",
            "piece_role": "back",
            "design_region": {"x": 25, "y": 80, "width": 120, "height": 170},
            "seam_links": [],
            "fit_note": "",
        },
    ]

    _apply_seam_alignment(mapped, (24, 24))

    assert mapped[0]["design_region"]["x"] == 97
    assert "已按水平纹理周期对齐" in mapped[0]["fit_note"]


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


def _rect_piece(tmp_path: Path, piece_id: str, width: int, height: int, area: int, source_x: int = 0, source_y: int = 0) -> dict:
    path = tmp_path / f"{piece_id}.png"
    Image.new("L", (width, height), 255).save(path)
    return _piece(piece_id, path, width, height, area, source_x=source_x, source_y=source_y)


def _piece(piece_id: str, path: Path, width: int, height: int, area: int, source_x: int = 0, source_y: int = 0) -> dict:
    return {
        "id": piece_id,
        "mask_path": path,
        "width": width,
        "height": height,
        "area": area,
        "source_x": source_x,
        "source_y": source_y,
    }
