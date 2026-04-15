import type { Asset, Job, Piece, PieceTransform, Project, Texture } from "@print-studio/shared-types";

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
  createProject(name = "服装裁片项目") {
    return request<Project>("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name, dpi: 300, unit: "px" })
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
    return request<{ pieces: Piece[] }>(`/api/projects/${projectId}/templates/import`, { method: "POST", body: form });
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
  listTextures(projectId: string) {
    return request<Texture[]>(`/api/projects/${projectId}/textures`);
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
      body: JSON.stringify({ format: "zip", dpi: 300, transparent: true, include_outline: true, include_labels: true })
    });
  },
  getJob(jobId: string) {
    return request<Job>(`/api/jobs/${jobId}`);
  }
};

export async function waitForJob(jobId: string, onTick?: (job: Job) => void): Promise<Job> {
  for (;;) {
    const job = await api.getJob(jobId);
    onTick?.(job);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(job.error || "Job failed");
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
}

