import base64
import os
import time
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

import httpx
from PIL import Image, ImageDraw


HTTP_TIMEOUT = httpx.Timeout(connect=10, read=120, write=30, pool=10)
RETRY_STATUSES = {429, 500, 502, 503, 504}


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
        data = request_json(
            "POST",
            "https://api.openai.com/v1/images/generations",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            payload=payload,
        )
        b64 = data["data"][0].get("b64_json")
        if not b64:
            raise RuntimeError("OpenAI image response did not include b64_json")
        raw = base64.b64decode(b64)
        out_path.parent.mkdir(parents=True, exist_ok=True)
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
        data = request_json(
            "POST",
            "https://api.replicate.com/v1/predictions",
            headers={"Authorization": f"Token {api_token}", "Content-Type": "application/json"},
            payload=payload,
        )
        prediction_id = data.get("id")
        if not prediction_id:
            raise RuntimeError("Replicate response did not include prediction id")
        for _ in range(90):
            data = request_json(
                "GET",
                f"https://api.replicate.com/v1/predictions/{prediction_id}",
                headers={"Authorization": f"Token {api_token}"},
                retries=1,
            )
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
    try:
        with Image.open(path).convert("RGBA") as img:
            if img.size != (width, height):
                img.resize((width, height), Image.Resampling.LANCZOS).save(path)
    except Exception as exc:
        logger.exception("加载图片失败: %s", path)
        raise RuntimeError(f"无法加载图片 {path}: {exc}") from exc


def download_to(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(request_bytes(url))


def request_json(method: str, url: str, *, headers: dict[str, str], payload: dict | None = None, retries: int = 2) -> dict:
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        response = request_with_retry(client, method, url, headers=headers, json_payload=payload, retries=retries)
        return response.json()


def request_bytes(url: str, retries: int = 2) -> bytes:
    with httpx.Client(timeout=HTTP_TIMEOUT) as client:
        response = request_with_retry(client, "GET", url, headers={}, json_payload=None, retries=retries)
        return response.content


def request_with_retry(
    client: httpx.Client,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json_payload: dict | None,
    retries: int,
) -> httpx.Response:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            response = client.request(method, url, headers=headers, json=json_payload)
            if response.status_code in RETRY_STATUSES and attempt < retries:
                time.sleep(1 + attempt)
                continue
            response.raise_for_status()
            return response
        except (httpx.TimeoutException, httpx.NetworkError, httpx.HTTPStatusError) as exc:
            last_error = exc
            retryable_status = isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in RETRY_STATUSES
            if attempt < retries and (not isinstance(exc, httpx.HTTPStatusError) or retryable_status):
                time.sleep(1 + attempt)
                continue
            break
    raise RuntimeError(f"图片服务请求失败：{last_error}") from last_error
