import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Header, Request
from fastapi.responses import JSONResponse

from .config import STORAGE_DIR

router = APIRouter()

BASE_URL = "https://story.neodomain.cn"
DEFAULT_MODEL_NAME = os.environ.get("DEFAULT_MODEL_NAME", "gemini-3-pro-image-preview")
REQUEST_TIMEOUT_MS = 600_000
POLL_INTERVAL_MS = 3_000
GENERATED_DIR = STORAGE_DIR / "neodomain" / "generated"
RUNTIME_ENV_FILE = STORAGE_DIR / ".env.runtime"

GENERATED_DIR.mkdir(parents=True, exist_ok=True)

_env_token = (os.environ.get("NEODOMAIN_ACCESS_TOKEN") or os.environ.get("ACCESS_TOKEN") or "").strip()
_runtime_token = ""
_runtime_token_source = "none"


def _load_runtime_token() -> str:
    try:
        if not RUNTIME_ENV_FILE.exists():
            return ""
        content = RUNTIME_ENV_FILE.read_text("utf8")
        match = re.search(r"(?:NEODOMAIN_ACCESS_TOKEN|ACCESS_TOKEN)=(.*)", content)
        return match.group(1).strip() if match else ""
    except Exception:
        return ""


def _persist_runtime_token(token: str) -> bool:
    global _runtime_token, _runtime_token_source
    safe = (token or "").strip()
    if not safe:
        return False
    content = f"NEODOMAIN_ACCESS_TOKEN={safe}\nACCESS_TOKEN={safe}\n"
    RUNTIME_ENV_FILE.write_text(content, "utf8")
    _runtime_token = safe
    _runtime_token_source = "runtime_file"
    os.environ["NEODOMAIN_ACCESS_TOKEN"] = safe
    os.environ["ACCESS_TOKEN"] = safe
    return True


def _clear_runtime_token() -> None:
    global _runtime_token, _runtime_token_source
    _runtime_token = _env_token
    _runtime_token_source = "env" if _env_token else "none"
    if RUNTIME_ENV_FILE.exists():
        RUNTIME_ENV_FILE.unlink()
    if not _env_token:
        os.environ.pop("NEODOMAIN_ACCESS_TOKEN", None)
        os.environ.pop("ACCESS_TOKEN", None)


def _get_active_server_token() -> str:
    return (_runtime_token or _env_token).strip()


def _resolve_access_token(candidate: Optional[str] = None) -> str:
    return (candidate or _get_active_server_token()).strip()


def _is_token_expired_error(error: Exception) -> bool:
    payload = getattr(error, "payload", {}) or {}
    if not isinstance(payload, dict):
        payload = {}
    message = str(payload.get("errMessage") or str(error) or "").lower()
    code = str(payload.get("errCode") or "")
    return (
        code == "2001"
        or "token has been revoked" in message
        or "token expired" in message
        or ("access token" in message and "expired" in message)
    )


def _normalize_api_error(error: Exception, fallback_message: str) -> dict[str, Any]:
    token_expired = _is_token_expired_error(error)
    payload = getattr(error, "payload", {}) or {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "success": False,
        "error": payload.get("errMessage") or str(error) or fallback_message,
        "tokenExpired": token_expired,
        "errCode": payload.get("errCode") or None,
    }


async def _request_json(
    method: str,
    url: str,
    headers: Optional[dict[str, str]] = None,
    body: Optional[str] = None,
    timeout_ms: int = REQUEST_TIMEOUT_MS,
) -> Any:
    headers = headers or {}
    timeout = httpx.Timeout(timeout_ms / 1000)
    async with httpx.AsyncClient(timeout=timeout) as client:
        if method.upper() == "GET":
            response = await client.get(url, headers=headers)
        elif method.upper() == "POST":
            response = await client.post(url, headers=headers, content=body)
        else:
            response = await client.request(method, url, headers=headers, content=body)

        try:
            parsed = response.json() if response.text else {}
        except Exception as exc:
            raise RuntimeError(f"返回不是合法 JSON: {response.text[:300]}") from exc

        if response.status_code >= 200 and response.status_code < 300:
            return parsed

        err = Exception(parsed.get("errMessage") or f"HTTP {response.status_code}")
        err.status_code = response.status_code  # type: ignore[attr-defined]
        err.payload = parsed  # type: ignore[attr-defined]
        raise err


