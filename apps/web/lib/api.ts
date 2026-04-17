import type { Asset, DesignCanvas, FabricPrompt, GlobalFitOptions, Job, Piece, PieceTransform, Project, SetPieceDef, SizeTemplate, SizeTemplatePiece, TemplateSet, Texture } from "@print-studio/shared-types";

const jsonHeaders = { "Content-Type": "application/json" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  createProject(name = "服装裁片项目", size_name = "") {
    return request<Project>("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name, size_name, dpi: 300, unit: "px" })
    });
  },
  listProjects() {
    return request<Project[]>("/api/projects");
  },
  getProject(projectId: string) {
    return request<Project>(`/api/projects/${projectId}`);
  },
  patchProjectUIState(projectId: string, payload: {
    selected_set_id: string;
    selected_piece_id: string;
    global_texture_scale: number;
    texture_angle: number;
    global_offset_x: number;
    global_offset_y: number;
    global_symmetry: string;
    global_anchor: string;
  }) {
    return request<Project>(`/api/projects/${projectId}/ui-state`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(payload),
    });
  },
  uploadAsset(projectId: string, kind: string, file: File) {
    const form = new FormData();
    form.set("kind", kind);
    form.set("file", file);
    return request<Asset>(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
  },
  importTemplate(projectId: string, assetId: string) {
    const form = new FormData();
    form.set("asset_id", assetId);
    return request<{ job_id: string }>(`/api/projects/${projectId}/templates/import`, { method: "POST", body: form });
  },
  listPieces(projectId: string) {
    return request<Piece[]>(`/api/projects/${projectId}/pieces`);
  },
  updatePiece(projectId: string, pieceId: string, transform: PieceTransform) {
    return request<Piece>(`/api/projects/${projectId}/pieces/${pieceId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(transform)
    });
  },
  updateDesignCanvas(projectId: string, designCanvas: Partial<DesignCanvas>) {
    return request<{ design_canvas: DesignCanvas }>(`/api/projects/${projectId}/design-canvas`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ design_canvas: designCanvas })
    });
  },
  generateTexture(projectId: string, sourceAssetId: string, sourceType: "pattern" | "garment_photo" | "ai" | "library", prompt: string) {
    return request<{ job_id: string }>(`/api/projects/${projectId}/textures/generate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        source_asset_id: sourceAssetId,
        source_type: sourceType,
        prompt,
        provider: sourceAssetId ? "local" : "openai",
        model: sourceAssetId ? "local-copy" : "image-provider-adapter"
      })
    });
  },
  createSeamless(projectId: string, textureId: string, mode: "mirror" | "offset") {
    return request<{ job_id: string }>(`/api/projects/${projectId}/textures/${textureId}/seamless`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ mode, width: 4096, height: 4096 })
    });
  },
  autoMapLayout(projectId: string, garmentType: "unknown" | "t_shirt" | "shirt") {
    return request<{ job_id: string }>(`/api/projects/${projectId}/layout/auto-map`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ garment_type: garmentType, strategy: "heuristic_v1", apply: true })
    });
  },
  fitGlobalTexture(projectId: string, textureId: string, options: GlobalFitOptions) {
    return request<{ job_id: string }>(`/api/projects/${projectId}/textures/${textureId}/fit-global`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ ...options, strategy: "continuous_unified_v1", apply: true })
    });
  },
  renderDesignCanvas(projectId: string, textureId: string) {
    return request<{ job_id: string }>(`/api/projects/${projectId}/textures/${textureId}/design-canvas/render`, {
      method: "POST"
    });
  },
  listTextures(projectId: string) {
    return request<Texture[]>(`/api/projects/${projectId}/textures`);
  },
  deleteTexture(projectId: string, textureId: string) {
    return request<{ deleted: string }>(`/api/projects/${projectId}/textures/${textureId}`, { method: "DELETE" });
  },
  renderPreview(projectId: string, textureId = "") {
    const form = new FormData();
    form.set("texture_id", textureId);
    return request<{ job_id: string }>(`/api/projects/${projectId}/render/preview`, { method: "POST", body: form });
  },
  exportProject(projectId: string) {
    return request<{ job_id: string }>(`/api/projects/${projectId}/exports`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ format: "zip", dpi: 300, transparent: true, include_outline: false, include_labels: false })
    });
  },
  getJob(jobId: string, signal?: AbortSignal) {
    return request<Job>(`/api/jobs/${jobId}`, { signal });
  },

  // Template Sets
  createTemplateSet(name: string, garmentType: "unknown" | "t_shirt" | "shirt" = "unknown", versionLabel = "") {
    return request<TemplateSet>("/api/template-sets", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name, garment_type: garmentType, version_label: versionLabel }),
    });
  },
  listTemplateSets() {
    return request<TemplateSet[]>("/api/template-sets");
  },
  getTemplateSet(setId: string) {
    return request<TemplateSet>(`/api/template-sets/${setId}`);
  },
  patchTemplateSet(setId: string, patch: Partial<TemplateSet>) {
    return request<TemplateSet>(`/api/template-sets/${setId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(patch),
    });
  },
  uploadTemplateSetAsset(setId: string, file: File) {
    const form = new FormData();
    form.set("file", file);
    return request<Asset>(`/api/template-sets/${setId}/assets`, { method: "POST", body: form });
  },
  importTemplateSetSize(setId: string, assetId: string, sizeName: string) {
    const form = new FormData();
    form.set("asset_id", assetId);
    form.set("size_name", sizeName);
    return request<{ size_template: SizeTemplate; pieces: SizeTemplatePiece[]; warnings: string[] }>(
      `/api/template-sets/${setId}/sizes/import`,
      { method: "POST", body: form }
    );
  },
  listTemplateSetSizes(setId: string) {
    return request<SizeTemplate[]>(`/api/template-sets/${setId}/sizes`);
  },
  listTemplateSetPieceDefs(setId: string) {
    return request<SetPieceDef[]>(`/api/template-sets/${setId}/piece-defs`);
  },
  patchTemplateSetPieceDef(setId: string, defId: string, patch: Partial<SetPieceDef>) {
    return request<SetPieceDef>(`/api/template-sets/${setId}/piece-defs/${defId}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(patch),
    });
  },
  deleteTemplateSetPieceDef(setId: string, defId: string) {
    return request<{ deleted: string }>(`/api/template-sets/${setId}/piece-defs/${defId}`, {
      method: "DELETE",
    });
  },
  listTemplateSizePieces(setId: string, sizeId: string) {
    return request<SizeTemplatePiece[]>(`/api/template-sets/${setId}/sizes/${sizeId}/pieces?t=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache" },
    });
  },
  patchTemplateSizePiece(setId: string, sizeId: string, pieceId: string, patch: { piece_def_id: string }) {
    return request<SizeTemplatePiece>(`/api/template-sets/${setId}/sizes/${sizeId}/pieces/${pieceId}`, {
      method: "PATCH",
      headers: { ...jsonHeaders, "Cache-Control": "no-cache" },
      body: JSON.stringify(patch),
    });
  },
  deleteTemplateSizePiece(setId: string, sizeId: string, pieceId: string) {
    return request<{ deleted: string }>(`/api/template-sets/${setId}/sizes/${sizeId}/pieces/${pieceId}`, {
      method: "DELETE",
    });
  },
  deleteTemplateSetSize(setId: string, sizeId: string) {
    return request<{ deleted: string }>(`/api/template-sets/${setId}/sizes/${sizeId}`, { method: "DELETE" });
  },
  deleteTemplateSet(setId: string) {
    return request<{ deleted: string }>(`/api/template-sets/${setId}`, { method: "DELETE" });
  },
  setTemplateSetBaseSize(setId: string, sizeTemplateId: string) {
    const form = new FormData();
    form.set("size_template_id", sizeTemplateId);
    return request<TemplateSet>(`/api/template-sets/${setId}/base-size`, { method: "POST", body: form });
  },
  confirmTemplateSetMapping(setId: string) {
    return request<TemplateSet>(`/api/template-sets/${setId}/confirm-mapping`, { method: "POST" });
  },
  createProjectFromTemplateSet(setId: string, sizeName: string, copyDesignFromBase = true) {
    return request<Project>("/api/projects/from-template-set", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ set_id: setId, size_name: sizeName, copy_design_from_base: copyDesignFromBase }),
    });
  },
  listFabricPrompts(category?: string) {
    const query = category ? `?category=${encodeURIComponent(category)}` : "";
    return request<FabricPrompt[]>(`/api/fabric-prompts${query}`);
  },
};

export async function waitForJob(
  jobId: string,
  onTick?: (job: Job) => void,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}
): Promise<Job> {
  const intervalMs = options.intervalMs ?? 650;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const startedAt = Date.now();
  for (;;) {
    if (options.signal?.aborted) throw new Error("任务已取消。");
    if (Date.now() - startedAt > timeoutMs) throw new Error("任务等待超时，请稍后刷新任务状态或检查后端日志。");
    const job = await api.getJob(jobId, options.signal);
    onTick?.(job);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(job.error || "Job failed");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
