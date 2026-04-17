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
    template_set_id: str = ""
    created_at: str
    updated_at: str


class ProjectUIStatePatch(BaseModel):
    selected_piece_id: str = ""
    global_texture_scale: float = 1.0
    texture_angle: float = 0.0
    global_offset_x: float = 0.0
    global_offset_y: float = 0.0
    global_symmetry: str = "continuous"
    global_anchor: str = "front_center"


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
    mode: Literal["local", "global_canvas"] = "local"
    design_x: float = 0
    design_y: float = 0
    design_width: float = 0
    design_height: float = 0
    design_rotation: float = 0
    grainline_angle: float = 0
    piece_role: str = ""
    role_confirmed: bool = False
    position_confirmed: bool = False
    global_enabled: bool = True
    pair_id: str = ""
    pair_side: Literal["left", "right", "none", ""] = ""
    safe_zones: list[dict[str, float]] = Field(default_factory=list)
    avoid_zones: list[dict[str, float]] = Field(default_factory=list)
    fit_confidence: float = 0
    fit_note: str = ""


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


class AutoMapRequest(BaseModel):
    garment_type: Literal["unknown", "t_shirt", "shirt"] = "unknown"
    strategy: str = "heuristic_v1"
    apply: bool = True


class GlobalFitRequest(BaseModel):
    garment_type: Literal["unknown", "t_shirt", "shirt"] = "unknown"
    strategy: str = "continuous_unified_v1"
    apply: bool = True
    canvas_width: int = 0
    canvas_height: int = 0
    texture_scale: float = 1
    texture_angle: float = 0
    texture_offset_x: float = 0
    texture_offset_y: float = 0
    tile: bool = True
    mirror: bool = False
    anchor: str = "front_center"
    symmetry: Literal["continuous", "mirror"] = "continuous"
    texture_source: Literal["source", "seamless"] = "source"
    safe_zone_inset_x_ratio: float = 0.16
    safe_zone_inset_y_ratio: float = 0.14
    avoid_zone_seam_ratio: float = 0.06
    avoid_zone_min_px: float = 8


class DesignCanvasPatch(BaseModel):
    design_canvas: dict[str, Any] = Field(default_factory=dict)


class TextureOut(BaseModel):
    id: str
    project_id: str
    source_type: str
    source_path: str
    source_url: str
    seamless_path: str
    seamless_url: str
    design_canvas_path: str
    design_canvas_url: str
    fit_source_recommendation: Literal["source", "seamless"]
    fit_source: Literal["source", "seamless"]
    seamless_mode: str
    analysis: dict[str, Any]
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


class TemplateSetCreate(BaseModel):
    name: str
    garment_type: Literal["unknown", "t_shirt", "shirt"] = "unknown"
    version_label: str = ""
    description: str = ""


class TemplateSetOut(BaseModel):
    id: str
    name: str
    garment_type: str
    version_label: str
    description: str
    base_size_template_id: str
    design_canvas: dict[str, Any]
    has_mapping_issues: bool
    mapping_confirmed_at: str
    mapping_issue_details: dict[str, list[str]] = {}
    created_at: str
    updated_at: str


class SetPieceDefOut(BaseModel):
    id: str
    set_id: str
    piece_role: str
    name: str
    sort_order: int
    base_transform: dict[str, Any]
    created_at: str
    updated_at: str


class SetPieceDefPatch(BaseModel):
    piece_role: str = ""
    name: str = ""
    sort_order: int = -1
    base_transform: dict[str, Any] = Field(default_factory=dict)


class SizeTemplateOut(BaseModel):
    id: str
    set_id: str
    size_name: str
    asset_id: str
    template_source: str
    template_path: str
    template_url: str = ""
    red_marker_path: str
    red_marker_url: str = ""
    red_marker_count: int
    width: int
    height: int
    pieces_count: int
    is_base: bool
    created_at: str
    updated_at: str


class SizeTemplatePieceOut(BaseModel):
    id: str
    size_template_id: str
    piece_def_id: str
    name: str
    piece_role: str
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
    scale_to_base: float
    transform: dict[str, Any]
    created_at: str
    updated_at: str


class SizeTemplatePiecePatch(BaseModel):
    piece_def_id: str = ""


class ProjectFromTemplateRequest(BaseModel):
    set_id: str
    size_name: str
    copy_design_from_base: bool = True


class FabricPromptOut(BaseModel):
    id: str
    code: str
    name: str
    scenarios: str
    prompt: str
    category: str
    sort_order: int