async def _download_file(file_url: str, file_path: Path) -> Path:
    timeout = httpx.Timeout(REQUEST_TIMEOUT_MS / 1000)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(file_url)
        if response.status_code != 200:
            raise RuntimeError(f"下载失败，HTTP {response.status_code}")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(response.content)
    return file_path


def _get_extension_from_format(fmt: str = "png") -> str:
    safe = str(fmt).lower()
    if safe in {"png", "jpeg", "jpg", "webp"}:
        return "jpeg" if safe == "jpg" else safe
    return "png"


async def _poll_image_result(access_token: str, task_code: str) -> dict[str, Any]:
    started_at = asyncio.get_event_loop().time()
    while (asyncio.get_event_loop().time() - started_at) < (REQUEST_TIMEOUT_MS / 1000):
        result = await _request_json(
            "GET",
            f"{BASE_URL}/agent/ai-image-generation/result/{task_code}",
            headers={"accessToken": access_token},
            timeout_ms=30000,
        )
        data = result.get("data") or {}
        status = data.get("status")
        if status == "SUCCESS":
            return data
        if status == "FAILED":
            raise RuntimeError(data.get("failure_reason") or data.get("errorMessage") or "图片生成失败")
        await asyncio.sleep(POLL_INTERVAL_MS / 1000)
    raise RuntimeError(f"轮询结果超时（{REQUEST_TIMEOUT_MS / 1000} 秒）")


# Initialize runtime token on module load
_persisted_at_load = _load_runtime_token()
if _persisted_at_load:
    _runtime_token = _persisted_at_load
    _runtime_token_source = "runtime_file"
else:
    _runtime_token = _env_token
    _runtime_token_source = "env" if _env_token else "none"


@router.get("/api/config")
async def api_config() -> JSONResponse:
    return JSONResponse({
        "success": True,
        "defaultModelName": DEFAULT_MODEL_NAME,
        "hasEnvAccessToken": bool(_env_token),
        "hasRuntimeAccessToken": bool(_runtime_token),
        "tokenSource": _runtime_token_source,
        "activeServerToken": bool(_get_active_server_token()),
        "envNames": ["NEODOMAIN_ACCESS_TOKEN", "ACCESS_TOKEN"],
        "runtimeEnvFile": ".env.runtime",
    })


@router.get("/api/auth/status")
async def api_auth_status(x_access_token: Optional[str] = Header(None)) -> JSONResponse:
    manual_token = (x_access_token or "").strip()
    active_token = _resolve_access_token(manual_token)
    message = "当前没有可用 token，请去 /token 登录获取。"
    if manual_token:
        message = "当前将优先使用你页面中填写的 accessToken。"
    elif _runtime_token_source == "runtime_file":
        message = "服务端正在使用通过 /token 页面保存的 accessToken。"
    elif _env_token:
        message = "服务端正在使用启动时环境变量中的 accessToken。"
    return JSONResponse({
        "success": True,
        "hasEnvAccessToken": bool(_env_token),
        "hasRuntimeAccessToken": bool(_runtime_token),
        "hasManualToken": bool(manual_token),
        "canGenerate": bool(active_token),
        "activeSource": "manual" if manual_token else _runtime_token_source,
        "message": message,
    })


@router.get("/api/health")
async def api_health() -> JSONResponse:
    return JSONResponse({
        "success": True,
        "message": "nano banana neodomain web ok",
        "timeoutSeconds": REQUEST_TIMEOUT_MS / 1000,
        "generatedDir": str(GENERATED_DIR),
        "defaultModelName": DEFAULT_MODEL_NAME,
        "hasEnvAccessToken": bool(_env_token),
        "hasRuntimeAccessToken": bool(_runtime_token),
        "activeTokenSource": _runtime_token_source,
    })


@router.post("/api/token/save")
async def api_token_save(request: Request) -> JSONResponse:
    body = await request.json()
    access_token = (body.get("accessToken") or "").strip()
    if not access_token:
        return JSONResponse({"success": False, "error": "accessToken 不能为空"}, status_code=400)
    _persist_runtime_token(access_token)
    return JSONResponse({
        "success": True,
        "message": "accessToken 已保存到服务端运行环境，并写入 .env.runtime。当前项目和后续页面都可直接调用。",
        "tokenSource": _runtime_token_source,
    })


