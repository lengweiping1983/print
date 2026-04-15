from pathlib import Path

from PIL import Image, ImageDraw

from app.image_ops import (
    extract_alpha_components,
    make_layout_template,
    make_mirror_tile,
    make_red_marker_mask,
    marker_path_for_mask,
    render_layout,
    render_piece,
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

