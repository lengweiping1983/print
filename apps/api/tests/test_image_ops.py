from pathlib import Path

from PIL import Image, ImageDraw

from app.design_ops import build_design_texture_canvas
from app.image_ops import (
    _collect_component_spans,
    extract_alpha_components,
    make_layout_template,
    make_mirror_tile,
    make_offset_tile,
    make_repeated_tile_image,
    make_red_marker_mask,
    marker_path_for_mask,
    repeated_tile_counts,
    render_layout,
    render_piece,
    render_piece_from_design_canvas,
    write_piece_marker_masks,
)


def test_extract_alpha_components_sorts_by_area(tmp_path: Path) -> None:
    src = tmp_path / "mask.png"
    image = Image.new("RGBA", (160, 100), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 70, 80), fill=(255, 255, 255, 255))
    draw.rectangle((100, 20, 130, 50), fill=(255, 255, 255, 255))
    image.save(src)

    pieces = extract_alpha_components(src, tmp_path / "pieces", min_area=20)

    assert len(pieces) == 2
    assert pieces[0]["area"] > pieces[1]["area"]
    assert pieces[0]["bbox"] == {"x": 10, "y": 10, "width": 61, "height": 71}
    assert pieces[0]["mask_path"].exists()


def test_collect_component_spans_does_not_mutate_mask() -> None:
    mask = bytearray(
        [
            0, 0, 0, 0,
            0, 1, 1, 0,
            0, 1, 0, 0,
            0, 0, 0, 0,
        ]
    )
    original = bytes(mask)
    visited = bytearray(16)

    spans, area, *_ = _collect_component_spans(5, mask, visited, 4, 4)

    assert area == 3
    assert spans
    assert bytes(mask) == original
    assert sum(visited) == 3


def test_make_layout_template_removes_only_edge_connected_white_background(tmp_path: Path) -> None:
    src = tmp_path / "layout.jpg"
    image = Image.new("RGB", (220, 120), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 90, 100), fill=(18, 42, 104))
    draw.rectangle((130, 20, 200, 90), fill=(18, 42, 104))
    draw.ellipse((42, 42, 58, 58), fill=(255, 255, 255))
    image.save(src, format="JPEG", quality=95)

    template = make_layout_template(src, tmp_path / "template.png")
    converted = Image.open(template).convert("RGBA")
    alpha = converted.getchannel("A")

    assert alpha.getpixel((0, 0)) == 0
    assert alpha.getpixel((50, 50)) == 255
    pieces = extract_alpha_components(template, tmp_path / "pieces", min_area=20)
    assert len(pieces) == 2


def test_render_piece_keeps_red_registration_markers(tmp_path: Path) -> None:
    src = tmp_path / "layout.png"
    image = Image.new("RGB", (120, 80), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 100, 60), fill=(18, 42, 104))
    draw.rectangle((44, 18, 58, 22), fill=(238, 0, 40))
    image.save(src)

    template = make_layout_template(src, tmp_path / "template.png")
    marker_mask = make_red_marker_mask(src, tmp_path / "red_markers.png")
    pieces = extract_alpha_components(template, tmp_path / "pieces", min_area=20)
    assert write_piece_marker_masks(pieces, marker_mask) == 1
    assert marker_path_for_mask(pieces[0]["mask_path"]).exists()

    texture = tmp_path / "texture.png"
    Image.new("RGBA", (24, 24), (20, 80, 160, 255)).save(texture)
    out = tmp_path / "piece.png"
    render_piece(pieces[0]["mask_path"], texture, {"offset_x": 0, "offset_y": 0, "scale": 1, "rotation": 0}, out)

    rendered = Image.open(out).convert("RGBA")
    red = rendered.getpixel((40, 10))
    assert red[0] > 220 and red[1] < 30 and red[2] < 70 and red[3] == 255


def test_render_layout_with_texture(tmp_path: Path) -> None:
    mask = tmp_path / "piece_mask.png"
    Image.new("L", (80, 60), 255).save(mask)
    texture = tmp_path / "texture.png"
    Image.new("RGBA", (32, 32), (18, 68, 144, 255)).save(texture)
    seamless = tmp_path / "seamless.png"
    make_mirror_tile(texture, seamless, 128, 128)

    out = tmp_path / "layout.png"
    render_layout(
        [
            {
                "id": "pc_01",
                "mask_path": mask,
                "bbox": {"x": 5, "y": 6, "width": 80, "height": 60},
                "source_x": 5,
                "source_y": 6,
                "transform": {"offset_x": 0, "offset_y": 0, "scale": 1, "rotation": 0},
            }
        ],
        seamless,
        out,
        (120, 100),
    )

    assert out.exists()
    assert Image.open(out).size == (120, 100)
    assert not list(tmp_path.glob("_*.png"))


