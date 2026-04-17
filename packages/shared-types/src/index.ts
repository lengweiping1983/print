export type Project = {
  id: string;
  name: string;
  size_name: string;
  template_set_id?: string;
  dpi: number;
  unit: string;
  canvas_width: number;
  canvas_height: number;
  export_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Asset = {
  id: string;
  project_id: string;
  kind: string;
  filename: string;
  path: string;
  url: string;
  thumb_url?: string;
  width: number;
  height: number;
  sha256: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type PieceTransform = {
  offset_x: number;
  offset_y: number;
  scale: number;
  rotation: number;
  mirror_x: boolean;
  mirror_y: boolean;
  texture_id: string;
  locked: boolean;
  mode?: "local" | "global_canvas";
  design_x?: number;
  design_y?: number;
  design_width?: number;
  design_height?: number;
  design_rotation?: number;
  grainline_angle?: number;
  piece_role?: string;
  role_confirmed?: boolean;
  position_confirmed?: boolean;
  global_enabled?: boolean;
  pair_id?: string;
  pair_side?: "left" | "right" | "none" | "";
  safe_zones?: DesignRect[];
  avoid_zones?: DesignRect[];
  fit_confidence?: number;
  fit_note?: string;
  // 模板套装级关联配置（存储在 set_piece_defs.base_transform 中）
  linked_def_id?: string;
  link_mirror_x?: boolean;
  link_mirror_y?: boolean;
};

export type DesignRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesignLayer = {
  id: string;
  type: "image" | "text";
  name: string;
  visible: boolean;
  locked: boolean;
  anchor: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  target_piece_ids: string[];
  asset_id?: string;
  source_url?: string;
  thumb_url?: string;
  content?: string;
  font_size?: number;
  font_weight?: string;
  fill?: string;
  stroke?: string;
  stroke_width?: number;
};

export type SafetyReportItem = {
  layer_id: string;
  layer_name: string;
  level: "ok" | "warning";
  message: string;
  piece_id?: string;
  piece_role?: string;
};

export type TextureRepeat = {
  has_repeat: boolean;
  period_x: number;
  period_y: number;
  confidence_x: number;
  confidence_y: number;
  method: string;
};

export type ContentCentroid = {
  has_content: boolean;
  centroid: { x: number; y: number };
  centroid_unit: "px";
  content_bbox: DesignRect;
  opaque_ratio: number;
  confidence: number;
  method: string;
};

export type ContentAlignment = {
  enabled: boolean;
  anchor: string;
  offset_x: number;
  offset_y: number;
  note: string;
};

export type DesignCanvas = {
  width: number;
  height: number;
  unit: string;
  base_size: string;
  global_texture_angle: number;
  texture_scale: number;
  texture_offset_x: number;
  texture_offset_y: number;
  tile: boolean;
  mirror: boolean;
  symmetry: "continuous" | "mirror";
  anchor: string;
  design_anchors: Record<string, { x: number; y: number }>;
  layers: DesignLayer[];
  safety_report: SafetyReportItem[];
  size_mapping: Record<string, unknown>;
  texture_repeat?: TextureRepeat;
  texture_content?: ContentCentroid;
  content_alignment?: ContentAlignment;
  safe_zone_inset_x_ratio?: number;
  safe_zone_inset_y_ratio?: number;
  avoid_zone_seam_ratio?: number;
  avoid_zone_min_px?: number;
};

export type GlobalFitOptions = {
  garment_type: "unknown" | "t_shirt" | "shirt";
  strategy?: string;
  apply?: boolean;
  canvas_width?: number;
  canvas_height?: number;
  texture_scale: number;
  texture_angle: number;
  texture_offset_x: number;
  texture_offset_y: number;
  tile: boolean;
  mirror: boolean;
  anchor: string;
  symmetry: "continuous" | "mirror";
  texture_source: "source" | "seamless";
  safe_zone_inset_x_ratio?: number;
  safe_zone_inset_y_ratio?: number;
  avoid_zone_seam_ratio?: number;
  avoid_zone_min_px?: number;
};

export type Piece = {
  id: string;
  project_id: string;
  name: string;
  mask_path: string;
  mask_url: string;
  polygon: number[][];
  bbox: { x: number; y: number; width: number; height: number };
  source_x: number;
  source_y: number;
  width: number;
  height: number;
  area: number;
  centroid_x: number;
  centroid_y: number;
  group_name: string;
  mirror_of: string;
  transform: PieceTransform;
  created_at: string;
  updated_at: string;
};

export type Texture = {
  id: string;
  project_id: string;
  source_type: string;
  source_path: string;
  source_url: string;
  source_thumb_url?: string;
  seamless_path: string;
  seamless_url: string;
  seamless_thumb_url?: string;
  design_canvas_path: string;
  design_canvas_url: string;
  design_canvas_thumb_url?: string;
  fit_source_recommendation: "source" | "seamless";
  fit_source: "source" | "seamless";
  seamless_mode: string;
  analysis: Record<string, unknown>;
  prompt: string;
  provider: string;
  model: string;
  seed: string;
  version: number;
  width: number;
  height: number;
  created_at: string;
};

export type Job = {
  id: string;
  project_id: string;
  job_type: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  error: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type TemplateSet = {
  id: string;
  name: string;
  garment_type: "unknown" | "t_shirt" | "shirt";
  version_label: string;
  description: string;
  base_size_template_id: string;
  design_canvas: Record<string, unknown>;
  has_mapping_issues: boolean;
  mapping_confirmed_at: string;
  mapping_issue_details?: Record<string, string[]>;
  created_at: string;
  updated_at: string;
};

export type SetPieceDef = {
  id: string;
  set_id: string;
  piece_role: string;
  name: string;
  sort_order: number;
  base_transform: PieceTransform;
  created_at: string;
  updated_at: string;
};

export type SizeTemplate = {
  id: string;
  set_id: string;
  size_name: string;
  asset_id: string;
  template_source: string;
  template_path: string;
  template_url: string;
  red_marker_path: string;
  red_marker_url: string;
  red_marker_count: number;
  width: number;
  height: number;
  pieces_count: number;
  is_base: boolean;
  created_at: string;
  updated_at: string;
};

export type SizeTemplatePiece = {
  id: string;
  size_template_id: string;
  piece_def_id: string;
  name: string;
  piece_role: string;
  mask_path: string;
  mask_url: string;
  polygon: number[][];
  bbox: { x: number; y: number; width: number; height: number };
  source_x: number;
  source_y: number;
  width: number;
  height: number;
  area: number;
  centroid_x: number;
  centroid_y: number;
  scale_to_base: number;
  transform: PieceTransform;
  created_at: string;
  updated_at: string;
};

export type FabricPrompt = {
  id: string;
  code: string;
  name: string;
  scenarios: string;
  prompt: string;
  category: string;
  sort_order: number;
};
