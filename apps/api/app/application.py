import hashlib
import json
import shutil
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from PIL import Image
import logging

logger = logging.getLogger(__name__)

from .config import DEFAULT_DPI, MAX_UPLOAD_BYTES, PROJECTS_DIR, STORAGE_DIR
from .db import connect, dumps, init_db, loads, now_iso, rel_path, row_to_dict, storage_path
from .design_ops import build_design_texture_canvas, build_fit_preview, build_safety_report
from .image_ops import (
    create_thumbnail,
    extract_alpha_components,
    extract_alpha_components_from_image,
    has_transparent_alpha,
    has_transparent_alpha_image,
    ensure_dimensions_within_limit,
    ensure_image_within_limit,
    image_size,
    make_layout_template,
    make_layout_template_from_image,
    make_mirror_tile,
    make_offset_tile,
    make_red_marker_mask,
    make_red_marker_mask_from_image,
    render_layout,
    render_piece_from_project_piece,
    render_piece_svg,
    write_piece_marker_masks,
)
from .jobs import create_job, update_job_progress
from .layout_ops import ROLE_LABELS, auto_map_pieces, build_design_canvas_config, merge_mapping_into_transform
from .providers import get_provider
from . import neodomain
from .schemas import (
    AssetOut,
    AutoMapRequest,
    DesignCanvasPatch,
    ExportRequest,
    FabricPromptOut,
    GlobalFitRequest,
    JobOut,
    PieceOut,
    PieceTransform,
    ProjectCreate,
    ProjectFromTemplateRequest,
    ProjectOut,
    ProjectUIStatePatch,
    SeamlessRequest,
    SetPieceDefOut,
    SetPieceDefPatch,
    SizeTemplateOut,
    SizeTemplatePieceOut,
    SizeTemplatePiecePatch,
    TemplateSetCreate,
    TemplateSetOut,
    TextureGenerateRequest,
    TextureOut,
)
from .template_ops import match_pieces_to_base, pick_default_base_size, size_sort_key
from .texture_analysis import analyze_texture_fit_source, detect_content_centroid, detect_repeat_period

ALLOWED_UPLOAD_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".svg"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    yield


import os

app = FastAPI(title="Print Studio API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/env")
def api_env() -> dict:
    return {
        "env": os.environ.get("ENV", "unknown"),
        "is_test": os.environ.get("ENV", "") == "test",
        "is_production": os.environ.get("ENV", "") == "production",
    }

STORAGE_DIR.mkdir(parents=True, exist_ok=True)

app.include_router(neodomain.router)

app.mount("/files", StaticFiles(directory=STORAGE_DIR), name="files")


@app.post("/api/projects", response_model=ProjectOut)
def create_project(payload: ProjectCreate) -> dict:
    project_id = f"prj_{uuid.uuid4().hex[:10]}"
    project_dir(project_id).mkdir(parents=True, exist_ok=True)
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into projects(id, name, size_name, dpi, unit, canvas_width, canvas_height, export_config, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.name,
                payload.size_name,
                payload.dpi,
                payload.unit,
                payload.canvas_width,
                payload.canvas_height,
                dumps(payload.export_config),
                created,
                created,
            ),
        )
    return get_project_dict(project_id)


@app.get("/api/projects", response_model=list[ProjectOut])
def list_projects() -> list[dict]:
    with connect() as con:
        rows = con.execute("select * from projects where id != '' order by created_at desc").fetchall()
    return [_project_out(row_to_dict(row)) for row in rows]