@router.post("/api/token/clear")
async def api_token_clear() -> JSONResponse:
    _clear_runtime_token()
    message = (
        "已清除页面保存的 token，服务端将回退到启动时环境变量 token。"
        if _env_token
        else "已清除服务端保存的 token。"
    )
    return JSONResponse({
        "success": True,
        "message": message,
        "tokenSource": _runtime_token_source,
    })


@router.post("/api/login/send-code")
async def api_login_send_code(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        contact = (body.get("contact") or "").strip()
        if not contact:
            return JSONResponse({"success": False, "error": "contact 不能为空"}, status_code=400)
        payload = {"contact": contact, "userSource": "NEO"}
        result = await _request_json(
            "POST",
            f"{BASE_URL}/user/login/send-unified-code",
            headers={"Content-Type": "application/json"},
            body=json.dumps(payload, ensure_ascii=False),
            timeout_ms=30000,
        )
        return JSONResponse(result)
    except Exception as error:
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "发送验证码失败"), status_code=status)


@router.post("/api/login")
async def api_login(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        contact = (body.get("contact") or "").strip()
        code = (body.get("code") or "").strip()
        invitation_code = (body.get("invitationCode") or "").strip()
        if not contact or not code:
            return JSONResponse({"success": False, "error": "contact 和 code 不能为空"}, status_code=400)
        payload = {
            "contact": contact,
            "code": code,
            "invitationCode": invitation_code,
            "userSource": "NEO",
        }
        result = await _request_json(
            "POST",
            f"{BASE_URL}/user/login/unified-login/identity",
            headers={"Content-Type": "application/json"},
            body=json.dumps(payload, ensure_ascii=False),
            timeout_ms=30000,
        )
        auth = (result.get("data") or {}).get("authorization")
        if auth:
            _persist_runtime_token(auth)
        return JSONResponse(result)
    except Exception as error:
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "登录失败"), status_code=status)


@router.post("/api/login/select-identity")
async def api_login_select_identity(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        contact = (body.get("contact") or "").strip()
        user_id = (body.get("userId") or "").strip()
        if not contact or not user_id:
            return JSONResponse({"success": False, "error": "contact 和 userId 不能为空"}, status_code=400)
        payload = {"contact": contact, "userId": user_id}
        result = await _request_json(
            "POST",
            f"{BASE_URL}/user/login/select-identity",
            headers={"Content-Type": "application/json"},
            body=json.dumps(payload, ensure_ascii=False),
            timeout_ms=30000,
        )
        auth = (result.get("data") or {}).get("authorization")
        if auth:
            _persist_runtime_token(auth)
        return JSONResponse(result)
    except Exception as error:
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "选择身份失败"), status_code=status)


@router.get("/api/models")
async def api_models(
    x_access_token: Optional[str] = Header(None),
    accessToken: Optional[str] = None,
    scenarioType: str = "2",
    userId: Optional[str] = None,
) -> JSONResponse:
    try:
        token = _resolve_access_token((x_access_token or accessToken or "").strip())
        if not token:
            return JSONResponse({"success": False, "error": "缺少 accessToken，且服务端也没有可用 token"}, status_code=400)
        url = f"{BASE_URL}/agent/ai-image-generation/models/by-scenario?scenarioType={scenarioType}"
        if userId:
            url += f"&userId={userId}"
        result = await _request_json("GET", url, headers={"accessToken": token}, timeout_ms=30000)
        return JSONResponse(result)
    except Exception as error:
        if _is_token_expired_error(error):
            _clear_runtime_token()
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "获取模型失败"), status_code=status)


