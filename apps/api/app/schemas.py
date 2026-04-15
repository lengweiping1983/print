from typing import Any, Literal

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = "新建裁片项目"
    size_name: str = ""
    dpi: int = 300
    unit: str = "px"
    canvas_width: int = 0
    canvas_height: int = 0
    export_config: dict[str, Any] = Field(default_factory=dict)


class ProjectOut(ProjectCreate):
    id: str
    created_at: str
    updated_at: str


class AssetOut(BaseModel):
    id: str
    project_id: str
    kind: str
    filename: str
    path: str
    url: str
    width: int
    height: int
    sha256: str
    metadata: dict[str, Any]
    created_at: str


class PieceTransform(BaseModel):
    offset_x: float = 0
    offset_y: float = 0
    scale: float = 1
    rotation: float = 0
    mirror_x: bool = False
    mirror_y: bool = False
    texture_id: str = ""
    locked: bool = False


class PieceOut(BaseModel):
    id: str
    project_id: str
    name: str
    mask_path: str
    mask_url: str
    polygon: list[list[int]]
    bbox: dict[str, int]
    source_x: int
    source_y: int
    width: int
    height: int
    area: int
    centroid_x: float
    centroid_y: float
    group_name: str
    mirror_of: str
    transform: PieceTransform
    created_at: str
    updated_at: str


class TextureGenerateRequest(BaseModel):
    source_asset_id: str = ""
    source_type: Literal["pattern", "garment_photo", "ai", "library"] = "pattern"
    prompt: str = ""
    provider: str = "local"
    model: str = "local"
    seed: str = ""
    tile_width: int = 4096
    tile_height: int = 4096


class SeamlessRequest(BaseModel):
    mode: Literal["mirror", "offset"] = "mirror"
    width: int = 4096
    height: int = 4096


class TextureOut(BaseModel):
    id: str
    project_id: str
    source_type: str
    source_path: str
    source_url: str
    seamless_path: str
    seamless_url: str
    prompt: str
    provider: str
    model: str
    seed: str
    version: int
    width: int
    height: int
    created_at: str


class JobOut(BaseModel):
    id: str
    project_id: str
    job_type: str
    status: Literal["queued", "running", "succeeded", "failed"]
    progress: float
    error: str
    input: dict[str, Any]
    output: dict[str, Any]
    created_at: str
    updated_at: str


class ExportRequest(BaseModel):
    format: Literal["png", "pdf", "svg", "zip"] = "zip"
    dpi: int = 300
    transparent: bool = True
    include_outline: bool = False
    include_labels: bool = False
