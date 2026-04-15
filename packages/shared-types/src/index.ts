export type Project = {
  id: string;
  name: string;
  size_name: string;
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
  seamless_path: string;
  seamless_url: string;
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