@router.post("/api/generate-image")
async def api_generate_image(request: Request) -> JSONResponse:
    import json as _json
    try:
        body = await request.json()
        body_access_token = (body.get("accessToken") or "").strip()
        prompt = (body.get("prompt") or "").strip()
        negative_prompt = body.get("negativePrompt", "")
        model_name = body.get("modelName") or DEFAULT_MODEL_NAME
        image_urls = body.get("imageUrls") or []
        aspect_ratio = body.get("aspectRatio", "1:1")
        num_images = str(body.get("numImages", "1"))
        output_format = body.get("outputFormat", "png")
        size = body.get("size", "2K")
        guidance_scale = body.get("guidanceScale", 7.5)
        safety_tolerance = str(body.get("safetyTolerance", "5"))
        sync_mode = bool(body.get("syncMode", False))
        seed = body.get("seed")
        show_prompt = bool(body.get("showPrompt", True))

        access_token = _resolve_access_token(body_access_token or (request.headers.get("x-access-token") or "").strip())
        if not access_token:
            return JSONResponse(
                {"success": False, "error": "当前没有可用 accessToken。请去 /token 登录获取，或在启动时设置环境变量。"},
                status_code=400,
            )
        if not prompt:
            return JSONResponse({"success": False, "error": "prompt 不能为空"}, status_code=400)

        payload_object: dict[str, Any] = {
            "prompt": prompt,
            "negativePrompt": negative_prompt,
            "modelName": model_name,
            "imageUrls": image_urls if isinstance(image_urls, list) else [],
            "aspectRatio": aspect_ratio,
            "numImages": num_images,
            "outputFormat": output_format,
            "syncMode": sync_mode,
            "safetyTolerance": safety_tolerance,
            "guidanceScale": guidance_scale,
            "size": size,
            "showPrompt": show_prompt,
        }
        if seed is not None and seed != "":
            payload_object["seed"] = int(seed)

        payload = _json.dumps(payload_object, ensure_ascii=False)
        submit_result = await _request_json(
            "POST",
            f"{BASE_URL}/agent/ai-image-generation/generate",
            headers={"Content-Type": "application/json", "accessToken": access_token},
            body=payload,
            timeout_ms=REQUEST_TIMEOUT_MS,
        )

        if not submit_result.get("success"):
            raise RuntimeError(submit_result.get("errMessage") or "提交生成任务失败")
        task_code = (submit_result.get("data") or {}).get("task_code")
        if not task_code:
            raise RuntimeError("服务端未返回 task_code")

        # If sync_mode is False, return pending immediately and let frontend poll
        if not sync_mode:
            return JSONResponse({
                "success": True,
                "taskCode": task_code,
                "status": "PENDING",
                "message": "任务已提交，请在前端轮询结果",
            })

        result_data = await _poll_image_result(access_token, task_code)
        urls = result_data.get("image_urls") or []
        if not isinstance(urls, list):
            urls = []
        ext = _get_extension_from_format(output_format)
        saved_images = []

        for i, url in enumerate(urls):
            filename = f"{task_code}_{i + 1}.{ext}"
            file_path = GENERATED_DIR / filename
            await _download_file(url, file_path)
            saved_images.append({
                "filename": filename,
                "localUrl": f"/files/neodomain/generated/{filename}",
                "remoteUrl": url,
            })

        metadata = {
            "taskCode": task_code,
            "prompt": prompt,
            "negativePrompt": negative_prompt,
            "modelName": model_name,
            "imageUrls": image_urls,
            "aspectRatio": aspect_ratio,
            "numImages": num_images,
            "outputFormat": output_format,
            "size": size,
            "guidanceScale": guidance_scale,
            "safetyTolerance": safety_tolerance,
            "syncMode": sync_mode,
            "savedAt": __import__("datetime").datetime.utcnow().isoformat(),
            "tokenSource": "manual" if body_access_token else _runtime_token_source,
            "savedImages": saved_images,
            "rawResult": result_data,
        }

        meta_path = GENERATED_DIR / f"{task_code}.json"
        meta_path.write_text(_json.dumps(metadata, ensure_ascii=False, indent=2), "utf8")
        return JSONResponse({
            "success": True,
            "taskCode": task_code,
            "status": result_data.get("status"),
            "savedImages": saved_images,
            "metadata": metadata,
        })
    except Exception as error:
        if _is_token_expired_error(error):
            _clear_runtime_token()
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "图片生成失败"), status_code=status)


@router.get("/api/result/{task_code}")
async def api_result(task_code: str, request: Request, x_access_token: Optional[str] = Header(None)) -> JSONResponse:
    try:
        access_token = _resolve_access_token((x_access_token or request.query_params.get("accessToken") or "").strip())
        if not access_token:
            return JSONResponse({"success": False, "error": "缺少 accessToken，且服务端没有可用 token"}, status_code=400)
        result = await _request_json(
            "GET",
            f"{BASE_URL}/agent/ai-image-generation/result/{task_code}",
            headers={"accessToken": access_token},
            timeout_ms=30000,
        )
        return JSONResponse(result)
    except Exception as error:
        if _is_token_expired_error(error):
            _clear_runtime_token()
        status = getattr(error, "status_code", 500)
        return JSONResponse(_normalize_api_error(error, "查询结果失败"), status_code=status)
