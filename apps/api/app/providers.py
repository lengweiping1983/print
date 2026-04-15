import base64
import json
import os
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw


class ImageProvider:
    name = "local"

    def generate_texture(self, prompt: str, out_path: Path, width: int, height: int, seed: str = "") -> tuple[int, int]:
        raise NotImplementedError


class LocalPlaceholderProvider(ImageProvider):
    name = "local"

    def generate_texture(self, prompt: str, out_path: Path, width: int, height: int, seed: str = "") -> tuple[int, int]:
        img = Image.new("RGBA", (width, height), (28, 53, 116, 255))
        draw = ImageDraw.Draw(img)
        for x in range(-height, width, 220):
            draw.line((x, 0, x + height, height), fill=(88, 129, 214, 90), width=8)
        for y in range(160, height, 420):
            draw.ellipse((80, y - 80, 260, y + 100), outline=(196, 214, 255, 180), width=8)
            draw.ellipse((width - 320, y, width - 120, y + 180), outline=(238, 242, 255, 150), width=8)
        draw.text((40, 40), (prompt or "local texture")[:90], fill=(255, 255, 255, 220))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path)
        return width, height


class OpenAIImageProvider(ImageProvider):
    name = "openai"

    def generate_texture(self, prompt: str, out_path: Path, width: int, height: int, seed: str = "") -> tuple[int, int]:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            return LocalPlaceholderProvider().generate_texture(prompt, out_path, width, height, seed)
        size = closest_openai_size(width, height)
        payload = {
            "model": os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-1"),
            "prompt": prompt,
            "size": size,
        }
        req = urllib.request.Request(
            "https://api.openai.com/v1/images/generations",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as res:
            data = json.loads(res.read().decode("utf-8"))
        b64 = data["data"][0].get("b64_json")
        if not b64:
            raise RuntimeError("OpenAI image response did not include b64_json")
        raw = base64.b64decode(b64)
        out_path.write_bytes(raw)
        normalize_size(out_path, width, height)
        return width, height


class ReplicateProvider(ImageProvider):
    name = "replicate"

    def generate_texture(self, prompt: str, out_path: Path, width: int, height: int, seed: str = "") -> tuple[int, int]:
        api_token = os.environ.get("REPLICATE_API_TOKEN")
        model_version = os.environ.get("REPLICATE_MODEL_VERSION")
        if not api_token or not model_version:
            return LocalPlaceholderProvider().generate_texture(prompt, out_path, width, height, seed)
        payload = {
            "version": model_version,
            "input": {"prompt": prompt, "width": width, "height": height, "seed": int(seed) if seed.isdigit() else None},
        }
        req = urllib.request.Request(
            "https://api.replicate.com/v1/predictions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Token {api_token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as res:
            data = json.loads(res.read().decode("utf-8"))
        prediction_id = data.get("id")
        if not prediction_id:
            raise RuntimeError("Replicate response did not include prediction id")
        for _ in range(90):
            poll_req = urllib.request.Request(
                f"https://api.replicate.com/v1/predictions/{prediction_id}",
                headers={"Authorization": f"Token {api_token}"},
                method="GET",
            )
            with urllib.request.urlopen(poll_req, timeout=60) as res:
                data = json.loads(res.read().decode("utf-8"))
            if data.get("status") == "succeeded":
                output = data.get("output")
                url = output[0] if isinstance(output, list) else output
                if not isinstance(url, str):
                    raise RuntimeError("Replicate output did not include an image URL")
                download_to(url, out_path)
                normalize_size(out_path, width, height)
                return width, height
            if data.get("status") in {"failed", "canceled"}:
                raise RuntimeError(data.get("error") or f"Replicate prediction {data.get('status')}")
            time.sleep(2)
        raise RuntimeError("Timed out waiting for Replicate prediction")


def get_provider(provider: str) -> ImageProvider:
    normalized = provider.lower().strip()
    if normalized == "openai":
        return OpenAIImageProvider()
    if normalized == "replicate":
        return ReplicateProvider()
    return LocalPlaceholderProvider()


def closest_openai_size(width: int, height: int) -> str:
    if width == height:
        return "1024x1024"
    return "1536x1024" if width > height else "1024x1536"


def normalize_size(path: Path, width: int, height: int) -> None:
    with Image.open(path).convert("RGBA") as img:
        if img.size != (width, height):
            img.resize((width, height), Image.Resampling.LANCZOS).save(path)


def download_to(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as res:
        path.write_bytes(res.read())
