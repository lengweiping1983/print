"use client";

import type { Asset, DesignCanvas, DesignLayer, GlobalFitOptions, Job, Piece, PieceTransform, Project, SizeTemplate, TemplateSet, Texture } from "@print-studio/shared-types";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { SetStateAction } from "react";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { api, waitForJob } from "@/lib/api";
import { PIECE_ROLE_LABELS, JOB_TYPE_LABELS, JOB_STATUS_LABELS } from "@/lib/labels";
import { FileField, LayoutPreviewLoading, LayerEditor, Panel, Range, SafetyReportList, SinglePieceLoading, ToastNotice } from "./StudioPageParts";

const SinglePieceCalibration = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.SinglePieceCalibration), {
  ssr: false,
  loading: () => <SinglePieceLoading />
});

const LayoutPreview = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.LayoutPreview), {
  ssr: false,
  loading: () => <LayoutPreviewLoading />
});

const LAST_PROJECT_KEY = "print-studio:last-project-id";

const emptyTransform: PieceTransform = {
  offset_x: 0,
  offset_y: 0,
  scale: 1,
  rotation: 0,
  mirror_x: false,
  mirror_y: false,
  texture_id: "",
  locked: false
};

type StudioState = {
  project: Project | null;
  assets: Asset[];
  pieces: Piece[];
  textures: Texture[];
  selectedPieceId: string;
  sourceType: "pattern" | "garment_photo" | "ai" | "library";
  prompt: string;
  job: Job | null;
  notice: string;
  templateFileName: string;
  textureFileName: string;
  textureViewMode: "source" | "seamless";
  showOutlines: boolean;
  outlineWidth: number;
  garmentType: "unknown" | "t_shirt" | "shirt";
  textureAngle: number;
  globalTextureScale: number;
  globalOffsetX: number;
  globalOffsetY: number;
  globalSymmetry: "continuous" | "mirror";
  globalAnchor: string;
  designCanvas: DesignCanvas | null;
  selectedLayerId: string;
  layersDirty: boolean;
  autoRenderingDesign: boolean;
  showTemplateDialog: boolean;
  templateSets: TemplateSet[];
  selectedSetId: string;
  selectedSetSizes: SizeTemplate[];
  copyDesignFromBase: boolean;
};

type StudioAction =
  | { type: "patch"; patch: Partial<StudioState> }
  | { type: "setField"; field: keyof StudioState; value: SetStateAction<StudioState[keyof StudioState]> };

const initialStudioState: StudioState = {
  project: null,
  assets: [],
  pieces: [],
  textures: [],
  selectedPieceId: "",
  sourceType: "pattern",
  prompt: "深蓝底色，花卉与飞鹤纹样，适合男士衬衫裁片打样",
  job: null,
  notice: "正在准备工作台...",
  templateFileName: "",
  textureFileName: "",
  textureViewMode: "source",
  showOutlines: true,
  outlineWidth: 5,
  garmentType: "unknown",
  textureAngle: 0,
  globalTextureScale: 1,
  globalOffsetX: 0,
  globalOffsetY: 0,
  globalSymmetry: "continuous",
  globalAnchor: "front_center",
  designCanvas: null,
  selectedLayerId: "",
  layersDirty: false,
  autoRenderingDesign: false,
  showTemplateDialog: false,
  templateSets: [],
  selectedSetId: "",
  selectedSetSizes: [],
  copyDesignFromBase: true
};

function studioReducer(state: StudioState, action: StudioAction): StudioState {
  if (action.type === "patch") return { ...state, ...action.patch };
  const current = state[action.field];
  const next = typeof action.value === "function" ? (action.value as (value: typeof current) => typeof current)(current) : action.value;
  return { ...state, [action.field]: next };
}

