from pathlib import Path

from PIL import Image, ImageDraw

from app.texture_analysis import detect_repeat_period


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