def test_build_design_texture_canvas_tiling_keeps_offset_pixels(tmp_path: Path) -> None:
    texture = tmp_path / "tile.png"
    tile = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    pixels = tile.load()
    assert pixels is not None
    for y in range(4):
        for x in range(4):
            pixels[x, y] = (x * 50, y * 50, 120, 255)
    tile.save(texture)

    out = tmp_path / "design.png"
    build_design_texture_canvas(
        texture,
        out,
        {
            "width": 64,
            "height": 48,
            "texture_scale": 1,
            "texture_offset_x": 3,
            "texture_offset_y": 2,
            "tile": True,
            "mirror": False,
            "global_texture_angle": 0,
            "design_anchors": {},
        },
    )

    rendered = Image.open(out).convert("RGBA")
    start_x = -4 + (3 % 4)
    start_y = -4 + (2 % 4)
    for point in [(0, 0), (13, 7), (42, 31)]:
        x, y = point
        expected_x = (x - start_x) % 4
        expected_y = (y - start_y) % 4
        assert rendered.getpixel(point) == tile.getpixel((expected_x, expected_y))


def test_render_piece_tiling_keeps_local_offset_pixels(tmp_path: Path) -> None:
    mask = tmp_path / "piece_mask.png"
    Image.new("L", (20, 16), 255).save(mask)
    texture = tmp_path / "texture.png"
    tile = Image.new("RGBA", (5, 4), (0, 0, 0, 0))
    pixels = tile.load()
    assert pixels is not None
    for y in range(4):
        for x in range(5):
            pixels[x, y] = (x * 30, y * 40, 200, 255)
    tile.save(texture)

    out = tmp_path / "piece.png"
    render_piece(mask, texture, {"offset_x": 2, "offset_y": 3, "scale": 1, "rotation": 0}, out)

    rendered = Image.open(out).convert("RGBA")
    start_x = -5 + (2 % 5)
    start_y = -4 + (3 % 4)
    for point in [(0, 0), (8, 5), (19, 15)]:
        x, y = point
        expected_x = (x - start_x) % 5
        expected_y = (y - start_y) % 4
        assert rendered.getpixel(point) == tile.getpixel((expected_x, expected_y))


def test_make_mirror_tile_keeps_quadrant_mirroring(tmp_path: Path) -> None:
    texture = tmp_path / "texture.png"
    src = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
    src.putpixel((0, 0), (255, 0, 0, 255))
    src.putpixel((1, 0), (0, 255, 0, 255))
    src.putpixel((0, 1), (0, 0, 255, 255))
    src.putpixel((1, 1), (255, 255, 0, 255))
    src.save(texture)

    out = tmp_path / "mirror.png"
    make_mirror_tile(texture, out, 8, 8)

    rendered = Image.open(out).convert("RGBA")
    assert rendered.size == (8, 8)
    assert rendered.getpixel((0, 0)) == (255, 0, 0, 255)
    assert rendered.getpixel((2, 0)) == (0, 255, 0, 255)
    assert rendered.getpixel((0, 2)) == (0, 0, 255, 255)
    assert rendered.getpixel((2, 2)) == (255, 255, 0, 255)
    assert rendered.getpixel((4, 0)) == (255, 0, 0, 255)


def test_make_offset_tile_keeps_full_coverage(tmp_path: Path) -> None:
    texture = tmp_path / "texture.png"
    Image.new("RGBA", (8, 8), (20, 80, 160, 255)).save(texture)

    out = tmp_path / "offset.png"
    make_offset_tile(texture, out, 40, 32)

    rendered = Image.open(out).convert("RGBA")
    assert rendered.size == (40, 32)
    assert rendered.getchannel("A").getextrema() == (255, 255)


def test_repeated_tile_helpers_expand_small_tiles_only() -> None:
    assert repeated_tile_counts((100, 80), (5, 6)) == (4, 4)
    assert repeated_tile_counts((100, 80), (60, 50)) == (1, 1)

    tile = Image.new("RGBA", (5, 6), (20, 80, 160, 255))
    repeated = make_repeated_tile_image(tile, 4, 4)
    assert repeated.size == (20, 24)
    repeated.close()


def test_paint_tiled_clips_large_edge_tiles_without_decompression_error() -> None:
    from app import image_ops

    canvas = Image.new("RGBA", (6923, 6933), (0, 0, 0, 0))
    tile = Image.new("RGBA", (7244, 7244), (20, 80, 160, 255))

    image_ops.paint_tiled(canvas, tile, -7244, -7244)

    assert canvas.getpixel((0, 0)) == (20, 80, 160, 255)
    assert canvas.getpixel((6922, 6932)) == (20, 80, 160, 255)
    tile.close()
    canvas.close()