@app.get("/api/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str) -> dict:
    return get_project_dict(project_id)


@app.post("/api/projects/{project_id}/assets", response_model=AssetOut)
async def upload_asset(
    project_id: str,
    kind: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    ensure_project(project_id)
    asset_id = f"ast_{uuid.uuid4().hex[:12]}"
    suffix = Path(file.filename or "asset.bin").suffix.lower() or ".bin"
    if suffix not in ALLOWED_UPLOAD_SUFFIXES:
        raise HTTPException(status_code=415, detail=f"不支持的文件格式：{suffix}，仅允许图片文件。")
    asset_dir = project_dir(project_id) / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    dst = asset_dir / f"{asset_id}{suffix}"
    sha = hashlib.sha256()
    total = 0
    with dst.open("wb") as fh:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                fh.close()
                dst.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"文件超过 {MAX_UPLOAD_BYTES // 1024 // 1024} MB 上限。")
            sha.update(chunk)
            fh.write(chunk)
    try:
        width, height = ensure_image_within_limit(dst)
    except ValueError as exc:
        dst.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception:
        width, height = 0, 0
    thumb_dst = asset_dir / f"{asset_id}_thumb.png"
    try:
        create_thumbnail(dst, thumb_dst)
        thumb_path = rel_path(thumb_dst)
    except Exception:
        thumb_path = ""
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into assets(id, project_id, kind, filename, path, thumb_path, width, height, sha256, metadata, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
            """,
            (asset_id, project_id, kind, file.filename or dst.name, rel_path(dst), thumb_path, width, height, sha.hexdigest(), created),
        )
    return get_asset_dict(asset_id)


@app.post("/api/projects/{project_id}/templates/import")
def import_template(project_id: str, asset_id: str = Form(...)) -> dict:
    ensure_project(project_id)
    asset = get_asset_row(asset_id, project_id)
    ext = Path(asset["filename"]).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="请上传 PNG/WebP 透明裁片模板，或白底排版原图 JPG/PNG/WebP。")
    job_id = create_job(project_id, "template_import", {"asset_id": asset_id}, _import_template_job)
    return {"job_id": job_id}


def _import_template_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    asset_id = payload["asset_id"]
    asset = get_asset_row(asset_id, project_id)
    source_path = storage_path(asset["path"])
    ensure_image_within_limit(source_path)
    update_job_progress(job_id, 0.12)
    templates_dir = project_dir(project_id) / "templates"
    try:
        with Image.open(source_path) as opened:
            source_image = opened.convert("RGBA")
    except Exception as exc:
        logger.exception("加载模板源图失败: %s", source_path)
        raise RuntimeError(f"无法加载模板源图 {source_path}: {exc}") from exc
    template_source = "alpha" if has_transparent_alpha_image(source_image) else "layout_image"
    if template_source == "alpha":
        template_path = source_path
        template_image = source_image
    else:
        template_path = templates_dir / f"{asset_id}_template.png"
        update_job_progress(job_id, 0.24)
        make_layout_template_from_image(source_image, template_path)
        try:
            with Image.open(template_path) as opened_template:
                template_image = opened_template.convert("RGBA")
        except Exception as exc:
            logger.exception("加载模板图失败: %s", template_path)
            raise RuntimeError(f"无法加载模板图 {template_path}: {exc}") from exc
    update_job_progress(job_id, 0.4)
    red_marker_path = make_red_marker_mask_from_image(source_image, templates_dir / f"{asset_id}_red_markers.png")

    asset_metadata = loads(asset.get("metadata"), {})
    asset_metadata.update(
        {
            "template_source": template_source,
            "template_path": rel_path(template_path),
            "red_marker_path": rel_path(red_marker_path) if red_marker_path else "",
        }
    )
    pieces_dir = project_dir(project_id) / "pieces"
    for old in [*pieces_dir.glob("*_mask.png"), *pieces_dir.glob("*_markers.png")]:
        old.unlink()
    update_job_progress(job_id, 0.52)
    pieces = extract_alpha_components_from_image(template_image, pieces_dir, min_area=20)
    update_job_progress(job_id, 0.72)
    red_marker_count = write_piece_marker_masks(pieces, red_marker_path)
    asset_metadata["red_marker_count"] = red_marker_count
    with connect() as con:
        con.execute("update assets set metadata = ? where id = ? and project_id = ?", (dumps(asset_metadata), asset_id, project_id))
        con.execute("delete from pieces where project_id = ?", (project_id,))
        for index, piece in enumerate(pieces, start=1):
            piece_id = f"pc_{index:02d}_{uuid.uuid4().hex[:6]}"
            transform = PieceTransform().model_dump()
            con.execute(
                """
                insert into pieces(
                  id, project_id, name, mask_path, polygon, bbox, source_x, source_y, width, height,
                  area, centroid_x, centroid_y, transform, created_at, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    piece_id,
                    project_id,
                    f"裁片 {index:02d}",
                    rel_path(piece["mask_path"]),
                    dumps(piece["polygon"]),
                    dumps(piece["bbox"]),
                    piece["source_x"],
                    piece["source_y"],
                    piece["width"],
                    piece["height"],
                    piece["area"],
                    piece["centroid_x"],
                    piece["centroid_y"],
                    dumps(transform),
                    now_iso(),
                    now_iso(),
                ),
            )
    update_job_progress(job_id, 0.86)
    stored_pieces = raw_pieces(project_id)
    design_canvas = build_design_canvas_config(stored_pieces, {"garment_type": "unknown"})
    design_canvas = carry_existing_design_canvas(project_id, design_canvas)
    mappable_pieces = primary_pieces(stored_pieces)
    mappings = auto_map_pieces(mappable_pieces, design_canvas, "unknown")
    apply_piece_mappings(project_id, mappable_pieces, mappings)
    update_project_design_canvas(project_id, design_canvas)
    update_job_progress(job_id, 0.95)
    return {
        "pieces": list_pieces(project_id),
        "template_source": template_source,
        "template_path": rel_path(template_path),
        "design_canvas": design_canvas,
        "mappings": mappings,
        "warnings": _mapping_warnings(mappings),
    }


@app.get("/api/projects/{project_id}/pieces", response_model=list[PieceOut])
def list_pieces(project_id: str) -> list[dict]:
    ensure_project(project_id)
    with connect() as con:
        rows = con.execute("select * from pieces where project_id = ? order by area desc", (project_id,)).fetchall()
    return [_piece_out(row_to_dict(row)) for row in rows]


@app.patch("/api/projects/{project_id}/pieces/{piece_id}", response_model=PieceOut)
def update_piece(project_id: str, piece_id: str, payload: PieceTransform) -> dict:
    ensure_project(project_id)
    with connect() as con:
        current = con.execute(
            "select mirror_of from pieces where id = ? and project_id = ?",
            (piece_id, project_id),
        ).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Piece not found")
        if current["mirror_of"]:
            return get_piece_dict(piece_id, project_id)
        cur = con.execute(
            "update pieces set transform = ?, updated_at = ? where id = ? and project_id = ?",
            (dumps(payload.model_dump()), now_iso(), piece_id, project_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Piece not found")
    return get_piece_dict(piece_id, project_id)


@app.patch("/api/projects/{project_id}/design-canvas")
def patch_design_canvas(project_id: str, payload: DesignCanvasPatch) -> dict:
    ensure_project(project_id)
    design_canvas = merge_project_design_canvas(project_id, payload.design_canvas)
    return {"design_canvas": design_canvas}


@app.post("/api/projects/{project_id}/layout/auto-map")
def auto_map_layout(project_id: str, payload: AutoMapRequest) -> dict:
    ensure_project(project_id)
    job_id = create_job(project_id, "layout_auto_map", payload.model_dump(), _auto_map_job)
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/textures/generate")
def generate_texture(project_id: str, payload: TextureGenerateRequest) -> dict:
    ensure_project(project_id)
    ensure_job_dimensions(payload.tile_width, payload.tile_height)
    job_id = create_job(project_id, "texture_generate", payload.model_dump(), _generate_texture_job)
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/textures/{texture_id}/seamless")
def create_seamless(project_id: str, texture_id: str, payload: SeamlessRequest) -> dict:
    ensure_project(project_id)
    ensure_job_dimensions(payload.width, payload.height)
    job_id = create_job(
        project_id,
        "texture_seamless",
        {"texture_id": texture_id, **payload.model_dump()},
        _seamless_job,
    )
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/textures/{texture_id}/fit-global")
def fit_global_texture(project_id: str, texture_id: str, payload: GlobalFitRequest) -> dict:
    ensure_project(project_id)
    job_id = create_job(
        project_id,
        "texture_fit_global",
        {"texture_id": texture_id, **payload.model_dump()},
        _fit_global_job,
    )
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/textures/{texture_id}/design-canvas/render")
def render_design_canvas(project_id: str, texture_id: str) -> dict:
    ensure_project(project_id)
    job_id = create_job(
        project_id,
        "design_canvas_render",
        {"texture_id": texture_id},
        _render_design_canvas_job,
    )
    return {"job_id": job_id}


@app.get("/api/projects/{project_id}/textures", response_model=list[TextureOut])
def list_textures(project_id: str) -> list[dict]:
    ensure_project(project_id)
    with connect() as con:
        rows = con.execute("select * from textures where project_id = ? order by created_at desc", (project_id,)).fetchall()
    return [_texture_out(row_to_dict(row)) for row in rows]


@app.delete("/api/projects/{project_id}/textures/{texture_id}")
def delete_texture(project_id: str, texture_id: str) -> dict:
    ensure_project(project_id)
    texture = get_texture_row(texture_id, project_id)
    with connect() as con:
        con.execute("delete from textures where id = ? and project_id = ?", (texture_id, project_id))
    for key in ("source_path", "seamless_path", "design_canvas_path", "source_thumb_path", "seamless_thumb_path", "design_canvas_thumb_path"):
        path = texture.get(key)
        if path:
            storage_path(path).unlink(missing_ok=True)
    return {"deleted": texture_id}


@app.post("/api/projects/{project_id}/render/preview")
def render_preview(project_id: str, texture_id: str = Form("")) -> dict:
    ensure_project(project_id)
    job_id = create_job(project_id, "render_preview", {"texture_id": texture_id}, _preview_job)
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/exports")
def export_project(project_id: str, payload: ExportRequest) -> dict:
    ensure_project(project_id)
    job_id = create_job(project_id, "export_render", payload.model_dump(), _export_job)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from jobs where id = ?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    data = row_to_dict(row)
    data["input"] = loads(data["input"], {})
    data["output"] = loads(data["output"], {})
    return data


# ---------------------------------------------------------------------------
# Template Set APIs
# ---------------------------------------------------------------------------

@app.post("/api/template-sets", response_model=TemplateSetOut)
def create_template_set(payload: TemplateSetCreate) -> dict:
    set_id = f"set_{uuid.uuid4().hex[:10]}"
    template_set_dir(set_id).mkdir(parents=True, exist_ok=True)
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into template_sets(id, name, garment_type, version_label, description, base_size_template_id, design_canvas, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (set_id, payload.name, payload.garment_type, payload.version_label, payload.description, "", "{}", created, created),
        )
    return get_template_set_row(set_id)


@app.get("/api/template-sets", response_model=list[TemplateSetOut])
def list_template_sets() -> list[dict]:
    with connect() as con:
        rows = con.execute("select * from template_sets order by created_at desc").fetchall()
    result: list[dict] = []
    for row in rows:
        try:
            result.append(_template_set_out(row_to_dict(row)))
        except Exception as exc:
            logger.warning("计算套装 %s 的 mapping issues 失败: %s", row["id"], exc)
            data = row_to_dict(row)
            data["design_canvas"] = loads(data.get("design_canvas") or "{}", {})
            data["has_mapping_issues"] = True
            data["mapping_issue_details"] = {"系统": [f"服务端计算异常: {exc}"]}
            result.append(data)
    return result


@app.get("/api/template-sets/{set_id}", response_model=TemplateSetOut)
def get_template_set(set_id: str) -> dict:
    return get_template_set_row(set_id)


@app.patch("/api/template-sets/{set_id}", response_model=TemplateSetOut)
def patch_template_set(set_id: str, payload: TemplateSetCreate) -> dict:
    ensure_template_set(set_id)
    with connect() as con:
        con.execute(
            "update template_sets set name = ?, garment_type = ?, version_label = ?, description = ?, updated_at = ? where id = ?",
            (payload.name, payload.garment_type, payload.version_label, payload.description, now_iso(), set_id),
        )
    return get_template_set_row(set_id)


@app.post("/api/template-sets/{set_id}/base-size")
def set_base_size(set_id: str, size_template_id: str = Form(...)) -> dict:
    ensure_template_set(set_id)
    ensure_size_template(size_template_id, set_id)
    with connect() as con:
        con.execute("update size_templates set is_base = false where set_id = ?", (set_id,))
        con.execute("update size_templates set is_base = true where id = ? and set_id = ?", (size_template_id, set_id))
        con.execute(
            "update template_sets set base_size_template_id = ?, mapping_confirmed_at = '', updated_at = ? where id = ?",
            (size_template_id, now_iso(), set_id),
        )
    clear_derived_transforms(set_id)
    return get_template_set_row(set_id)


def clear_derived_transforms(set_id: str) -> None:
    with connect() as con:
        con.execute(
            """
            update size_template_pieces
            set transform = '{}', updated_at = ?
            where size_template_id in (
                select id from size_templates where set_id = ? and is_base = false
            )
            """,
            (now_iso(), set_id),
        )


@app.post("/api/template-sets/{set_id}/confirm-mapping")
def confirm_template_set_mapping(set_id: str) -> dict:
    ensure_template_set(set_id)
    with connect() as con:
        base_sizes = con.execute(
            "select id from size_templates where set_id = ? and is_base = true", (set_id,)
        ).fetchall()
        if len(base_sizes) != 1:
            raise HTTPException(status_code=400, detail="确认对照表前必须有且仅有一个基准尺寸。")
        base_size_id = base_sizes[0]["id"]

        # 读取基准 transforms
        base_defs = con.execute("select id, base_transform from set_piece_defs where set_id = ?", (set_id,)).fetchall()
        base_transform_by_def: dict[str, dict] = {}
        for bd in base_defs:
            base_transform_by_def[bd["id"]] = loads(bd["base_transform"], {})

        # 读取非基准尺寸
        other_sizes = con.execute(
            "select id from size_templates where set_id = ? and is_base = false", (set_id,)
        ).fetchall()
        for size in other_sizes:
            size_id = size["id"]
            pieces = con.execute(
                "select id, piece_def_id, scale_to_base from size_template_pieces where size_template_id = ?",
                (size_id,),
            ).fetchall()
            for piece in pieces:
                def_id = piece["piece_def_id"]
                scale = float(piece["scale_to_base"] or 1.0)
                base_t = base_transform_by_def.get(def_id, {})
                transform = PieceTransform().model_dump()
                transform["mode"] = base_t.get("mode", "global_canvas")
                transform["design_x"] = base_t.get("design_x", 0)
                transform["design_y"] = base_t.get("design_y", 0)
                transform["design_width"] = (base_t.get("design_width") or 0) * scale
                transform["design_height"] = (base_t.get("design_height") or 0) * scale
                transform["design_rotation"] = base_t.get("design_rotation", 0)
                transform["offset_x"] = (base_t.get("offset_x", 0)) * scale
                transform["offset_y"] = (base_t.get("offset_y", 0)) * scale
                transform["scale"] = base_t.get("scale", 1)
                transform["rotation"] = base_t.get("rotation", 0)
                transform["mirror_x"] = base_t.get("mirror_x", False)
                transform["mirror_y"] = base_t.get("mirror_y", False)
                transform["grainline_angle"] = base_t.get("grainline_angle", 0)
                transform["piece_role"] = base_t.get("piece_role", "")
                transform["role_confirmed"] = base_t.get("role_confirmed", False)
                transform["global_enabled"] = base_t.get("global_enabled", True)
                transform["safe_zones"] = base_t.get("safe_zones", [])
                transform["avoid_zones"] = base_t.get("avoid_zones", [])
                transform["fit_confidence"] = base_t.get("fit_confidence", 0)
                transform["fit_note"] = base_t.get("fit_note", "")
                con.execute(
                    "update size_template_pieces set transform = ?, updated_at = ? where id = ?",
                    (dumps(transform), now_iso(), piece["id"]),
                )

        con.execute(
            "update template_sets set mapping_confirmed_at = ?, updated_at = ? where id = ?",
            (now_iso(), now_iso(), set_id),
        )
    return get_template_set_row(set_id)


@app.post("/api/template-sets/{set_id}/assets", response_model=AssetOut)
async def upload_template_set_asset(
    set_id: str,
    file: UploadFile = File(...),
) -> dict:
    ensure_template_set(set_id)
    asset_id = f"ast_{uuid.uuid4().hex[:12]}"
    suffix = Path(file.filename or "asset.bin").suffix.lower() or ".bin"
    if suffix not in ALLOWED_UPLOAD_SUFFIXES:
        raise HTTPException(status_code=415, detail=f"不支持的文件格式：{suffix}，仅允许图片文件。")
    asset_dir = template_set_dir(set_id) / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    dst = asset_dir / f"{asset_id}{suffix}"
    sha = hashlib.sha256()
    total = 0
    with dst.open("wb") as fh:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_UPLOAD_BYTES:
                fh.close()
                dst.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail=f"文件超过 {MAX_UPLOAD_BYTES // 1024 // 1024} MB 上限。")
            sha.update(chunk)
            fh.write(chunk)
    width, height = safe_image_size(dst)
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into assets(id, project_id, kind, filename, path, width, height, sha256, metadata, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
            """,
            (asset_id, "", "template_set", file.filename or dst.name, rel_path(dst), width, height, sha.hexdigest(), created),
        )
    return get_asset_dict(asset_id)


@app.post("/api/template-sets/{set_id}/sizes/import")
def import_template_set_size(set_id: str, asset_id: str = Form(...), size_name: str = Form(...)) -> dict:
    ensure_template_set(set_id)
    asset = get_asset_row(asset_id, "")
    ext = Path(asset["filename"]).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="请上传 PNG/WebP 透明裁片模板，或白底排版原图 JPG/PNG/WebP。")

    source_path = storage_path(asset["path"])
    template_source = "alpha" if has_transparent_alpha(source_path) else "layout_image"
    size_id = f"sz_{uuid.uuid4().hex[:8]}"
    sizes_dir = template_set_dir(set_id) / "sizes" / size_id
    sizes_dir.mkdir(parents=True, exist_ok=True)

    if template_source == "alpha":
        template_path = source_path
    else:
        template_path = sizes_dir / "template.png"
        make_layout_template(source_path, template_path)

    red_marker_path = make_red_marker_mask(source_path, sizes_dir / "red_markers.png")
    pieces_dir = sizes_dir / "pieces"
    pieces = extract_alpha_components(template_path, pieces_dir)
    red_marker_count = write_piece_marker_masks(pieces, red_marker_path)

    width, height = safe_image_size(template_path)
    created = now_iso()

    with connect() as con:
        # 检查是否已有基准
        base_row = con.execute(
            "select id from size_templates where set_id = ? and is_base = true limit 1", (set_id,)
        ).fetchone()
        has_base = bool(base_row)
        is_base = not has_base

        con.execute(
            """
            insert into size_templates(
              id, set_id, size_name, asset_id, template_source, template_path,
              red_marker_path, red_marker_count, width, height, pieces_count, is_base, created_at, updated_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                size_id, set_id, size_name, asset_id, template_source, rel_path(template_path),
                rel_path(red_marker_path) if red_marker_path else "",
                red_marker_count, width, height, len(pieces), is_base, created, created,
            ),
        )

        if is_base:
            con.execute(
                "update template_sets set base_size_template_id = ?, updated_at = ? where id = ?",
                (size_id, now_iso(), set_id),
            )
            # 首次导入：创建 piece_defs 和 size_template_pieces
            stored_pieces: list[dict] = []
            for index, piece in enumerate(pieces, start=1):
                piece_id = f"pc_{index:02d}_{uuid.uuid4().hex[:6]}"
                stored_pieces.append({
                    **piece,
                    "id": piece_id,
                    "mask_path": str(piece["mask_path"]),
                })
            design_canvas = build_design_canvas_config(stored_pieces, {"garment_type": "unknown"})
            con.execute(
                "update template_sets set design_canvas = ?, updated_at = ? where id = ?",
                (dumps(design_canvas), now_iso(), set_id),
            )
            mappings = auto_map_pieces(stored_pieces, design_canvas, "unknown")
            mapping_by_id = {m["id"]: m for m in mappings}

            for index, piece in enumerate(stored_pieces, start=1):
                mapping = mapping_by_id.get(piece["id"], {})
                def_id = f"def_{index:02d}_{uuid.uuid4().hex[:6]}"
                piece_role = mapping.get("piece_role", "unknown")
                name = f"{ROLE_LABELS.get(piece_role, '裁片')} {index:02d}"
                base_transform = merge_mapping_into_transform(PieceTransform().model_dump(), mapping)
                con.execute(
                    """
                    insert into set_piece_defs(id, set_id, piece_role, name, sort_order, base_transform, created_at, updated_at)
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (def_id, set_id, piece_role, name, index, dumps(base_transform), created, created),
                )
                con.execute(
                    """
                    insert into size_template_pieces(
                      id, size_template_id, piece_def_id, mask_path, polygon, bbox,
                      source_x, source_y, width, height, area, centroid_x, centroid_y, scale_to_base, created_at, updated_at
                    )
                    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        piece["id"], size_id, def_id, rel_path(Path(piece["mask_path"])), dumps(piece["polygon"]),
                        dumps(piece["bbox"]), piece["source_x"], piece["source_y"],
                        piece["width"], piece["height"], piece["area"],
                        piece["centroid_x"], piece["centroid_y"], 1.0, created, created,
                    ),
                )
        else:
            # 已有基准：匹配到基准 piece_defs
            base_size_id = base_row["id"]
            base_defs = list_set_piece_defs(set_id)
            base_geos = raw_size_template_geos(base_size_id)
            # 给 base_geos 补充 piece_def_id
            for bg in base_geos:
                for d in base_defs:
                    if d["id"] == bg.get("piece_def_id"):
                        bg["piece_def_id"] = d["id"]
                        break

            matches = match_pieces_to_base(pieces, base_geos)
            match_by_index = {m["new_piece_index"]: m for m in matches}

            for index, piece in enumerate(pieces, start=1):
                match = match_by_index.get(index - 1, {})
                piece_id = f"pc_{index:02d}_{uuid.uuid4().hex[:6]}"
                con.execute(
                    """
                    insert into size_template_pieces(
                      id, size_template_id, piece_def_id, mask_path, polygon, bbox,
                      source_x, source_y, width, height, area, centroid_x, centroid_y, scale_to_base, created_at, updated_at
                    )
                    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        piece_id, size_id, match.get("piece_def_id", ""), rel_path(piece["mask_path"]),
                        dumps(piece["polygon"]), dumps(piece["bbox"]),
                        piece["source_x"], piece["source_y"], piece["width"], piece["height"],
                        piece["area"], piece["centroid_x"], piece["centroid_y"],
                        match.get("scale_to_base", 1.0), created, created,
                    ),
                )

    warnings: list[str] = []
    if has_base:
        base_geo_count = len(base_geos)
        if len(pieces) != base_geo_count:
            warnings.append(f"裁片数量与基准不一致：基准 {base_geo_count} 个，当前 {len(pieces)} 个。")
        unmatched = len(pieces) - len(matches)
        if unmatched > 0:
            warnings.append(f"有 {unmatched} 个裁片未能自动匹配到基准类型，请在配置页手动关联。")

    with connect() as con:
        con.execute(
            "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
            (now_iso(), set_id),
        )
    clear_derived_transforms(set_id)

    return {
        "size_template": _size_template_out(get_size_template_row(size_id)),
        "pieces": list_size_template_pieces(size_id),
        "warnings": warnings,
    }


@app.get("/api/template-sets/{set_id}/piece-defs", response_model=list[SetPieceDefOut])
def get_piece_defs(set_id: str) -> list[dict]:
    ensure_template_set(set_id)
    return list_set_piece_defs(set_id)


@app.patch("/api/template-sets/{set_id}/piece-defs/{def_id}", response_model=SetPieceDefOut)
def patch_piece_def(set_id: str, def_id: str, payload: SetPieceDefPatch) -> dict:
    ensure_template_set(set_id)
    with connect() as con:
        cur = con.execute(
            "update set_piece_defs set updated_at = ? where id = ? and set_id = ?",
            (now_iso(), def_id, set_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Piece def not found")
        if payload.name:
            con.execute("update set_piece_defs set name = ? where id = ?", (payload.name, def_id))
        if payload.piece_role:
            con.execute("update set_piece_defs set piece_role = ? where id = ?", (payload.piece_role, def_id))
        if payload.sort_order >= 0:
            con.execute("update set_piece_defs set sort_order = ? where id = ?", (payload.sort_order, def_id))
        if payload.base_transform:
            con.execute(
                "update set_piece_defs set base_transform = ? where id = ?",
                (dumps(payload.base_transform), def_id),
            )
        row = con.execute("select * from set_piece_defs where id = ?", (def_id,)).fetchone()
        if payload.piece_role or payload.sort_order >= 0 or payload.base_transform:
            con.execute(
                "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
                (now_iso(), set_id),
            )
    clear_derived_transforms(set_id)
    return _set_piece_def_out(row_to_dict(row))


@app.delete("/api/template-sets/{set_id}/piece-defs/{def_id}")
def delete_piece_def(set_id: str, def_id: str) -> dict:
    ensure_template_set(set_id)
    with connect() as con:
        cur = con.execute("delete from set_piece_defs where id = ? and set_id = ?", (def_id, set_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Piece def not found")
        con.execute(
            "update size_template_pieces set piece_def_id = '', updated_at = ? where piece_def_id = ?",
            (now_iso(), def_id),
        )
        con.execute(
            "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
            (now_iso(), set_id),
        )
    clear_derived_transforms(set_id)
    return {"deleted": def_id}


@app.get("/api/template-sets/{set_id}/sizes", response_model=list[SizeTemplateOut])
def list_size_templates(set_id: str) -> list[dict]:
    ensure_template_set(set_id)
    with connect() as con:
        rows = con.execute("select * from size_templates where set_id = ? order by created_at asc", (set_id,)).fetchall()
    return [_size_template_out(row_to_dict(row)) for row in rows]


@app.get("/api/template-sets/{set_id}/sizes/{size_id}/pieces", response_model=list[SizeTemplatePieceOut])
def list_size_template_pieces_endpoint(set_id: str, size_id: str) -> list[dict]:
    ensure_template_set(set_id)
    ensure_size_template(size_id, set_id)
    return list_size_template_pieces(size_id)


@app.patch("/api/template-sets/{set_id}/sizes/{size_id}/pieces/{piece_id}", response_model=SizeTemplatePieceOut)
def patch_size_template_piece(
    set_id: str, size_id: str, piece_id: str, payload: SizeTemplatePiecePatch
) -> dict:
    ensure_template_set(set_id)
    ensure_size_template(size_id, set_id)
    with connect() as con:
        # 重新计算 scale_to_base
        new_scale = 1.0
        if payload.piece_def_id:
            base_size_id = con.execute(
                "select base_size_template_id from template_sets where id = ?", (set_id,)
            ).fetchone()["base_size_template_id"]
            if base_size_id:
                target_piece = con.execute(
                    "select width from size_template_pieces where id = ? and size_template_id = ?",
                    (piece_id, size_id),
                ).fetchone()
                base_piece = con.execute(
                    "select width from size_template_pieces where piece_def_id = ? and size_template_id = ?",
                    (payload.piece_def_id, base_size_id),
                ).fetchone()
                if target_piece and base_piece and base_piece["width"] > 0:
                    new_scale = round(target_piece["width"] / base_piece["width"], 4)
        cur = con.execute(
            "update size_template_pieces set piece_def_id = ?, scale_to_base = ?, updated_at = ? where id = ? and size_template_id = ?",
            (payload.piece_def_id, new_scale, now_iso(), piece_id, size_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Piece not found")
        row = con.execute(
            """
            select p.*, d.name as def_name, d.piece_role as def_role
            from size_template_pieces p
            left join set_piece_defs d on d.id = p.piece_def_id
            where p.id = ?
            """,
            (piece_id,),
        ).fetchone()
        con.execute(
            "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
            (now_iso(), set_id),
        )
    clear_derived_transforms(set_id)
    data = row_to_dict(row)
    data["polygon"] = loads(data["polygon"], [])
    data["bbox"] = loads(data["bbox"], {})
    data["transform"] = loads(data.get("transform"), {})
    data["mask_url"] = file_url(data["mask_path"])
    data["name"] = data.get("def_name") or "未命名"
    data["piece_role"] = data.get("def_role") or "unknown"
    return data


@app.delete("/api/template-sets/{set_id}/sizes/{size_id}/pieces/{piece_id}")
def delete_size_template_piece(set_id: str, size_id: str, piece_id: str) -> dict:
    ensure_template_set(set_id)
    ensure_size_template(size_id, set_id)
    with connect() as con:
        cur = con.execute(
            "delete from size_template_pieces where id = ? and size_template_id = ?",
            (piece_id, size_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Piece not found")
        con.execute(
            "update size_templates set pieces_count = max(0, pieces_count - 1), updated_at = ? where id = ?",
            (now_iso(), size_id),
        )
        con.execute(
            "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
            (now_iso(), set_id),
        )
    clear_derived_transforms(set_id)
    return {"deleted": piece_id}


@app.delete("/api/template-sets/{set_id}")
def delete_template_set(set_id: str) -> dict:
    ensure_template_set(set_id)
    with connect() as con:
        # 收集要删除的 size_ids
        size_ids = [r["id"] for r in con.execute("select id from size_templates where set_id = ?", (set_id,)).fetchall()]
        for sid in size_ids:
            con.execute("delete from size_template_pieces where size_template_id = ?", (sid,))
            con.execute("delete from size_templates where id = ?", (sid,))
        con.execute("delete from set_piece_defs where set_id = ?", (set_id,))
        con.execute("delete from assets where project_id = '' and path like ?", (f"template_sets/{set_id}/%",))
        con.execute("delete from template_sets where id = ?", (set_id,))
    shutil.rmtree(template_set_dir(set_id), ignore_errors=True)
    return {"deleted": set_id}


@app.delete("/api/template-sets/{set_id}/sizes/{size_id}")
def delete_size_template(set_id: str, size_id: str) -> dict:
    ensure_template_set(set_id)
    size_row = get_size_template_row(size_id)
    with connect() as con:
        con.execute("delete from size_template_pieces where size_template_id = ?", (size_id,))
        con.execute("delete from size_templates where id = ? and set_id = ?", (size_id, set_id))
        # 如果删除的是基准，需要重新指定基准（选剩余中最小）
        if size_row.get("is_base"):
            remaining = con.execute("select size_name, id from size_templates where set_id = ?", (set_id,)).fetchall()
            if remaining:
                new_base = min(remaining, key=lambda r: size_sort_key(r["size_name"]))
                con.execute("update size_templates set is_base = true where id = ?", (new_base["id"],))
                con.execute(
                    "update template_sets set base_size_template_id = ? where id = ?",
                    (new_base["id"], set_id),
                )
            else:
                con.execute(
                    "update template_sets set base_size_template_id = ? where id = ?",
                    ("", set_id),
                )
        con.execute(
            "update template_sets set mapping_confirmed_at = '', updated_at = ? where id = ?",
            (now_iso(), set_id),
        )
    clear_derived_transforms(set_id)
    return {"deleted": size_id}


@app.post("/api/projects/from-template-set", response_model=ProjectOut)
def create_project_from_template_set(payload: ProjectFromTemplateRequest) -> dict:
    ensure_template_set(payload.set_id)
    with connect() as con:
        set_row = con.execute("select * from template_sets where id = ?", (payload.set_id,)).fetchone()
        size_row = con.execute(
            "select * from size_templates where set_id = ? and size_name = ?",
            (payload.set_id, payload.size_name),
        ).fetchone()
    if not set_row or not size_row:
        raise HTTPException(status_code=404, detail="Template set or size not found")

    project_id = f"prj_{uuid.uuid4().hex[:10]}"
    project_dir(project_id).mkdir(parents=True, exist_ok=True)
    created = now_iso()

    size_id = size_row["id"]
    set_data = row_to_dict(set_row)
    size_data = row_to_dict(size_row)
    design_canvas = loads(set_data.get("design_canvas") or "{}", {})

    # 复制 asset
    asset = get_asset_row(size_data["asset_id"], "")
    asset_id_new = f"ast_{uuid.uuid4().hex[:12]}"
    asset_dst = project_dir(project_id) / "assets" / f"{asset_id_new}{Path(asset['filename']).suffix.lower() or '.bin'}"
    asset_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(storage_path(asset["path"]), asset_dst)

    # 复制 template 图和 markers
    tpl_src = storage_path(size_data["template_path"])
    tpl_dst = project_dir(project_id) / "templates" / f"{asset_id_new}_template.png"
    tpl_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(tpl_src, tpl_dst)
    marker_src = storage_path(size_data["red_marker_path"]) if size_data.get("red_marker_path") else None
    marker_dst = project_dir(project_id) / "templates" / f"{asset_id_new}_red_markers.png" if marker_src else None
    if marker_src and marker_src.exists() and marker_dst:
        shutil.copyfile(marker_src, marker_dst)

    # 读取基准 transforms
    base_transforms: dict[str, dict] = {}
    with connect() as con:
        base_defs = con.execute(
            "select * from set_piece_defs where set_id = ?", (payload.set_id,)
        ).fetchall()
        for bd in base_defs:
            bd_data = row_to_dict(bd)
            base_transforms[bd_data["id"]] = loads(bd_data.get("base_transform") or "{}", {})

    # 复制 pieces
    pieces_data = list_size_template_pieces(size_id)
    pieces_dir = project_dir(project_id) / "pieces"
    pieces_dir.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        export_config = {"design_canvas": design_canvas}
        con.execute(
            """
            insert into projects(id, name, size_name, template_set_id, dpi, unit, canvas_width, canvas_height, export_config, created_at, updated_at)
            values (?, ?, ?, ?, ?, 'px', 0, 0, ?, ?, ?)
            """,
            (
                project_id,
                f"{set_data['name']}-{size_data['size_name']}",
                size_data["size_name"],
                payload.set_id,
                DEFAULT_DPI,
                dumps(export_config),
                created,
                created,
            ),
        )
        piece_def_map: dict[str, str] = {}
        piece_transform_map: dict[str, dict] = {}
        for index, piece in enumerate(pieces_data, start=1):
            # 复制 mask
            mask_src = storage_path(piece["mask_path"])
            piece_id = f"pc_{index:02d}_{uuid.uuid4().hex[:6]}"
            mask_dst = pieces_dir / f"{piece_id}_mask.png"
            shutil.copyfile(mask_src, mask_dst)
            # 复制 marker
            from .image_ops import marker_path_for_mask
            marker_src2 = marker_path_for_mask(mask_src)
            if marker_src2.exists():
                marker_dst2 = marker_path_for_mask(mask_dst)
                shutil.copyfile(marker_src2, marker_dst2)

            # transform
            transform = PieceTransform().model_dump()
            if payload.copy_design_from_base and not size_data.get("is_base"):
                precomputed = piece.get("transform") or {}
                if precomputed:
                    transform = {**transform, **precomputed}
                else:
                    base_t = base_transforms.get(piece["piece_def_id"], {})
                    scale = float(piece.get("scale_to_base", 1.0) or 1.0)
                    transform["mode"] = base_t.get("mode", "global_canvas")
                    transform["design_x"] = base_t.get("design_x", 0)
                    transform["design_y"] = base_t.get("design_y", 0)
                    fallback_scale = 1 if base_t else scale
                    transform["design_width"] = (base_t.get("design_width") or piece["width"]) * scale * fallback_scale
                    transform["design_height"] = (base_t.get("design_height") or piece["height"]) * scale * fallback_scale
                    transform["design_rotation"] = base_t.get("design_rotation", 0)
                    transform["offset_x"] = base_t.get("offset_x", 0) * scale
                    transform["offset_y"] = base_t.get("offset_y", 0) * scale
                    transform["scale"] = base_t.get("scale", 1)
                    transform["rotation"] = base_t.get("rotation", 0)
                    transform["mirror_x"] = base_t.get("mirror_x", False)
                    transform["mirror_y"] = base_t.get("mirror_y", False)
                    transform["grainline_angle"] = base_t.get("grainline_angle", 0)
                    transform["piece_role"] = base_t.get("piece_role", "")
                    transform["role_confirmed"] = base_t.get("role_confirmed", False)
                    transform["position_confirmed"] = base_t.get("position_confirmed", False)
                    transform["global_enabled"] = base_t.get("global_enabled", True)
                    transform["safe_zones"] = base_t.get("safe_zones", [])
                    transform["avoid_zones"] = base_t.get("avoid_zones", [])
                    transform["fit_confidence"] = base_t.get("fit_confidence", 0)
                    transform["fit_note"] = base_t.get("fit_note", "")

            # 读取 piece_def 的 name 和 role
            def_row = con.execute("select * from set_piece_defs where id = ?", (piece["piece_def_id"],)).fetchone()
            piece_name = def_row["name"] if def_row else f"裁片 {index:02d}"
            piece_role = def_row["piece_role"] if def_row else "unknown"
            transform["piece_role"] = piece_role

            con.execute(
                """
                insert into pieces(
                  id, project_id, name, mask_path, polygon, bbox, source_x, source_y,
                  width, height, area, centroid_x, centroid_y, transform, created_at, updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    piece_id, project_id, piece_name, rel_path(mask_dst),
                    dumps(piece["polygon"]), dumps(piece["bbox"]),
                    piece["source_x"], piece["source_y"], piece["width"], piece["height"],
                    piece["area"], piece["centroid_x"], piece["centroid_y"],
                    dumps(transform), created, created,
                ),
            )
            piece_def_map[piece["piece_def_id"]] = piece_id
            piece_transform_map[piece_id] = transform

        # 第二遍：处理关联裁片（mirror_of）
        for piece in pieces_data:
            def_id = piece["piece_def_id"]
            base_t = base_transforms.get(def_id, {})
            linked_def_id = base_t.get("linked_def_id", "")
            if not linked_def_id:
                continue
            source_piece_id = piece_def_map.get(linked_def_id)
            linked_piece_id = piece_def_map.get(def_id)
            if not source_piece_id or not linked_piece_id:
                continue
            source_transform = piece_transform_map[source_piece_id]
            current_transform = piece_transform_map[linked_piece_id]
            linked_transform = PieceTransform().model_dump()
            linked_transform["mode"] = source_transform.get("mode", current_transform.get("mode", "global_canvas"))
            linked_transform["piece_role"] = current_transform.get("piece_role", "")
            linked_transform["role_confirmed"] = current_transform.get("role_confirmed", False)
            linked_transform["position_confirmed"] = current_transform.get("position_confirmed", False)
            linked_transform["fit_confidence"] = current_transform.get("fit_confidence", 0)
            linked_transform["fit_note"] = "内容由关联裁片派生，不参与全局定位。"
            linked_transform["global_enabled"] = False
            linked_transform["locked"] = True
            linked_transform["mirror_x"] = bool(base_t.get("link_mirror_x", False))
            linked_transform["mirror_y"] = bool(base_t.get("link_mirror_y", False))
            piece_transform_map[linked_piece_id] = linked_transform
            con.execute(
                "update pieces set mirror_of = ?, transform = ? where id = ?",
                (source_piece_id, dumps(linked_transform), linked_piece_id),
            )

        con.execute(
            """
            insert into assets(id, project_id, kind, filename, path, width, height, sha256, metadata, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset_id_new, project_id, "template", asset["filename"], rel_path(asset_dst),
                asset.get("width", 0), asset.get("height", 0), asset["sha256"],
                dumps({"template_source": size_data["template_source"]}), created,
            ),
        )

    return get_project_dict(project_id)


@app.get("/api/fabric-prompts", response_model=list[FabricPromptOut])
def list_fabric_prompts(category: str = "") -> list[dict]:
    with connect() as con:
        if category:
            rows = con.execute(
                "select id, code, name, scenarios, prompt, category, sort_order from fabric_prompts where category = ? order by sort_order",
                (category,),
            ).fetchall()
        else:
            rows = con.execute("select id, code, name, scenarios, prompt, category, sort_order from fabric_prompts order by sort_order").fetchall()
    return [row_to_dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Template Set helpers
# ---------------------------------------------------------------------------

def template_set_dir(set_id: str) -> Path:
    return STORAGE_DIR / "template_sets" / set_id


def ensure_template_set(set_id: str) -> None:
    with connect() as con:
        row = con.execute("select id from template_sets where id = ?", (set_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template set not found")


def ensure_size_template(size_id: str, set_id: str) -> None:
    with connect() as con:
        row = con.execute("select id from size_templates where id = ? and set_id = ?", (size_id, set_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Size template not found")


def get_template_set_row(set_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from template_sets where id = ?", (set_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Template set not found")
    return _template_set_out(row_to_dict(row))


def get_size_template_row(size_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from size_templates where id = ?", (size_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Size template not found")
    return row_to_dict(row)


def list_set_piece_defs(set_id: str) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "select * from set_piece_defs where set_id = ? order by sort_order asc, created_at asc",
            (set_id,),
        ).fetchall()
    return [_set_piece_def_out(row_to_dict(row)) for row in rows]


def list_size_template_pieces(size_id: str) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            """
            select p.*, d.name as def_name, d.piece_role as def_role
            from size_template_pieces p
            left join set_piece_defs d on d.id = p.piece_def_id
            where p.size_template_id = ?
            order by d.sort_order asc, p.area desc
            """,
            (size_id,),
        ).fetchall()
    result = []
    for row in rows:
        data = row_to_dict(row)
        data["polygon"] = loads(data["polygon"], [])
        data["bbox"] = loads(data["bbox"], {})
        data["transform"] = loads(data.get("transform"), {})
        data["mask_url"] = file_url(data["mask_path"])
        data["name"] = data.get("def_name") or "未命名"
        data["piece_role"] = data.get("def_role") or "unknown"
        result.append(data)
    return result


def raw_template_pieces(size_id: str) -> list[dict]:
    with connect() as con:
        rows = con.execute(
            "select * from size_template_pieces where size_template_id = ? order by area desc", (size_id,)
        ).fetchall()
    pieces = []
    for row in rows:
        data = row_to_dict(row)
        data["bbox"] = loads(data["bbox"], {})
        data["polygon"] = loads(data["polygon"], [])
        data["mask_path"] = storage_path(data["mask_path"])
        pieces.append(data)
    return pieces


def raw_size_template_geos(size_id: str) -> list[dict]:
    return raw_template_pieces(size_id)


def _template_set_out(data: dict) -> dict:
    data["design_canvas"] = loads(data.get("design_canvas") or "{}", {})
    data["has_mapping_issues"] = compute_mapping_issues(data["id"])
    data["mapping_issue_details"] = get_mapping_issue_details(data["id"])
    return data


def compute_mapping_issues(set_id: str) -> bool:
    with connect() as con:
        set_row = con.execute("select mapping_confirmed_at from template_sets where id = ?", (set_id,)).fetchone()
        if not set_row or not set_row["mapping_confirmed_at"]:
            return True
        def_count = con.execute("select count(*) from set_piece_defs where set_id = ?", (set_id,)).fetchone()[0]
        size_rows = con.execute("select id, pieces_count from size_templates where set_id = ?", (set_id,)).fetchall()
        if not size_rows:
            return False
        if def_count == 0:
            return True
        for size_row in size_rows:
            size_id = size_row["id"]
            pieces = con.execute(
                "select piece_def_id from size_template_pieces where size_template_id = ?", (size_id,)
            ).fetchall()
            if len(pieces) != def_count:
                return True
            seen = set()
            for p in pieces:
                pid = p["piece_def_id"]
                if not pid or pid in seen:
                    return True
                seen.add(pid)
    return False


def get_mapping_issue_details(set_id: str) -> dict[str, list[str]]:
    details: dict[str, list[str]] = {}
    with connect() as con:
        set_row = con.execute("select mapping_confirmed_at from template_sets where id = ?", (set_id,)).fetchone()
        if not set_row:
            return details
        def_count = con.execute("select count(*) from set_piece_defs where set_id = ?", (set_id,)).fetchone()[0]
        def_rows = con.execute("select id, name from set_piece_defs where set_id = ?", (set_id,)).fetchall()
        def_names = {row["id"]: row["name"] for row in def_rows}
        size_rows = con.execute(
            "select id, size_name from size_templates where set_id = ?", (set_id,)
        ).fetchall()
        for size_row in size_rows:
            size_id = size_row["id"]
            size_name = size_row["size_name"]
            reasons: list[str] = []
            pieces = con.execute(
                "select piece_def_id from size_template_pieces where size_template_id = ?", (size_id,)
            ).fetchall()
            if len(pieces) != def_count:
                reasons.append(f"裁片数量不匹配，基准定义有 {def_count} 个，当前尺寸有 {len(pieces)} 个")
            seen = set()
            duplicates = set()
            empty = False
            for p in pieces:
                pid = p["piece_def_id"]
                if not pid:
                    empty = True
                elif pid in seen:
                    duplicates.add(pid)
                seen.add(pid)
            if empty:
                reasons.append("存在未识别的裁片（未匹配到基准定义）")
            for dup_id in sorted(duplicates, key=lambda x: (x is None, str(x))):
                reasons.append(f"裁片「{def_names.get(dup_id, dup_id)}」被重复对应")
            if reasons:
                details[size_name] = reasons
    return details


def _size_template_out(data: dict) -> dict:
    data["template_url"] = file_url(data["template_path"]) if data.get("template_path") else ""
    data["red_marker_url"] = file_url(data["red_marker_path"]) if data.get("red_marker_path") else ""
    return data


def _size_template_piece_out(data: dict) -> dict:
    data["polygon"] = loads(data["polygon"], [])
    data["bbox"] = loads(data["bbox"], {})
    data["mask_url"] = file_url(data["mask_path"])
    return data


def _set_piece_def_out(data: dict) -> dict:
    data["base_transform"] = loads(data.get("base_transform") or "{}", {})
    return data


def _generate_texture_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture_id = f"tex_{uuid.uuid4().hex[:10]}"
    textures_dir = project_dir(project_id) / "textures"
    textures_dir.mkdir(parents=True, exist_ok=True)
    source_type = payload.get("source_type", "pattern")
    source_path = ""
    source_filename = ""
    if payload.get("source_asset_id"):
        asset = get_asset_row(payload["source_asset_id"], project_id)
        source_filename = asset.get("filename", "")
        src = storage_path(asset["path"])
        ensure_image_within_limit(src)
        dst = textures_dir / f"{texture_id}_source{src.suffix.lower() or '.png'}"
        shutil.copyfile(src, dst)
        source_path = rel_path(dst)
        width, height = safe_image_size(dst)
    else:
        width = int(payload.get("tile_width") or 2048)
        height = int(payload.get("tile_height") or 2048)
        ensure_dimensions_within_limit(width, height)
        dst = textures_dir / f"{texture_id}_source.png"
        if neodomain._get_active_server_token():
            provider = get_provider("neodomain")
        else:
            provider = get_provider(payload.get("provider", "local"))
        provider.generate_texture(payload.get("prompt") or "服装布料面料", dst, width, height, payload.get("seed", ""))
        source_path = rel_path(dst)
    analysis = analyze_texture_fit_source(
        storage_path(source_path),
        source_type=source_type,
        prompt=payload.get("prompt", ""),
        filename=source_filename,
    )
    fit_source = analysis["recommendation"]
    seamless_path = ""
    seamless_mode = ""
    source_thumb_path = ""
    seamless_thumb_path = ""
    if fit_source == "seamless":
        seamless_out = textures_dir / f"{texture_id}_seamless.png"
        seamless_width = int(payload.get("tile_width") or 4096)
        seamless_height = int(payload.get("tile_height") or 4096)
        ensure_dimensions_within_limit(seamless_width, seamless_height)
        make_mirror_tile(storage_path(source_path), seamless_out, seamless_width, seamless_height)
        seamless_path = rel_path(seamless_out)
        seamless_mode = "mirror"
        width, height = image_size(seamless_out)
    try:
        thumb_dst = textures_dir / f"{texture_id}_source_thumb.png"
        create_thumbnail(storage_path(source_path), thumb_dst)
        source_thumb_path = rel_path(thumb_dst)
    except Exception:
        pass
    if seamless_path:
        try:
            seamless_thumb_dst = textures_dir / f"{texture_id}_seamless_thumb.png"
            create_thumbnail(storage_path(seamless_path), seamless_thumb_dst)
            seamless_thumb_path = rel_path(seamless_thumb_dst)
        except Exception:
            pass
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into textures(
              id, project_id, source_type, source_path, source_thumb_path, seamless_path, seamless_thumb_path,
              fit_source_recommendation, fit_source, seamless_mode, analysis, prompt, provider, model, seed, width, height, created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                texture_id,
                project_id,
                source_type,
                source_path,
                source_thumb_path,
                seamless_path,
                seamless_thumb_path,
                analysis["recommendation"],
                fit_source,
                seamless_mode,
                dumps(analysis),
                payload.get("prompt", ""),
                payload.get("provider", "local"),
                payload.get("model", "local"),
                payload.get("seed", ""),
                width,
                height,
                created,
            ),
        )
    return {"texture": _texture_out(get_texture_row(texture_id, project_id))}


def _seamless_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture = get_texture_row(payload["texture_id"], project_id)
    source = storage_path(texture["source_path"])
    ensure_image_within_limit(source)
    out = project_dir(project_id) / "textures" / f"{texture['id']}_seamless.png"
    width = int(payload.get("width") or 4096)
    height = int(payload.get("height") or 4096)
    ensure_dimensions_within_limit(width, height)
    if payload.get("mode") == "offset":
        make_offset_tile(source, out, width, height)
    else:
        make_mirror_tile(source, out, width, height)
    seamless_thumb_path = ""
    try:
        seamless_thumb_dst = project_dir(project_id) / "textures" / f"{texture['id']}_seamless_thumb.png"
        create_thumbnail(out, seamless_thumb_dst)
        seamless_thumb_path = rel_path(seamless_thumb_dst)
    except Exception:
        pass
    with connect() as con:
        con.execute(
            """
            update textures
            set seamless_path = ?, seamless_thumb_path = ?, fit_source = 'seamless', seamless_mode = ?, width = ?, height = ?, version = version + 1
            where id = ? and project_id = ?
            """,
            (rel_path(out), seamless_thumb_path, payload.get("mode") or "mirror", width, height, texture["id"], project_id),
        )
    return {"texture": _texture_out(get_texture_row(texture["id"], project_id))}


def _auto_map_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    pieces = raw_pieces(project_id)
    design_canvas = build_design_canvas_config(pieces, payload)
    design_canvas = carry_existing_design_canvas(project_id, design_canvas)
    mappable_pieces = primary_pieces(pieces)
    mappings = auto_map_pieces(mappable_pieces, design_canvas, payload.get("garment_type", "unknown"))
    if payload.get("apply", True):
        apply_piece_mappings(project_id, mappable_pieces, mappings)
        update_project_design_canvas(project_id, design_canvas)
        pieces = raw_pieces(project_id)
    return {
        "design_canvas": design_canvas,
        "mappings": mappings,
        "pieces": [_piece_out_public(piece) for piece in pieces],
        "warnings": _mapping_warnings(mappings),
    }


def _fit_global_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture = get_texture_row(payload["texture_id"], project_id)
    pieces = raw_pieces(project_id)
    design_canvas = build_design_canvas_config(pieces, payload)
    design_canvas = carry_existing_design_canvas(project_id, design_canvas)
    for key in ("safe_zone_inset_x_ratio", "safe_zone_inset_y_ratio", "avoid_zone_seam_ratio", "avoid_zone_min_px"):
        if key in payload:
            design_canvas[key] = payload[key]
    design_path = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas.png"
    texture_source_path, texture_source, texture_warnings = resolve_texture_source(texture, payload.get("texture_source"))
    fit_analysis = texture_fit_analysis_for_fit(texture, texture_source_path)
    design_canvas["texture_repeat"] = fit_analysis["repeat_period"]
    design_canvas["texture_content"] = fit_analysis["content_centroid"]
    apply_content_alignment(design_canvas, fit_analysis["content_centroid"], texture_source)
    mappable_pieces = primary_pieces(pieces)
    mappings = auto_map_pieces(mappable_pieces, design_canvas, payload.get("garment_type", "unknown"))
    build_design_texture_canvas(texture_source_path, design_path, design_canvas, asset_paths(project_id))
    design_canvas_thumb_path = ""
    try:
        design_canvas_thumb_dst = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas_thumb.png"
        create_thumbnail(design_path, design_canvas_thumb_dst)
        design_canvas_thumb_path = rel_path(design_canvas_thumb_dst)
    except Exception:
        pass
    if payload.get("apply", True):
        apply_piece_mappings(project_id, mappable_pieces, mappings)
        pieces = raw_pieces(project_id)
        design_canvas["safety_report"] = build_safety_report(primary_pieces(pieces), design_canvas)
        update_project_design_canvas(project_id, design_canvas)
        with connect() as con:
            con.execute(
                """
                update textures
                set design_canvas_path = ?, design_canvas_thumb_path = ?, fit_source = ?, width = ?, height = ?, version = version + 1
                where id = ? and project_id = ?
                """,
                (rel_path(design_path), design_canvas_thumb_path, texture_source, design_canvas["width"], design_canvas["height"], texture["id"], project_id),
            )
        texture = get_texture_row(texture["id"], project_id)
    preview = project_dir(project_id) / "exports" / f"{job_id}_global_fit_preview.png"
    build_fit_preview(pieces, design_path, preview, canvas_size_from_pieces(pieces))
    return {
        "texture": _texture_out(texture),
        "design_canvas": design_canvas,
        "design_canvas_path": rel_path(design_path),
        "design_canvas_url": file_url(rel_path(design_path)),
        "fit_preview_path": rel_path(preview),
        "fit_preview_url": file_url(rel_path(preview)),
        "mappings": mappings,
        "pieces": [_piece_out_public(piece) for piece in pieces],
        "warnings": _mapping_warnings(mappings) + texture_warnings,
    }


def _render_design_canvas_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture = get_texture_row(payload["texture_id"], project_id)
    project = get_project_dict(project_id)
    design_canvas = dict((project.get("export_config") or {}).get("design_canvas") or {})
    if not design_canvas:
        pieces = raw_pieces(project_id)
        design_canvas = build_design_canvas_config(pieces, {})
    pieces = raw_pieces(project_id)
    design_canvas["safety_report"] = build_safety_report(primary_pieces(pieces), design_canvas)
    design_path = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas.png"
    texture_source_path, texture_source, _ = resolve_texture_source(texture, texture.get("fit_source"))
    build_design_texture_canvas(texture_source_path, design_path, design_canvas, asset_paths(project_id))
    update_project_design_canvas(project_id, design_canvas)
    design_canvas_thumb_path = ""
    try:
        design_canvas_thumb_dst = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas_thumb.png"
        create_thumbnail(design_path, design_canvas_thumb_dst)
        design_canvas_thumb_path = rel_path(design_canvas_thumb_dst)
    except Exception:
        pass
    with connect() as con:
        con.execute(
            """
            update textures
            set design_canvas_path = ?, design_canvas_thumb_path = ?, fit_source = ?, width = ?, height = ?, version = version + 1
            where id = ? and project_id = ?
            """,
            (
                rel_path(design_path),
                design_canvas_thumb_path,
                texture_source,
                int(design_canvas.get("width") or texture["width"]),
                int(design_canvas.get("height") or texture["height"]),
                texture["id"],
                project_id,
            ),
        )
    texture = get_texture_row(texture["id"], project_id)
    return {
        "texture": _texture_out(texture),
        "design_canvas": design_canvas,
        "design_canvas_path": rel_path(design_path),
        "design_canvas_url": file_url(rel_path(design_path)),
        "pieces": [_piece_out_public(piece) for piece in pieces],
        "safety_report": design_canvas.get("safety_report", []),
    }


def _preview_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture = choose_texture(project_id, payload.get("texture_id", ""))
    pieces = raw_pieces(project_id)
    canvas_size = canvas_size_from_pieces(pieces)
    out = project_dir(project_id) / "exports" / "preview.png"
    render_layout(pieces, texture_file(texture), out, canvas_size)
    return {"preview_path": rel_path(out), "preview_url": file_url(rel_path(out))}


def _export_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    texture = choose_texture(project_id, "")
    pieces = raw_pieces(project_id)
    project = get_project_dict(project_id)
    design_canvas = dict((project.get("export_config") or {}).get("design_canvas") or {})
    if design_canvas:
        design_canvas["safety_report"] = build_safety_report(primary_pieces(pieces), design_canvas)
        update_project_design_canvas(project_id, design_canvas)
    export_dir = project_dir(project_id) / "exports" / f"export_{uuid.uuid4().hex[:8]}"
    export_dir.mkdir(parents=True, exist_ok=True)
    single_files = []
    svg_files = []
    pieces_by_id = {str(piece["id"]): piece for piece in pieces}
    for piece in pieces:
        out = export_dir / f"{piece['id']}.png"
        render_piece_from_project_piece(piece, texture_file(texture), out, pieces_by_id)
        single_files.append(rel_path(out))
        svg_out = export_dir / f"{piece['id']}.svg"
        render_piece_svg(Path(piece["mask_path"]), svg_out)
        svg_files.append(rel_path(svg_out))
    layout_path = export_dir / "layout_preview.png"
    render_layout(
        pieces,
        texture_file(texture),
        layout_path,
        canvas_size_from_pieces(pieces),
        include_outline=bool(payload.get("include_outline", False)),
        include_labels=bool(payload.get("include_labels", False)),
    )
    manifest = {
        "project_id": project_id,
        "dpi": payload.get("dpi", DEFAULT_DPI),
        "texture_id": texture["id"],
        "design_canvas": design_canvas,
        "safety_report": design_canvas.get("safety_report", []) if design_canvas else [],
        "pieces": [
            {"id": p["id"], "bbox": p["bbox"], "source_x": p["source_x"], "source_y": p["source_y"], "transform": p["transform"]}
            for p in pieces
        ],
        "files": single_files + svg_files + [rel_path(layout_path)],
    }
    manifest_path = export_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    zip_path = export_dir.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in list(export_dir.glob("*")):
            zf.write(file, file.name)
    return {"export_path": rel_path(zip_path), "export_url": file_url(rel_path(zip_path)), "manifest": manifest}


def project_dir(project_id: str) -> Path:
    return PROJECTS_DIR / project_id


def ensure_project(project_id: str) -> None:
    with connect() as con:
        row = con.execute("select id from projects where id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")


def get_project_dict(project_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from projects where id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_out(row_to_dict(row))


def _project_out(data: dict) -> dict:
    data["export_config"] = loads(data["export_config"], {})
    return data


@app.patch("/api/projects/{project_id}/ui-state", response_model=ProjectOut)
def patch_project_ui_state(project_id: str, payload: ProjectUIStatePatch) -> dict:
    ensure_project(project_id)
    project = get_project_dict(project_id)
    export_config = dict(project.get("export_config") or {})
    export_config["ui_state"] = {
        "selected_set_id": payload.selected_set_id,
        "selected_piece_id": payload.selected_piece_id,
        "global_texture_scale": payload.global_texture_scale,
        "texture_angle": payload.texture_angle,
        "global_offset_x": payload.global_offset_x,
        "global_offset_y": payload.global_offset_y,
        "global_symmetry": payload.global_symmetry,
        "global_anchor": payload.global_anchor,
    }
    with connect() as con:
        con.execute(
            "update projects set export_config = ?, updated_at = ? where id = ?",
            (dumps(export_config), now_iso(), project_id),
        )
    return get_project_dict(project_id)


def update_project_design_canvas(project_id: str, design_canvas: dict) -> None:
    project = get_project_dict(project_id)
    export_config = dict(project.get("export_config") or {})
    export_config["design_canvas"] = design_canvas
    with connect() as con:
        con.execute(
            "update projects set export_config = ?, updated_at = ? where id = ?",
            (dumps(export_config), now_iso(), project_id),
        )


def merge_project_design_canvas(project_id: str, patch: dict) -> dict:
    project = get_project_dict(project_id)
    export_config = dict(project.get("export_config") or {})
    current = dict(export_config.get("design_canvas") or {})
    current.update(patch or {})
    if "layers" not in current:
        current["layers"] = []
    if "safety_report" not in current:
        current["safety_report"] = []
    export_config["design_canvas"] = current
    with connect() as con:
        con.execute(
            "update projects set export_config = ?, updated_at = ? where id = ?",
            (dumps(export_config), now_iso(), project_id),
        )
    return current


def carry_existing_design_canvas(project_id: str, design_canvas: dict) -> dict:
    project = get_project_dict(project_id)
    current = dict((project.get("export_config") or {}).get("design_canvas") or {})
    for key in ("safe_zone_inset_x_ratio", "safe_zone_inset_y_ratio", "avoid_zone_seam_ratio", "avoid_zone_min_px"):
        if key in current:
            design_canvas[key] = current[key]
    if current.get("layers") and not design_canvas.get("layers"):
        design_canvas["layers"] = current["layers"]
    if current.get("size_mapping"):
        design_canvas["size_mapping"] = current["size_mapping"]
    return design_canvas


def asset_paths(project_id: str) -> dict[str, Path]:
    with connect() as con:
        rows = con.execute("select id, path from assets where project_id = ?", (project_id,)).fetchall()
    return {row["id"]: storage_path(row["path"]) for row in rows}


def get_asset_row(asset_id: str, project_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from assets where id = ? and project_id = ?", (asset_id, project_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return row_to_dict(row)


def get_asset_dict(asset_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from assets where id = ?", (asset_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    data = row_to_dict(row)
    data["metadata"] = loads(data["metadata"], {})
    data["url"] = file_url(data["path"])
    data["thumb_url"] = file_url(data["thumb_path"]) if data.get("thumb_path") else data["url"]
    return data


def get_piece_dict(piece_id: str, project_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from pieces where id = ? and project_id = ?", (piece_id, project_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Piece not found")
    return _piece_out(row_to_dict(row))


def _piece_out(data: dict) -> dict:
    data["polygon"] = loads(data["polygon"], [])
    data["bbox"] = loads(data["bbox"], {})
    data["transform"] = loads(data["transform"], {})
    data["mask_url"] = file_url(data["mask_path"])
    return data


def get_texture_row(texture_id: str, project_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from textures where id = ? and project_id = ?", (texture_id, project_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Texture not found")
    return row_to_dict(row)


def _texture_out(data: dict) -> dict:
    data["source_url"] = file_url(data["source_path"]) if data["source_path"] else ""
    data["source_thumb_url"] = file_url(data["source_thumb_path"]) if data.get("source_thumb_path") else data["source_url"]
    data["seamless_url"] = file_url(data["seamless_path"]) if data["seamless_path"] else ""
    data["seamless_thumb_url"] = file_url(data["seamless_thumb_path"]) if data.get("seamless_thumb_path") else data["seamless_url"]
    data["design_canvas_url"] = file_url(data["design_canvas_path"]) if data.get("design_canvas_path") else ""
    data["design_canvas_thumb_url"] = file_url(data["design_canvas_thumb_path"]) if data.get("design_canvas_thumb_path") else data["design_canvas_url"]
    data["analysis"] = loads(data.get("analysis"), {})
    return data


def _job_project(job_id: str) -> str:
    with connect() as con:
        row = con.execute("select project_id from jobs where id = ?", (job_id,)).fetchone()
    if not row:
        raise RuntimeError("Job not found")
    return row["project_id"]


def raw_pieces(project_id: str) -> list[dict]:
    with connect() as con:
        rows = con.execute("select * from pieces where project_id = ? order by area desc", (project_id,)).fetchall()
    pieces = []
    for row in rows:
        data = row_to_dict(row)
        data["bbox"] = loads(data["bbox"], {})
        data["polygon"] = loads(data["polygon"], [])
        data["transform"] = loads(data["transform"], {})
        data["mask_path"] = storage_path(data["mask_path"])
        pieces.append(data)
    if not pieces:
        raise RuntimeError("No pieces imported")
    return pieces


def primary_pieces(pieces: list[dict]) -> list[dict]:
    return [piece for piece in pieces if not piece.get("mirror_of")]


def apply_piece_mappings(project_id: str, pieces: list[dict], mappings: list[dict]) -> None:
    by_id = {mapping["id"]: mapping for mapping in mappings}
    with connect() as con:
        for piece in pieces:
            mapping = by_id.get(piece["id"])
            if not mapping:
                continue
            transform = merge_mapping_into_transform(piece.get("transform", {}), mapping)
            con.execute(
                "update pieces set transform = ?, updated_at = ? where id = ? and project_id = ?",
                (dumps(transform), now_iso(), piece["id"], project_id),
            )


def _piece_out_public(piece: dict) -> dict:
    data = dict(piece)
    data["mask_path"] = rel_path(data["mask_path"]) if isinstance(data.get("mask_path"), Path) else data.get("mask_path", "")
    data["mask_url"] = file_url(data["mask_path"])
    return data


def _mapping_warnings(mappings: list[dict]) -> list[str]:
    warnings = []
    for mapping in mappings:
        if mapping.get("piece_role") == "unknown":
            warnings.append(f"{mapping['id']} 未能可靠识别裁片部位。")
        elif float(mapping.get("fit_confidence", 0) or 0) < 0.65:
            warnings.append(f"{mapping['id']} 自动映射置信度偏低。")
    return warnings


def choose_texture(project_id: str, texture_id: str) -> dict:
    with connect() as con:
        if texture_id:
            row = con.execute("select * from textures where id = ? and project_id = ?", (texture_id, project_id)).fetchone()
        else:
            row = con.execute("select * from textures where project_id = ? order by created_at desc limit 1", (project_id,)).fetchone()
    if not row:
        return create_default_texture(project_id)
    return row_to_dict(row)


def create_default_texture(project_id: str) -> dict:
    texture_id = f"tex_{uuid.uuid4().hex[:10]}"
    textures_dir = project_dir(project_id) / "textures"
    textures_dir.mkdir(parents=True, exist_ok=True)
    dst = textures_dir / f"{texture_id}_default.png"
    provider = get_provider("local")
    width, height = provider.generate_texture(
        "默认打样面料。请上传图案或生成 AI 面料后替换。",
        dst,
        2048,
        2048,
        "",
    )
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into textures(id, project_id, source_type, source_path, prompt, provider, model, seed, width, height, created_at)
            values (?, ?, 'library', ?, ?, 'local', 'default-preview', '', ?, ?, ?)
            """,
            (
                texture_id,
                project_id,
                rel_path(dst),
                "默认打样面料。请上传图案或生成 AI 面料后替换。",
                width,
                height,
                created,
            ),
        )
    return get_texture_row(texture_id, project_id)


def texture_file(texture: dict) -> Path:
    return storage_path(texture.get("design_canvas_path") or texture.get("seamless_path") or texture["source_path"])


def texture_fit_analysis_for_fit(texture: dict, texture_source_path: Path) -> dict:
    analysis = loads(texture.get("analysis"), {})
    repeat = analysis.get("repeat_period")
    content = analysis.get("content_centroid")
    changed = False

    if not isinstance(repeat, dict) or "has_repeat" not in repeat:
        repeat = detect_repeat_period(texture_source_path)
        analysis["repeat_period"] = repeat
        changed = True
    if not isinstance(content, dict) or "has_content" not in content:
        content = detect_content_centroid(texture_source_path)
        analysis["content_centroid"] = content
        changed = True

    if changed:
        texture["analysis"] = dumps(analysis)
        with connect() as con:
            con.execute(
                "update textures set analysis = ?, version = version + 1 where id = ? and project_id = ?",
                (dumps(analysis), texture["id"], texture["project_id"]),
            )
    return {"repeat_period": repeat, "content_centroid": content}


def apply_content_alignment(design_canvas: dict, content: dict, texture_source: str) -> None:
    alignment = {
        "enabled": False,
        "anchor": str(design_canvas.get("anchor") or "front_center"),
        "offset_x": float(design_canvas.get("texture_offset_x", 0) or 0),
        "offset_y": float(design_canvas.get("texture_offset_y", 0) or 0),
        "note": "未检测到可用于定位的主体内容。",
    }
    if texture_source != "source":
        alignment["note"] = "当前使用无缝图，主体重心定位未启用。"
        design_canvas["content_alignment"] = alignment
        return
    if not content.get("has_content"):
        design_canvas["content_alignment"] = alignment
        return
    angle = float(design_canvas.get("global_texture_angle", 0) or 0) % 360
    if min(angle, 360 - angle) > 0.01:
        alignment["note"] = "面料存在旋转，主体重心定位未启用。"
        design_canvas["content_alignment"] = alignment
        return

    anchors = design_canvas.get("design_anchors") or {}
    anchor_name = alignment["anchor"]
    target = anchors.get(anchor_name) or {"x": float(design_canvas.get("width", 0) or 0) / 2, "y": float(design_canvas.get("height", 0) or 0) / 2}
    centroid = content.get("centroid") or {}
    scale = max(0.05, float(design_canvas.get("texture_scale", 1) or 1))
    user_offset_x = float(design_canvas.get("texture_offset_x", 0) or 0)
    user_offset_y = float(design_canvas.get("texture_offset_y", 0) or 0)
    offset_x = float(target.get("x", 0) or 0) - float(centroid.get("x", 0) or 0) * scale + user_offset_x
    offset_y = float(target.get("y", 0) or 0) - float(centroid.get("y", 0) or 0) * scale + user_offset_y

    design_canvas["texture_offset_x"] = round(offset_x, 2)
    design_canvas["texture_offset_y"] = round(offset_y, 2)
    design_canvas["content_alignment"] = {
        "enabled": True,
        "anchor": anchor_name,
        "offset_x": round(offset_x, 2),
        "offset_y": round(offset_y, 2),
        "note": "已按主体重心对齐主视觉锚点。",
    }


def resolve_texture_source(texture: dict, requested_source: str | None) -> tuple[Path, str, list[str]]:
    source = requested_source or texture.get("fit_source") or texture.get("fit_source_recommendation") or "source"
    warnings: list[str] = []
    if source == "seamless":
        seamless_path = texture.get("seamless_path") or ""
        if seamless_path:
            return storage_path(seamless_path), "seamless", warnings
        warnings.append("请求使用无缝图，但当前面料还没有无缝图，已回退为原图。")
    return storage_path(texture["source_path"]), "source", warnings


def canvas_size_from_pieces(pieces: list[dict]) -> tuple[int, int]:
    max_x = max(piece["source_x"] + piece["width"] for piece in pieces)
    max_y = max(piece["source_y"] + piece["height"] for piece in pieces)
    return max_x, max_y


def safe_image_size(path: Path) -> tuple[int, int]:
    try:
        return image_size(path)
    except Exception:
        return 0, 0


def ensure_job_dimensions(width: int, height: int) -> None:
    try:
        ensure_dimensions_within_limit(width, height)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc


def file_url(relative: str) -> str:
    return f"/files/{relative}"