export function StudioPage() {
  const [state, dispatch] = useReducer(studioReducer, initialStudioState);
  const {
    project,
    assets,
    pieces,
    textures,
    selectedPieceId,
    sourceType,
    prompt,
    job,
    notice,
    templateFileName,
    textureFileName,
    textureViewMode,
    showOutlines,
    outlineWidth,
    garmentType,
    textureAngle,
    globalTextureScale,
    globalOffsetX,
    globalOffsetY,
    globalSymmetry,
    globalAnchor,
    designCanvas,
    selectedLayerId,
    layersDirty,
    autoRenderingDesign,
    showTemplateDialog,
    templateSets,
    selectedSetId,
    selectedSetSizes,
    copyDesignFromBase
  } = state;
  const setField = <K extends keyof StudioState>(field: K, value: SetStateAction<StudioState[K]>) => {
    dispatch({ type: "setField", field, value: value as SetStateAction<StudioState[keyof StudioState]> });
  };
  const setProject = (value: SetStateAction<Project | null>) => setField("project", value);
  const setAssets = (value: SetStateAction<Asset[]>) => setField("assets", value);
  const setPieces = (value: SetStateAction<Piece[]>) => setField("pieces", value);
  const setTextures = (value: SetStateAction<Texture[]>) => setField("textures", value);
  const setSelectedPieceId = (value: SetStateAction<string>) => setField("selectedPieceId", value);
  const setSourceType = (value: SetStateAction<StudioState["sourceType"]>) => setField("sourceType", value);
  const setPrompt = (value: SetStateAction<string>) => setField("prompt", value);
  const setJob = (value: SetStateAction<Job | null>) => setField("job", value);
  const setNotice = (value: SetStateAction<string>) => setField("notice", value);
  const setTemplateFileName = (value: SetStateAction<string>) => setField("templateFileName", value);
  const setTextureFileName = (value: SetStateAction<string>) => setField("textureFileName", value);
  const setTextureViewMode = (value: SetStateAction<StudioState["textureViewMode"]>) => setField("textureViewMode", value);
  const setShowOutlines = (value: SetStateAction<boolean>) => setField("showOutlines", value);
  const setOutlineWidth = (value: SetStateAction<number>) => setField("outlineWidth", value);
  const setGarmentType = (value: SetStateAction<StudioState["garmentType"]>) => setField("garmentType", value);
  const setTextureAngle = (value: SetStateAction<number>) => setField("textureAngle", value);
  const setGlobalTextureScale = (value: SetStateAction<number>) => setField("globalTextureScale", value);
  const setGlobalOffsetX = (value: SetStateAction<number>) => setField("globalOffsetX", value);
  const setGlobalOffsetY = (value: SetStateAction<number>) => setField("globalOffsetY", value);
  const setGlobalSymmetry = (value: SetStateAction<StudioState["globalSymmetry"]>) => setField("globalSymmetry", value);
  const setGlobalAnchor = (value: SetStateAction<string>) => setField("globalAnchor", value);
  const setDesignCanvas = (value: SetStateAction<DesignCanvas | null>) => setField("designCanvas", value);
  const setSelectedLayerId = (value: SetStateAction<string>) => setField("selectedLayerId", value);
  const setLayersDirty = (value: SetStateAction<boolean>) => setField("layersDirty", value);
  const setAutoRenderingDesign = (value: SetStateAction<boolean>) => setField("autoRenderingDesign", value);
  const setShowTemplateDialog = (value: SetStateAction<boolean>) => setField("showTemplateDialog", value);
  const setTemplateSets = (value: SetStateAction<TemplateSet[]>) => setField("templateSets", value);
  const setSelectedSetId = (value: SetStateAction<string>) => setField("selectedSetId", value);
  const setSelectedSetSizes = (value: SetStateAction<SizeTemplate[]>) => setField("selectedSetSizes", value);
  const setCopyDesignFromBase = (value: SetStateAction<boolean>) => setField("copyDesignFromBase", value);
  const prevJobRef = useRef<Job | null>(null);
  const layerRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        const restored = await loadInitialProject();
        if (!active) return;
        setProject(restored.project);
        setDesignCanvas(readDesignCanvas(restored.project));
        setPieces(restored.pieces);
        setTextures(restored.textures);
        setSelectedPieceId(restored.pieces[0]?.id ?? "");
        localStorage.setItem(LAST_PROJECT_KEY, restored.project.id);
        setNotice(restored.created ? "项目已创建，先上传透明 PNG/WebP 裁片模板或白底排版原图。" : "已恢复最近的裁片项目。");
      } catch (error) {
        if (active) setNotice(readError(error));
      }
    }
    void boot();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!job) {
      prevJobRef.current = null;
      return;
    }
    const prev = prevJobRef.current;
    if (prev && prev.id === job.id && prev.status === job.status && prev.progress === job.progress) {
      return;
    }
    prevJobRef.current = job;
    const typeLabel = (job.job_type && JOB_TYPE_LABELS[job.job_type]) || job.job_type || "任务";
    if (job.status === "running") {
      setNotice(`${typeLabel}进行中… ${Math.round(job.progress * 100)}%`);
    } else if (job.status === "queued") {
      setNotice(`${typeLabel}排队中…`);
    } else if (job.status === "succeeded") {
      setNotice(`${typeLabel}已完成`);
    } else if (job.status === "failed") {
      setNotice(`${typeLabel}失败`);
    }
  }, [job]);

  const selectedPiece = useMemo(
    () => pieces.find((piece) => piece.id === selectedPieceId) ?? pieces[0] ?? null,
    [pieces, selectedPieceId]
  );
  const assetSummary = useMemo(() => {
    const templateCount = assets.filter((asset) => asset.kind === "template").length;
    const patternCount = assets.filter((asset) => asset.kind === "pattern").length;
    const garmentPhotoCount = assets.filter((asset) => asset.kind === "garment_photo").length;
    return { templateCount, patternCount, garmentPhotoCount, total: assets.length };
  }, [assets]);
  const activeTexture = textures[0] ?? null;
  const hasSeamlessTexture = Boolean(activeTexture?.seamless_url);
  const selectedInputTextureUrl = activeTexture
    ? textureViewMode === "seamless" && activeTexture.seamless_url
      ? activeTexture.seamless_url
      : activeTexture.source_url
    : "";
  const workspaceTextureUrl = activeTexture?.design_canvas_url || selectedInputTextureUrl;
  const recommendationLabel = activeTexture?.fit_source_recommendation === "seamless" ? "使用无缝图适配" : "使用原图适配";
  const canUseLayers = Boolean(designCanvas && activeTexture?.design_canvas_url);
  const globalPieceCount = pieces.filter((piece) => piece.transform.mode === "global_canvas" && piece.transform.global_enabled !== false).length;
  const designLayers = designCanvas?.layers || [];
  const designLayerSignature = designLayers
    .map((layer) => `${layer.id}:${layer.x}:${layer.y}:${layer.width}:${layer.height}:${layer.rotation}:${layer.opacity}:${layer.visible}:${layer.locked}:${layer.content || ""}`)
    .join("|");
  const selectedLayer = designLayers.find((layer) => layer.id === selectedLayerId) || designLayers[0] || null;
  const safetyReport = designCanvas?.safety_report || [];

  useEffect(() => {
    if (!layersDirty || !project || !activeTexture || autoRenderingDesign) return;
    if (layerRenderTimerRef.current) clearTimeout(layerRenderTimerRef.current);
    layerRenderTimerRef.current = setTimeout(() => {
      void regenerateDesignCanvas({ silent: true });
    }, 800);
    return () => {
      if (layerRenderTimerRef.current) clearTimeout(layerRenderTimerRef.current);
    };
  }, [layersDirty, project?.id, activeTexture?.id, autoRenderingDesign, designLayerSignature]);

  async function upload(kind: string, file: File) {
    if (!project) return;
    setNotice(`上传 ${file.name}...`);
    const asset = await api.uploadAsset(project.id, kind, file);
    setAssets((current) => [asset, ...current]);
    setNotice(`${file.name} 已上传。`);
    return asset;
  }

  async function handleTemplate(file: File) {
    if (!project) return;
    try {
      setTemplateFileName(file.name);
      const asset = await upload("template", file);
      if (!asset) return;
      setNotice("正在创建模板解析任务...");
      const created = await api.importTemplate(project.id, asset.id);
      const done = await waitForJob(created.job_id, setJob);
      const imported = done.output as { pieces?: Piece[]; design_canvas?: DesignCanvas; warnings?: string[] };
      const importedPieces = imported.pieces ?? [];
      setPieces(importedPieces);
      setSelectedPieceId(importedPieces[0]?.id ?? "");
      if (imported.design_canvas) setDesignCanvas(imported.design_canvas);
      const warningText = imported.warnings?.length ? `，${imported.warnings.length} 个部位需要复核` : "";
      setNotice(`模板解析完成，已自动识别部位并建立全局映射，共 ${importedPieces.length} 个裁片${warningText}。`);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleTexture(file?: File) {
    if (!project) return;
    try {
      let assetId = "";
      if (file) {
        setTextureFileName(file.name);
        const asset = await upload(sourceType === "garment_photo" ? "garment_photo" : "pattern", file);
        assetId = asset?.id ?? "";
      }
      setNotice("正在生成纹理任务...");
      const created = await api.generateTexture(project.id, assetId, sourceType, prompt);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current]);
      setTextureViewMode(texture.fit_source || texture.fit_source_recommendation || "source");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleSeamless(mode: "mirror" | "offset") {
    if (!project || !activeTexture) return;
    try {
      setNotice("正在生成无缝大布料图...");
      const created = await api.createSeamless(project.id, activeTexture.id, mode);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current.filter((item) => item.id !== texture.id)]);
      setTextureViewMode("seamless");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleAutoMap() {
    if (!project) return;
    try {
      setNotice("正在识别裁片部位并建立全局设计坐标...");
      const created = await api.autoMapLayout(project.id, garmentType);
      const done = await waitForJob(created.job_id, setJob);
      setPieces((done.output.pieces as Piece[]) ?? (await api.listPieces(project.id)));
      if (done.output.design_canvas) setDesignCanvas(done.output.design_canvas as DesignCanvas);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleGlobalFit() {
    if (!project || !activeTexture) return;
    try {
      setNotice("正在生成全局一致纹理画布并裁切预览...");
      const options: GlobalFitOptions = {
        garment_type: garmentType,
        texture_scale: globalTextureScale,
        texture_angle: textureAngle,
        texture_offset_x: globalOffsetX,
        texture_offset_y: globalOffsetY,
        tile: true,
        mirror: globalSymmetry === "mirror",
        symmetry: globalSymmetry,
        anchor: globalAnchor,
        texture_source: textureViewMode
      };
      const created = await api.fitGlobalTexture(project.id, activeTexture.id, options);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current.filter((item) => item.id !== texture.id)]);
      setPieces((done.output.pieces as Piece[]) ?? (await api.listPieces(project.id)));
      if (done.output.design_canvas) setDesignCanvas(done.output.design_canvas as DesignCanvas);
      setTextureViewMode(texture.fit_source || textureViewMode);
      setLayersDirty(false);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function patchSelected(transform: Partial<PieceTransform>) {
    if (!selectedPiece) return;
    await patchPiece(selectedPiece.id, transform);
  }

  async function patchPiece(pieceId: string, transform: Partial<PieceTransform>) {
    if (!project) return;
    const piece = pieces.find((item) => item.id === pieceId);
    if (!piece) return;
    const next = { ...piece.transform, ...transform };
    const previous = pieces;
    setPieces((current) => current.map((item) => (item.id === piece.id ? { ...item, transform: next } : item)));
    try {
      const saved = await api.updatePiece(project.id, piece.id, next);
      setPieces((current) => current.map((piece) => (piece.id === saved.id ? saved : piece)));
    } catch (error) {
      setPieces(previous);
      setNotice(readError(error));
    }
  }

  async function saveDesignCanvas(next: DesignCanvas, dirty = true, rollbackSelectedLayerId = selectedLayerId) {
    if (!project) return;
    const previous = designCanvas;
    const previousDirty = layersDirty;
    setDesignCanvas(next);
    setLayersDirty(dirty);
    try {
      const saved = await api.updateDesignCanvas(project.id, next);
      setDesignCanvas(saved.design_canvas);
    } catch (error) {
      setDesignCanvas(previous);
      setLayersDirty(previousDirty);
      setSelectedLayerId(rollbackSelectedLayerId);
      setNotice(readError(error));
    }
  }

  async function addImageLayer() {
    if (!canUseLayers || !designCanvas) {
      setNotice("请先上传或生成纹理，并点击“自动适配纹理”生成全局设计画布后，再添加图层。");
      return;
    }
    const asset = assets.find((item) => item.kind === "pattern" || item.kind === "garment_photo");
    if (!asset) {
      setNotice("请先上传一张图案或衣服照片，再添加图片层。");
      return;
    }
    const layer = createLayer("image", designCanvas, asset);
    const next = { ...designCanvas, layers: [...designLayers, layer] };
    const previousSelectedLayerId = selectedLayerId;
    setSelectedLayerId(layer.id);
    await saveDesignCanvas(next, true, previousSelectedLayerId);
  }

  async function addTextLayer() {
    if (!canUseLayers || !designCanvas) {
      setNotice("请先上传或生成纹理，并点击“自动适配纹理”生成全局设计画布后，再添加图层。");
      return;
    }
    const layer = createLayer("text", designCanvas);
    const next = { ...designCanvas, layers: [...designLayers, layer] };
    const previousSelectedLayerId = selectedLayerId;
    setSelectedLayerId(layer.id);
    await saveDesignCanvas(next, true, previousSelectedLayerId);
  }

  async function patchLayer(layerId: string, update: Partial<DesignLayer>) {
    if (!designCanvas) return;
    const next = { ...designCanvas, layers: designLayers.map((layer) => (layer.id === layerId ? { ...layer, ...update } : layer)) };
    await saveDesignCanvas(next);
  }

  async function deleteLayer(layerId: string) {
    if (!designCanvas) return;
    const nextLayers = designLayers.filter((layer) => layer.id !== layerId);
    const next = { ...designCanvas, layers: nextLayers };
    const previousSelectedLayerId = selectedLayerId;
    setSelectedLayerId(nextLayers[0]?.id || "");
    await saveDesignCanvas(next, true, previousSelectedLayerId);
  }

  async function regenerateDesignCanvas(options: { silent?: boolean } = {}) {
    if (!project || !activeTexture) return;
    try {
      setAutoRenderingDesign(true);
      if (!options.silent) setNotice("正在更新预览和导出画布...");
      const created = await api.renderDesignCanvas(project.id, activeTexture.id);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current.filter((item) => item.id !== texture.id)]);
      setTextureViewMode("seamless");
      if (done.output.design_canvas) setDesignCanvas(done.output.design_canvas as DesignCanvas);
      setLayersDirty(false);
    } catch (error) {
      setNotice(readError(error));
    } finally {
      setAutoRenderingDesign(false);
    }
  }

  async function exportPack() {
    if (!project) return;
    try {
      if (layersDirty && activeTexture) {
        await regenerateDesignCanvas({ silent: true });
      }
      setNotice("正在导出打样包...");
      const created = await api.exportProject(project.id);
      const done = await waitForJob(created.job_id, setJob);
      const url = String(done.output.export_url || "");
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      await refreshTextures(project.id);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function refreshTextures(projectId: string) {
    const next = await api.listTextures(projectId);
    setTextures(next);
  }

  async function openTemplateDialog() {
    const sets = await api.listTemplateSets();
    setTemplateSets(sets);
    setShowTemplateDialog(true);
    if (sets[0]) {
      setSelectedSetId(sets[0].id);
      const sizes = await api.listTemplateSetSizes(sets[0].id);
      setSelectedSetSizes(sizes);
    }
  }

  async function onSelectTemplateSet(setId: string) {
    setSelectedSetId(setId);
    const sizes = await api.listTemplateSetSizes(setId);
    setSelectedSetSizes(sizes);
  }

  async function createFromTemplateSet() {
    const size = selectedSetSizes.find((s) => s.size_name);
    if (!selectedSetId || !size) {
      setNotice("请选择套装和尺寸");
      return;
    }
    try {
      setNotice("正在从模板套装创建项目...");
      const created = await api.createProjectFromTemplateSet(selectedSetId, size.size_name, copyDesignFromBase);
      setProject(created);
      setDesignCanvas(readDesignCanvas(created));
      setNotice(`项目已创建：${created.name}`);
      setShowTemplateDialog(false);
      // 加载项目数据
      const [projectPieces, projectTextures, projectAssets] = await Promise.all([
        api.listPieces(created.id),
        api.listTextures(created.id),
        Promise.resolve([] as Asset[]), // assets 列表 API 当前未暴露，暂空
      ]);
      setPieces(projectPieces);
      setTextures(projectTextures);
      setSelectedPieceId(projectPieces[0]?.id || "");
      if (created.export_config?.design_canvas) {
        setDesignCanvas(created.export_config.design_canvas as DesignCanvas);
      }
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "创建失败"));
    }
  }

  return (
    <main className="min-h-screen bg-mist p-4 text-ink">
      <header className="mb-4 grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border border-line bg-white px-5 py-4 shadow-panel max-[980px]:grid-cols-1">
        <div>
          <p className="m-0 text-sm font-semibold text-jade">生产打样工作台</p>
          <h1 className="m-0 mt-1 text-3xl font-bold">服装裁片</h1>
          <p className="m-0 mt-2 text-sm text-slate-500">{notice}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-white px-4 py-2 font-semibold text-ink ring-1 ring-line" onClick={openTemplateDialog}>
            从模板套装创建
          </button>
          <button className="rounded-lg bg-action px-4 py-2 font-semibold text-white" onClick={exportPack}>
            导出打样包
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[340px_minmax(720px,1fr)_minmax(520px,0.95fr)] gap-4 max-[1500px]:grid-cols-1">
        <aside className="space-y-4">
          <Panel title="素材">
            <FileField label="裁片模板 PNG/WebP 或白底排版原图 JPG/PNG/WebP" accept="image/png,image/webp,image/jpeg" selectedName={templateFileName} onFile={handleTemplate} />
            <div className="mt-4 grid gap-2">
              <label className="text-sm font-semibold">布料来源</label>
              <select className="rounded-lg border border-line bg-white px-3 py-2" value={sourceType} onChange={(event) => setSourceType(event.target.value as typeof sourceType)}>
                <option value="pattern">图案平铺</option>
                <option value="garment_photo">已有衣服复刻</option>
                <option value="ai">AI 生成</option>
                <option value="library">纹理库</option>
              </select>
            </div>
            <textarea
              className="mt-3 min-h-24 w-full resize-y rounded-lg border border-line px-3 py-2 text-sm"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <FileField label="上传图案或衣服照片" accept="image/*" selectedName={textureFileName} onFile={handleTexture} />
            <button className="mt-3 w-full rounded-lg bg-ink px-4 py-2 font-semibold text-white" onClick={() => handleTexture()}>
              仅用 Prompt 生成
            </button>
            <div className="mt-3 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
              <div>裁片模板：{templateFileName || "未上传"}</div>
              <div>素材图：{textureFileName || "未上传"}</div>
              <div>
                上传素材：{assetSummary.total} 个（模板 {assetSummary.templateCount} / 图案 {assetSummary.patternCount} / 衣照 {assetSummary.garmentPhotoCount}）
              </div>
            </div>
          </Panel>

          <Panel title="纹理">
            {activeTexture ? (
              <div className="space-y-3">
                <img className="checkerboard h-48 w-full rounded-lg object-contain" src={selectedInputTextureUrl} alt="当前纹理" />
                <p className="m-0 text-xs text-slate-500">纹理大小：{activeTexture.width} x {activeTexture.height}</p>
                <p className="m-0 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
                  系统建议：{recommendationLabel}。{readAnalysisReason(activeTexture.analysis)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-line ${
                      textureViewMode === "source" || !hasSeamlessTexture ? "bg-ink text-white" : "bg-white text-ink"
                    }`}
                    onClick={() => setTextureViewMode("source")}
                  >
                    使用原图
                  </button>
                  <button
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-line ${
                      textureViewMode === "seamless" && hasSeamlessTexture ? "bg-ink text-white" : "bg-white text-ink"
                    } ${hasSeamlessTexture ? "" : "opacity-50"}`}
                    disabled={!hasSeamlessTexture}
                    onClick={() => setTextureViewMode("seamless")}
                  >
                    使用无缝图
                  </button>
                </div>
                <p className="m-0 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                  当前适配输入：{textureViewMode === "seamless" && hasSeamlessTexture ? "无缝图" : "原图"}。无缝处理适合满版纹理；透明底主体图案建议使用原图定位。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line" onClick={() => handleSeamless("mirror")}>
                    镜像无缝
                  </button>
                  <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line" onClick={() => handleSeamless("offset")}>
                    Offset 修缝
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">上传图案或使用 Prompt 生成纹理。</p>
            )}

          </Panel>

          <Panel title="全局适配">
            <div className="grid gap-3 text-sm">
              <label className="grid gap-1">
                <span className="font-semibold">衣服类型</span>
                <select className="rounded-lg border border-line bg-white px-3 py-2" value={garmentType} onChange={(event) => setGarmentType(event.target.value as typeof garmentType)}>
                  <option value="unknown">未知</option>
                  <option value="t_shirt">T 恤</option>
                  <option value="shirt">衬衫</option>
                </select>
                <span className="text-xs leading-5 text-slate-500">帮助系统识别前片、后片、袖片；不确定就选未知，后面仍可手动调整。</span>
              </label>
              <label className="grid gap-1">
                <span className="font-semibold">全局纹理方向：{textureAngle}°</span>
                <input type="range" min="-180" max="180" value={textureAngle} onChange={(event) => setTextureAngle(Number(event.target.value))} />
                <span className="text-xs leading-5 text-slate-500">控制整件衣服上的纹理角度；不调就是按原图方向铺开。</span>
              </label>
              <label className="grid gap-1">
                <span className="font-semibold">纹理缩放：{globalTextureScale.toFixed(2)}</span>
                <input type="range" min="0.2" max="4" step="0.05" value={globalTextureScale} onChange={(event) => setGlobalTextureScale(Number(event.target.value))} />
                <span className="text-xs leading-5 text-slate-500">控制花纹大小和密度；不调会保持原始比例，通常适合先看整体效果。</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-sm">
                  <span className="font-semibold">偏移 X: {globalOffsetX}</span>
                  <input type="range" min="-2048" max="2048" step="1" value={globalOffsetX} onChange={(event) => setGlobalOffsetX(Number(event.target.value))} />
                  <span className="text-xs leading-5 text-slate-500">左右移动整张纹理。</span>
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="font-semibold">偏移 Y: {globalOffsetY}</span>
                  <input type="range" min="-2048" max="2048" step="1" value={globalOffsetY} onChange={(event) => setGlobalOffsetY(Number(event.target.value))} />
                  <span className="text-xs leading-5 text-slate-500">上下移动整张纹理。</span>
                </label>
              </div>
              <label className="grid gap-1">
                <span className="font-semibold">左右规则</span>
                <select className="rounded-lg border border-line bg-white px-3 py-2" value={globalSymmetry} onChange={(event) => setGlobalSymmetry(event.target.value as typeof globalSymmetry)}>
                  <option value="continuous">连续统一</option>
                  <option value="mirror">左右镜像</option>
                </select>
                <span className="text-xs leading-5 text-slate-500">连续统一适合水纹、迷彩、花纹；左右镜像适合需要对称的左右片。</span>
              </label>
              <label className="grid gap-1">
                <span className="font-semibold">主视觉中心</span>
                <select className="rounded-lg border border-line bg-white px-3 py-2" value={globalAnchor} onChange={(event) => setGlobalAnchor(event.target.value)}>
                  <option value="front_center">前胸中心</option>
                  <option value="back_center">后背中心</option>
                  <option value="left_chest">左胸</option>
                  <option value="right_chest">右胸</option>
                  <option value="hem_center">下摆中心</option>
                  <option value="sleeve_center">袖中线</option>
                </select>
                <span className="text-xs leading-5 text-slate-500">决定 logo、鱼、文字等主体优先对齐的位置；满版纹理影响较小。</span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line" onClick={handleAutoMap}>
                  重新识别部位
                </button>
                <button className="rounded-lg bg-jade px-3 py-2 font-semibold text-white disabled:opacity-50" disabled={!activeTexture || pieces.length === 0} onClick={handleGlobalFit}>
                  自动适配纹理
                </button>
              </div>
              <p className="m-0 text-xs leading-5 text-slate-500">上传模板时已自动拆片并识别部位；这里不会重新拆模板，只会重建前片、后片、袖片等全局取样区域。</p>
              <p className="m-0 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
                已启用全局坐标：{globalPieceCount}/{pieces.length} 个裁片。水纹、迷彩和花纹建议使用连续统一；logo、鱼和文字先按主视觉中心定位，再人工微调。
              </p>
            </div>
          </Panel>

          <Panel title="图层">
            <div className="grid gap-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line disabled:opacity-50" disabled={!canUseLayers} onClick={addImageLayer}>
                  添加图片层
                </button>
                <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line disabled:opacity-50" disabled={!canUseLayers} onClick={addTextLayer}>
                  添加文字层
                </button>
              </div>
              {designLayers.length === 0 && (
                <p className="m-0 text-xs leading-5 text-slate-500">
                  先完成“自动适配纹理”，生成全局设计画布后，可添加 logo、主图或号码文字。
                </p>
              )}
              <div className="grid gap-2">
                {designLayers.map((layer) => (
                  <button
                    key={layer.id}
                    className={`rounded-lg border px-3 py-2 text-left ${layer.id === selectedLayerId ? "border-jade bg-emerald-50" : "border-line bg-white"}`}
                    onClick={() => setSelectedLayerId(layer.id)}
                  >
                    <span className="block font-semibold">{layer.name}</span>
                    <span className="text-xs text-slate-500">{layer.type === "image" ? "图片层" : "文字层"} · {layer.visible ? "显示" : "隐藏"} · {layer.locked ? "锁定" : "可编辑"}</span>
                  </button>
                ))}
              </div>
              {selectedLayer && (
                <LayerEditor
                  layer={selectedLayer}
                  pieces={pieces}
                  onChange={(update) => patchLayer(selectedLayer.id, update)}
                  onDelete={() => deleteLayer(selectedLayer.id)}
                />
              )}
              <button className="rounded-lg bg-jade px-3 py-2 font-semibold text-white disabled:opacity-50" disabled={!activeTexture || !designCanvas || autoRenderingDesign} onClick={() => regenerateDesignCanvas()}>
                {autoRenderingDesign ? "正在更新预览" : "立即更新预览"}
              </button>
              {layersDirty && (
                <p className="m-0 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                  图层已保存，系统会自动更新预览和导出画布；若未刷新，可点击立即更新。
                </p>
              )}
              <SafetyReportList report={safetyReport} />
            </div>
          </Panel>
        </aside>

        <section className="grid grid-cols-[128px_minmax(0,1fr)] gap-4 max-[980px]:grid-cols-1">
          <Panel title="裁片">
            <p className="m-0 mb-3 text-xs text-slate-500">裁片数量：{pieces.length}</p>
            <div className="max-h-[760px] space-y-2 overflow-auto pr-1">
              {pieces.length === 0 && <p className="text-xs leading-5 text-slate-500">上传透明模板后会显示裁片。</p>}
              {pieces.map((piece) => (
                <button
                  key={piece.id}
                  title={`${piece.name}：${piece.width} x ${piece.height}`}
                  className={`grid w-full justify-items-center gap-2 rounded-lg border p-2 text-center transition ${
                    piece.id === selectedPieceId ? "border-coral bg-red-50" : "border-line bg-white hover:border-coral/60"
                  }`}
                  onClick={() => setSelectedPieceId(piece.id)}
                >
                  <img className="checkerboard h-20 w-20 rounded-md object-contain" src={piece.mask_url} alt={piece.name} />
                  <span className="block max-w-full truncate text-xs font-semibold">{piece.name}</span>
                </button>
              ))}
            </div>
          </Panel>

          <div className="space-y-4">
            <SinglePieceCalibration
              pieces={pieces}
              selectedPieceId={selectedPieceId}
              textureUrl={workspaceTextureUrl}
              showOutlines={showOutlines}
              outlineWidth={outlineWidth}
              onToggleOutlines={setShowOutlines}
              onOutlineWidthChange={setOutlineWidth}
              onMovePiece={(piece, x, y) => {
                setSelectedPieceId(piece.id);
                void patchPiece(piece.id, { offset_x: Math.round(x), offset_y: Math.round(y) });
              }}
            />

            <Panel title="当前裁片参数">
              {selectedPiece ? (
                <div className="grid gap-4">
                  {selectedPiece.transform.mode === "global_canvas" && (
                    <section className="grid gap-3 rounded-lg border border-line p-3">
                      <div>
                        <h3 className="m-0 text-sm font-semibold">全局取样</h3>
                        <p className="m-0 mt-1 text-xs leading-5 text-slate-500">控制当前裁片从整张设计画布的哪个区域取图，优先用于保持跨裁片连续。</p>
                      </div>
                      <div className="grid gap-4 min-[980px]:grid-cols-2">
                        <Range label="全局 X" description="取样区域在全局画布中的左右位置。" value={selectedPiece.transform.design_x ?? 0} min={0} max={8192} onChange={(value) => patchSelected({ design_x: value })} />
                        <Range label="全局 Y" description="取样区域在全局画布中的上下位置。" value={selectedPiece.transform.design_y ?? 0} min={0} max={8192} onChange={(value) => patchSelected({ design_y: value })} />
                        <Range label="取样宽" description="从全局画布取多宽，影响局部花纹密度。" value={selectedPiece.transform.design_width ?? selectedPiece.width} min={24} max={8192} onChange={(value) => patchSelected({ design_width: value })} />
                        <Range label="取样高" description="从全局画布取多高，影响局部花纹密度。" value={selectedPiece.transform.design_height ?? selectedPiece.height} min={24} max={8192} onChange={(value) => patchSelected({ design_height: value })} />
                      </div>
                    </section>
                  )}
                  <section className="grid gap-3 rounded-lg border border-line p-3">
                    <div>
                      <h3 className="m-0 text-sm font-semibold">单片微调</h3>
                      <p className="m-0 mt-1 text-xs leading-5 text-slate-500">只影响当前裁片内部花位；全局模式下慎用，可能破坏跨裁片连续。</p>
                    </div>
                    <div className="grid gap-4 min-[980px]:grid-cols-2">
                      <Range label="平移 X" description="当前裁片内左右移动图案。" value={selectedPiece.transform.offset_x} min={-1500} max={1500} onChange={(value) => patchSelected({ offset_x: value })} />
                      <Range label="平移 Y" description="当前裁片内上下移动图案。" value={selectedPiece.transform.offset_y} min={-1500} max={1500} onChange={(value) => patchSelected({ offset_y: value })} />
                      <Range label="缩放" description="当前裁片内单独放大或缩小图案。" value={selectedPiece.transform.scale} min={0.2} max={6} step={0.01} onChange={(value) => patchSelected({ scale: value })} />
                      <Range label="旋转" description="当前裁片内单独旋转图案。" value={selectedPiece.transform.rotation} min={-180} max={180} onChange={(value) => patchSelected({ rotation: value })} />
                    </div>
                  </section>
                  <section className="grid gap-3 rounded-lg border border-line p-3">
                    <h3 className="m-0 text-sm font-semibold">基础设置</h3>
                    <label className="grid gap-1 text-sm font-semibold">
                      <span>裁片角色</span>
                      <select className="rounded-lg border border-line bg-white px-3 py-2" value={selectedPiece.transform.piece_role || "unknown"} onChange={(event) => patchSelected({ piece_role: event.target.value, role_confirmed: true })}>
                        {Object.entries(PIECE_ROLE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                      <span className="text-xs font-normal leading-5 text-slate-500">告诉系统这块裁片是什么部位，影响主视觉和安全区判断。</span>
                    </label>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <label className="rounded-lg border border-line p-2">
                        <input type="checkbox" checked={Boolean(selectedPiece.transform.role_confirmed)} onChange={(event) => patchSelected({ role_confirmed: event.target.checked })} /> 人工确认
                        <span className="mt-1 block text-xs leading-5 text-slate-500">锁定当前部位判断。</span>
                      </label>
                      <label className="rounded-lg border border-line p-2">
                        <input type="checkbox" checked={selectedPiece.transform.global_enabled ?? true} onChange={(event) => patchSelected({ global_enabled: event.target.checked })} /> 参与全局
                        <span className="mt-1 block text-xs leading-5 text-slate-500">关闭后不按全局画布取样。</span>
                      </label>
                      <label className="rounded-lg border border-line p-2">
                        <input type="checkbox" checked={selectedPiece.transform.locked} onChange={(event) => patchSelected({ locked: event.target.checked })} /> 锁定裁片
                        <span className="mt-1 block text-xs leading-5 text-slate-500">避免误拖动或误改参数。</span>
                      </label>
                    </div>
                  </section>
                  <details className="rounded-lg border border-line p-3">
                    <summary className="cursor-pointer text-sm font-semibold">高级参数</summary>
                    <div className="mt-3 grid gap-4 min-[980px]:grid-cols-2">
                      <label className="grid gap-1 text-sm font-semibold">
                        <span>配对编号</span>
                        <input className="rounded-lg border border-line px-3 py-2" value={selectedPiece.transform.pair_id || ""} onChange={(event) => patchSelected({ pair_id: event.target.value })} placeholder="例如 pair_front" />
                        <span className="text-xs font-normal leading-5 text-slate-500">用于把左右片或成组裁片绑定，后续做同步和镜像联动。</span>
                      </label>
                      <label className="grid gap-1 text-sm font-semibold">
                        <span>配对方向</span>
                        <select className="rounded-lg border border-line bg-white px-3 py-2" value={selectedPiece.transform.pair_side || ""} onChange={(event) => patchSelected({ pair_side: event.target.value as PieceTransform["pair_side"] })}>
                          <option value="">未设置</option>
                          <option value="left">左</option>
                          <option value="right">右</option>
                          <option value="none">无配对</option>
                        </select>
                        <span className="text-xs font-normal leading-5 text-slate-500">标记当前裁片在配对中的左、右或不配对。</span>
                      </label>
                      <label className="rounded-lg border border-line p-2 text-sm">
                        <input type="checkbox" checked={selectedPiece.transform.mirror_x} onChange={(event) => patchSelected({ mirror_x: event.target.checked })} /> 左右镜像
                        <span className="mt-1 block text-xs leading-5 text-slate-500">把当前裁片取样结果左右翻转。</span>
                      </label>
                      <label className="rounded-lg border border-line p-2 text-sm">
                        <input type="checkbox" checked={selectedPiece.transform.mirror_y} onChange={(event) => patchSelected({ mirror_y: event.target.checked })} /> 上下镜像
                        <span className="mt-1 block text-xs leading-5 text-slate-500">把当前裁片取样结果上下翻转。</span>
                      </label>
                    </div>
                  </details>
                  <button className="rounded-lg bg-white px-4 py-2 font-semibold text-ink ring-1 ring-line" onClick={() => patchSelected(emptyTransform)}>
                    重置当前裁片
                  </button>
                  <div className="rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
                    <div>模式：{selectedPiece.transform.mode === "global_canvas" ? "全局设计画布" : "单片局部"}</div>
                    <div>部位：{PIECE_ROLE_LABELS[selectedPiece.transform.piece_role || ""] || selectedPiece.transform.piece_role || "未识别"}</div>
                    <div>置信度：{Math.round((selectedPiece.transform.fit_confidence ?? 0) * 100)}%</div>
                    {selectedPiece.transform.fit_note && <div>{selectedPiece.transform.fit_note}</div>}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500">请选择裁片。</p>
              )}
            </Panel>
          </div>
        </section>

        <LayoutPreview
          pieces={pieces}
          selectedPieceId={selectedPieceId}
          textureUrl={workspaceTextureUrl}
          fallbackTextureUrl={selectedInputTextureUrl}
          textureIsDesignCanvas={Boolean(activeTexture?.design_canvas_url)}
          designCanvas={designCanvas}
          selectedLayerId={selectedLayerId}
          showOutlines={showOutlines}
          outlineWidth={outlineWidth}
          onSelectPiece={setSelectedPieceId}
          onSelectLayer={setSelectedLayerId}
          onMoveDesignRegion={(piece, update) => {
            setSelectedPieceId(piece.id);
            void patchPiece(piece.id, update);
          }}
          onMoveLayer={(layer, update) => {
            setSelectedLayerId(layer.id);
            void patchLayer(layer.id, update);
          }}
        />
      </div>
      <ToastNotice notice={notice} job={job} />

      {showTemplateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border border-line bg-white p-5 shadow-panel">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">从模板套装创建项目</h2>
              <Link
                href="/templates"
                target="_blank"
                className="text-sm text-action hover:underline"
              >
                管理套装
              </Link>
            </div>
            <div className="mb-3">
              <label className="mb-1 block text-sm font-semibold">选择套装</label>
              <select
                className="w-full rounded-lg border border-line bg-white px-3 py-2"
                value={selectedSetId}
                onChange={(e) => onSelectTemplateSet(e.target.value)}
              >
                {templateSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name} {set.version_label ? `(${set.version_label})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-3">
              <label className="mb-1 block text-sm font-semibold">选择尺寸</label>
              <select
                className="w-full rounded-lg border border-line bg-white px-3 py-2"
                value={selectedSetSizes.find((s) => s.is_base)?.size_name || ""}
                onChange={(e) => {
                  const size = selectedSetSizes.find((s) => s.size_name === e.target.value);
                  if (size) {
                    setSelectedSetSizes((prev) =>
                      prev.map((s) => ({ ...s, is_base: s.size_name === size.size_name }))
                    );
                    setCopyDesignFromBase(!size.is_base);
                  }
                }}
              >
                {selectedSetSizes.map((size) => (
                  <option key={size.id} value={size.size_name}>
                    {size.size_name} {size.is_base ? "(基准)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={copyDesignFromBase}
                onChange={(e) => setCopyDesignFromBase(e.target.checked)}
              />
              继承基准设计参数（按宽度比例自动缩放）
            </label>
            <div className="flex justify-end gap-2">
              <button className="rounded-lg bg-white px-4 py-2 font-semibold ring-1 ring-line" onClick={() => setShowTemplateDialog(false)}>
                取消
              </button>
              <button className="rounded-lg bg-action px-4 py-2 font-semibold text-white" onClick={createFromTemplateSet}>
                创建项目
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function readError(error: unknown) {
  return error instanceof Error ? error.message.split("\n")[0] : "操作失败，请检查后端日志。";
}

function readAnalysisReason(analysis: Record<string, unknown>) {
  const reasons = Array.isArray(analysis.reasons) ? analysis.reasons : [];
  const first = reasons.find((reason) => typeof reason === "string");
  return first ? String(first) : "系统会按图案特征自动选择适配输入。";
}

function readDesignCanvas(project: Project): DesignCanvas | null {
  const canvas = (project.export_config as { design_canvas?: DesignCanvas }).design_canvas;
  return canvas || null;
}

async function loadInitialProject(): Promise<{ project: Project; pieces: Piece[]; textures: Texture[]; created: boolean }> {
  const storedProjectId = localStorage.getItem(LAST_PROJECT_KEY);
  if (storedProjectId) {
    try {
      return { ...(await readProjectWorkspace(storedProjectId)), created: false };
    } catch {
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
  }
  const projects = await api.listProjects();
  const latest = projects[0];
  if (latest) {
    return { ...(await readProjectWorkspace(latest.id)), created: false };
  }
  const project = await api.createProject();
  return { project, pieces: [], textures: [], created: true };
}

async function readProjectWorkspace(projectId: string): Promise<{ project: Project; pieces: Piece[]; textures: Texture[] }> {
  const project = await api.getProject(projectId);
  const [pieces, textures] = await Promise.all([
    api.listPieces(projectId).catch(() => [] as Piece[]),
    api.listTextures(projectId).catch(() => [] as Texture[])
  ]);
  return { project, pieces, textures };
}

function createLayer(type: "image" | "text", designCanvas: DesignCanvas, asset?: Asset): DesignLayer {
  const anchor = designCanvas.design_anchors?.[designCanvas.anchor] || { x: designCanvas.width / 2, y: designCanvas.height / 2 };
  const id = `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  if (type === "image") {
    const width = Math.min(520, Math.max(180, asset?.width || 360));
    const height = Math.min(520, Math.max(180, asset?.height || 360));
    return {
      id,
      type,
      name: asset?.filename || "图片层",
      visible: true,
      locked: false,
      anchor: designCanvas.anchor,
      x: Math.round(anchor.x - width / 2),
      y: Math.round(anchor.y - height / 2),
      width,
      height,
      rotation: 0,
      opacity: 1,
      target_roles: [],
      asset_id: asset?.id || "",
      source_url: asset?.url || ""
    };
  }
  return {
    id,
    type,
    name: "文字层",
    visible: true,
    locked: false,
    anchor: designCanvas.anchor,
    x: Math.round(anchor.x - 160),
    y: Math.round(anchor.y - 80),
    width: 320,
    height: 160,
    rotation: 0,
    opacity: 1,
    target_roles: [],
    content: "23",
    font_size: 120,
    font_weight: "700",
    fill: "#ffffff",
    stroke: "#111111",
    stroke_width: 6
  };
}