def test_render_piece_from_design_canvas_ignores_legacy_sample_size(tmp_path: Path) -> None:
    mask = tmp_path / "piece_mask.png"
    Image.new("L", (20, 20), 255).save(mask)
    design = tmp_path / "design.png"
    image = Image.new("RGBA", (80, 20), (0, 0, 0, 0))
    pixels = image.load()
    assert pixels is not None
    for y in range(20):
        for x in range(80):
            pixels[x, y] = (x * 3, 80, 200, 255)
    image.save(design)

    out = tmp_path / "piece.png"
    render_piece_from_design_canvas(
        mask,
        design,
        {"mode": "global_canvas", "design_x": 10, "design_y": 0, "design_width": 40, "design_height": 40},
        out,
    )

    rendered = Image.open(out).convert("RGBA")
    assert rendered.size == (20, 20)
    assert rendered.getpixel((10, 10)) == image.getpixel((20, 10))


def test_render_piece_from_design_canvas_applies_local_offset(tmp_path: Path) -> None:
    mask = tmp_path / "piece_mask.png"
    Image.new("L", (20, 20), 255).save(mask)
    design = tmp_path / "design.png"
    image = Image.new("RGBA", (80, 40), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 39, 39), fill=(255, 0, 0, 255))
    draw.rectangle((40, 0, 79, 39), fill=(0, 80, 255, 255))
    image.save(design)

    out = tmp_path / "piece.png"
    render_piece_from_design_canvas(
        mask,
        design,
        {"mode": "global_canvas", "design_x": 0, "design_y": 0, "offset_x": 40, "design_width": 40, "design_height": 40},
        out,
    )

    rendered = Image.open(out).convert("RGBA")
    pixel = rendered.getpixel((10, 10))
    assert pixel[2] > 200
    assert pixel[0] < 50


def test_render_piece_from_design_canvas_applies_piece_scale_after_global_sample(tmp_path: Path) -> None:
    mask = tmp_path / "piece_mask.png"
    Image.new("L", (20, 20), 255).save(mask)
    design = tmp_path / "design.png"
    image = Image.new("RGBA", (80, 20), (0, 0, 0, 0))
    pixels = image.load()
    assert pixels is not None
    for y in range(20):
        for x in range(80):
            pixels[x, y] = (x * 3, 80, 200, 255)
    image.save(design)

    out = tmp_path / "piece.png"
    render_piece_from_design_canvas(
        mask,
        design,
        {"mode": "global_canvas", "design_x": 10, "design_y": 0, "scale": 2, "rotation": 0},
        out,
    )

    rendered = Image.open(out).convert("RGBA")
    zoomed_pixel = rendered.getpixel((15, 10))
    unscaled_pixel = image.getpixel((25, 10))
    assert zoomed_pixel[0] < unscaled_pixel[0]
    assert abs(zoomed_pixel[0] - image.getpixel((22, 10))[0]) <= 8


def test_render_layout_derives_linked_piece_content_from_source(tmp_path: Path) -> None:
    texture = tmp_path / "texture.png"
    tex = Image.new("RGBA", (4, 3), (0, 0, 0, 0))
    for y in range(3):
        for x in range(4):
            tex.putpixel((x, y), (20 + x * 40, 30 + y * 50, 180, 255))
    tex.save(texture)

    source_mask = tmp_path / "source_mask.png"
    linked_mask = tmp_path / "linked_mask.png"
    Image.new("L", (4, 3), 255).save(source_mask)
    Image.new("L", (4, 3), 255).save(linked_mask)

    variants = [
        (False, False, "same"),
        (True, False, "mirror_x"),
        (False, True, "mirror_y"),
        (True, True, "mirror_xy"),
    ]
    for mirror_x, mirror_y, label in variants:
        out = tmp_path / f"{label}.png"
        pieces = [
            {
                "id": "source",
                "mask_path": source_mask,
                "bbox": {"x": 0, "y": 0, "width": 4, "height": 3},
                "source_x": 0,
                "source_y": 0,
                "width": 4,
                "height": 3,
                "mirror_of": "",
                "transform": {"offset_x": 1, "offset_y": 0, "scale": 1, "rotation": 0},
            },
            {
                "id": "linked",
                "mask_path": linked_mask,
                "bbox": {"x": 4, "y": 0, "width": 4, "height": 3},
                "source_x": 4,
                "source_y": 0,
                "width": 4,
                "height": 3,
                "mirror_of": "source",
                "transform": {"mirror_x": mirror_x, "mirror_y": mirror_y},
            },
        ]
        render_layout(pieces, texture, out, (8, 3), include_outline=False, include_labels=False)
        rendered = Image.open(out).convert("RGBA")

        for y in range(3):
            for x in range(4):
                source_pixel = rendered.getpixel((x, y))
                linked_x = 4 + (3 - x if mirror_x else x)
                linked_y = 2 - y if mirror_y else y
                assert rendered.getpixel((linked_x, linked_y)) == source_pixel
