from pathlib import Path

from PIL import Image, ImageDraw

from app.texture_analysis import detect_content_centroid, detect_repeat_period


def test_detect_repeat_period_finds_vertical_stripes(tmp_path: Path) -> None:
    path = tmp_path / "vertical.png"
    image = Image.new("RGBA", (128, 80), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    for x in range(0, 128, 16):
        draw.rectangle((x, 0, x + 7, 79), fill=(20, 20, 20, 255))
    image.save(path)

    repeat = detect_repeat_period(path)

    assert repeat["has_repeat"] is True
    assert abs(repeat["period_x"] - 16) <= 1
    assert repeat["confidence_x"] >= 0.55


def test_detect_repeat_period_finds_horizontal_stripes(tmp_path: Path) -> None:
    path = tmp_path / "horizontal.png"
    image = Image.new("RGBA", (96, 120), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, 120, 20):
        draw.rectangle((0, y, 95, y + 9), fill=(20, 20, 20, 255))
    image.save(path)

    repeat = detect_repeat_period(path)

    assert repeat["has_repeat"] is True
    assert abs(repeat["period_y"] - 20) <= 1
    assert repeat["confidence_y"] >= 0.55


def test_detect_repeat_period_ignores_flat_color(tmp_path: Path) -> None:
    path = tmp_path / "flat.png"
    Image.new("RGBA", (96, 96), (24, 128, 220, 255)).save(path)

    repeat = detect_repeat_period(path)

    assert repeat["has_repeat"] is False
    assert repeat["period_x"] == 0
    assert repeat["period_y"] == 0


def test_detect_repeat_period_ignores_transparent_logo(tmp_path: Path) -> None:
    path = tmp_path / "logo.png"
    image = Image.new("RGBA", (96, 96), (255, 255, 255, 0))
    ImageDraw.Draw(image).rectangle((24, 24, 72, 72), fill=(20, 20, 20, 255))
    image.save(path)

    repeat = detect_repeat_period(path)

    assert repeat["has_repeat"] is False


def test_detect_content_centroid_finds_transparent_logo(tmp_path: Path) -> None:
    path = tmp_path / "logo.png"
    image = Image.new("RGBA", (100, 80), (255, 255, 255, 0))
    ImageDraw.Draw(image).rectangle((20, 18, 60, 58), fill=(20, 20, 20, 255))
    image.save(path)

    content = detect_content_centroid(path)

    assert content["has_content"] is True
    assert content["method"] == "alpha_centroid_v1"
    assert abs(content["centroid"]["x"] - 40) <= 1
    assert abs(content["centroid"]["y"] - 38) <= 1
    assert content["content_bbox"] == {"x": 20, "y": 18, "width": 41, "height": 41}


def test_detect_content_centroid_ignores_flat_texture(tmp_path: Path) -> None:
    path = tmp_path / "flat.png"
    Image.new("RGBA", (96, 96), (24, 128, 220, 255)).save(path)

    content = detect_content_centroid(path)

    assert content["has_content"] is False


def test_detect_content_centroid_ignores_large_coverage(tmp_path: Path) -> None:
    path = tmp_path / "large.png"
    image = Image.new("RGBA", (100, 100), (255, 255, 255, 0))
    ImageDraw.Draw(image).rectangle((2, 2, 97, 97), fill=(20, 20, 20, 255))
    image.save(path)

    content = detect_content_centroid(path)

    assert content["has_content"] is False


def test_detect_content_centroid_finds_opaque_foreground(tmp_path: Path) -> None:
    path = tmp_path / "foreground.png"
    image = Image.new("RGB", (100, 80), (245, 245, 245))
    ImageDraw.Draw(image).ellipse((30, 20, 70, 60), fill=(20, 80, 180))
    image.save(path)

    content = detect_content_centroid(path)

    assert content["has_content"] is True
    assert content["method"] == "foreground_centroid_v1"
    assert abs(content["centroid"]["x"] - 50) <= 2
    assert abs(content["centroid"]["y"] - 40) <= 2
