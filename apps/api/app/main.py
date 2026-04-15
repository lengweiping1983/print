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

from .config import DEFAULT_DPI, PROJECTS_DIR, STORAGE_DIR
from .db import connect, dumps, init_db, loads, now_iso, rel_path, row_to_dict, storage_path
from .design_ops import build_design_texture_canvas, build_fit_preview, build_safety_report
from .image_ops import (
    extract_alpha_components,
    has_transparent_alpha,
    image_size,
    make_layout_template,
    make_mirror_tile,
    make_offset_tile,
    make_red_marker_mask,
    render_layout,
    render_piece,
    render_piece_svg,
    write_piece_marker_masks,
)
from .jobs import create_job
from .layout_ops import auto_map_pieces, build_design_canvas_config, merge_mapping_into_transform
from .providers import get_provider
from .schemas import (
    AssetOut,
    AutoMapRequest,
    DesignCanvasPatch,
    ExportRequest,
    GlobalFitRequest,
    JobOut,
    PieceOut,
    PieceTransform,
    ProjectCreate,
    ProjectOut,
    SeamlessRequest,
    TextureGenerateRequest,
    TextureOut,
)
from .texture_analysis import analyze_texture_fit_source


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Print Studio API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STORAGE_DIR.mkdir(parents=True, exist_ok=True)


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
        rows = con.execute("select * from projects order by created_at desc").fetchall()
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
    asset_dir = project_dir(project_id) / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    dst = asset_dir / f"{asset_id}{suffix}"
    sha = hashlib.sha256()
    with dst.open("wb") as fh:
        while chunk := await file.read(1024 * 1024):
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
            (asset_id, project_id, kind, file.filename or dst.name, rel_path(dst), width, height, sha.hexdigest(), created),
        )
    return get_asset_dict(asset_id)


@app.post("/api/projects/{project_id}/templates/import")
def import_template(project_id: str, asset_id: str = Form(...)) -> dict:
    ensure_project(project_id)
    asset = get_asset_row(asset_id, project_id)
    ext = Path(asset["filename"]).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="请上传 PNG/WebP 透明裁片模板，或白底排版原图 JPG/PNG/WebP。")
    source_path = storage_path(asset["path"])
    template_source = "alpha" if has_transparent_alpha(source_path) else "layout_image"
    templates_dir = project_dir(project_id) / "templates"
    if template_source == "alpha":
        template_path = source_path
    else:
        template_path = templates_dir / f"{asset_id}_template.png"
        make_layout_template(source_path, template_path)
    red_marker_path = make_red_marker_mask(source_path, templates_dir / f"{asset_id}_red_markers.png")

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
    pieces = extract_alpha_components(template_path, pieces_dir)
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
    return {"pieces": list_pieces(project_id), "template_source": template_source, "template_path": rel_path(template_path)}


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
    job_id = create_job(project_id, "texture_generate", payload.model_dump(), _generate_texture_job)
    return {"job_id": job_id}


