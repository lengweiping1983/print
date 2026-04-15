from pathlib import Path

from PIL import Image, ImageDraw

from app.image_ops import extract_alpha_components, make_mirror_tile, render_layout


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