@app.post("/api/projects/{project_id}/textures/{texture_id}/seamless")
def create_seamless(project_id: str, texture_id: str, payload: SeamlessRequest) -> dict:
    ensure_project(project_id)
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
        dst = textures_dir / f"{texture_id}_source{src.suffix.lower() or '.png'}"
        shutil.copyfile(src, dst)
        source_path = rel_path(dst)
        width, height = safe_image_size(dst)
    else:
        width = int(payload.get("tile_width") or 2048)
        height = int(payload.get("tile_height") or 2048)
        dst = textures_dir / f"{texture_id}_source.png"
        provider = get_provider(payload.get("provider", "local"))
        provider.generate_texture(payload.get("prompt") or "服装布料纹理", dst, width, height, payload.get("seed", ""))
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
    if fit_source == "seamless":
        seamless_out = textures_dir / f"{texture_id}_seamless.png"
        make_mirror_tile(storage_path(source_path), seamless_out, int(payload.get("tile_width") or 4096), int(payload.get("tile_height") or 4096))
        seamless_path = rel_path(seamless_out)
        seamless_mode = "mirror"
        width, height = image_size(seamless_out)
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert into textures(
              id, project_id, source_type, source_path, seamless_path, fit_source_recommendation,
              fit_source, seamless_mode, analysis, prompt, provider, model, seed, width, height, created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                texture_id,
                project_id,
                source_type,
                source_path,
                seamless_path,
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
    out = project_dir(project_id) / "textures" / f"{texture['id']}_seamless.png"
    width = int(payload.get("width") or 4096)
    height = int(payload.get("height") or 4096)
    if payload.get("mode") == "offset":
        make_offset_tile(source, out, width, height)
    else:
        make_mirror_tile(source, out, width, height)
    with connect() as con:
        con.execute(
            """
            update textures
            set seamless_path = ?, fit_source = 'seamless', seamless_mode = ?, width = ?, height = ?, version = version + 1
            where id = ? and project_id = ?
            """,
            (rel_path(out), payload.get("mode") or "mirror", width, height, texture["id"], project_id),
        )
    return {"texture": _texture_out(get_texture_row(texture["id"], project_id))}


def _auto_map_job(job_id: str, payload: dict) -> dict:
    project_id = _job_project(job_id)
    pieces = raw_pieces(project_id)
    design_canvas = build_design_canvas_config(pieces, payload)
    design_canvas = carry_existing_design_canvas(project_id, design_canvas)
    mappings = auto_map_pieces(pieces, design_canvas, payload.get("garment_type", "unknown"))
    if payload.get("apply", True):
        apply_piece_mappings(project_id, pieces, mappings)
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
    mappings = auto_map_pieces(pieces, design_canvas, payload.get("garment_type", "unknown"))
    design_path = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas.png"
    texture_source_path, texture_source, texture_warnings = resolve_texture_source(texture, payload.get("texture_source"))
    build_design_texture_canvas(texture_source_path, design_path, design_canvas, asset_paths(project_id))
    if payload.get("apply", True):
        apply_piece_mappings(project_id, pieces, mappings)
        pieces = raw_pieces(project_id)
        design_canvas["safety_report"] = build_safety_report(pieces, design_canvas)
        update_project_design_canvas(project_id, design_canvas)
        with connect() as con:
            con.execute(
                """
                update textures
                set design_canvas_path = ?, fit_source = ?, width = ?, height = ?, version = version + 1
                where id = ? and project_id = ?
                """,
                (rel_path(design_path), texture_source, design_canvas["width"], design_canvas["height"], texture["id"], project_id),
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
    design_canvas["safety_report"] = build_safety_report(pieces, design_canvas)
    design_path = project_dir(project_id) / "textures" / f"{texture['id']}_design_canvas.png"
    texture_source_path, texture_source, _ = resolve_texture_source(texture, texture.get("fit_source"))
    build_design_texture_canvas(texture_source_path, design_path, design_canvas, asset_paths(project_id))
    update_project_design_canvas(project_id, design_canvas)
    with connect() as con:
        con.execute(
            """
            update textures
            set design_canvas_path = ?, fit_source = ?, width = ?, height = ?, version = version + 1
            where id = ? and project_id = ?
            """,
            (
                rel_path(design_path),
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
        design_canvas["safety_report"] = build_safety_report(pieces, design_canvas)
        update_project_design_canvas(project_id, design_canvas)
    export_dir = project_dir(project_id) / "exports" / f"export_{uuid.uuid4().hex[:8]}"
    export_dir.mkdir(parents=True, exist_ok=True)
    single_files = []
    svg_files = []
    for piece in pieces:
        out = export_dir / f"{piece['id']}.png"
        render_piece(Path(piece["mask_path"]), texture_file(texture), piece["transform"], out)
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
        if not project_id.startswith("prj_"):
            raise HTTPException(status_code=404, detail="Project not found")
        recover_project(project_id)


def recover_project(project_id: str) -> None:
    project_dir(project_id).mkdir(parents=True, exist_ok=True)
    created = now_iso()
    with connect() as con:
        con.execute(
            """
            insert or ignore into projects(id, name, size_name, dpi, unit, canvas_width, canvas_height, export_config, created_at, updated_at)
            values (?, '恢复的裁片项目', '', ?, 'px', 0, 0, '{}', ?, ?)
            """,
            (project_id, DEFAULT_DPI, created, created),
        )


def get_project_dict(project_id: str) -> dict:
    with connect() as con:
        row = con.execute("select * from projects where id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_out(row_to_dict(row))


def _project_out(data: dict) -> dict:
    data["export_config"] = loads(data["export_config"], {})
    return data


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
    data["seamless_url"] = file_url(data["seamless_path"]) if data["seamless_path"] else ""
    data["design_canvas_url"] = file_url(data["design_canvas_path"]) if data.get("design_canvas_path") else ""
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
        "默认打样纹理。请上传图案或生成 AI 纹理后替换。",
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
                "默认打样纹理。请上传图案或生成 AI 纹理后替换。",
                width,
                height,
                created,
            ),
        )
    return get_texture_row(texture_id, project_id)


def texture_file(texture: dict) -> Path:
    return storage_path(texture.get("design_canvas_path") or texture.get("seamless_path") or texture["source_path"])


def resolve_texture_source(texture: dict, requested_source: str | None) -> tuple[Path, str, list[str]]:
    source = requested_source or texture.get("fit_source") or texture.get("fit_source_recommendation") or "source"
    warnings: list[str] = []
    if source == "seamless":
        seamless_path = texture.get("seamless_path") or ""
        if seamless_path:
            return storage_path(seamless_path), "seamless", warnings
        warnings.append("请求使用无缝图，但当前纹理还没有无缝图，已回退为原图。")
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


def file_url(relative: str) -> str:
    return f"/files/{relative}"
