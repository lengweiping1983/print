"use client";

import type { Asset, DesignCanvas, DesignLayer, FabricPrompt, GlobalFitOptions, Job, Piece, PieceTransform, Project, SizeTemplate, TemplateSet, Texture } from "@print-studio/shared-types";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { SetStateAction } from "react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { api, waitForJob } from "@/lib/api";
import { JOB_TYPE_LABELS, JOB_STATUS_LABELS } from "@/lib/labels";
import { LayoutPreviewLoading, LayerEditor, Panel, SafetyReportList, SinglePieceLoading, ToastNotice } from "./StudioPageParts";

const SinglePieceCalibration = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.SinglePieceCalibration), {
  ssr: false,
  loading: () => <SinglePieceLoading />
});

const LayoutPreview = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.LayoutPreview), {
  ssr: false,
  loading: () => <LayoutPreviewLoading />
});

const LAST_PROJECT_KEY = "print-studio:last-project-id";
type TextureSourceType = "pattern" | "garment_photo" | "ai" | "library";

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
  prompt: string;
  job: Job | null;
  notice: string;
  showAiTextureDialog: boolean;

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
  pieceDefaults: Record<string, PieceTransform>;
  globalFitDefaults: {
    texture_scale: number;
    texture_angle: number;
    texture_offset_x: number;
    texture_offset_y: number;
  };
  globalLocked: boolean;
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
  prompt: "",
  job: null,
  notice: "正在准备工作台...",
  showAiTextureDialog: false,

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
  copyDesignFromBase: true,
  pieceDefaults: {},
  globalFitDefaults: { texture_scale: 1, texture_angle: 0, texture_offset_x: 0, texture_offset_y: 0 },
  globalLocked: false
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
    prompt,
    job,
    notice,
    showAiTextureDialog,

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
    copyDesignFromBase,
    pieceDefaults,
    globalFitDefaults,
    globalLocked
  } = state;
  const setField = <K extends keyof StudioState>(field: K, value: SetStateAction<StudioState[K]>) => {
    dispatch({ type: "setField", field, value: value as SetStateAction<StudioState[keyof StudioState]> });
  };
  const setProject = (value: SetStateAction<Project | null>) => setField("project", value);
  const setAssets = (value: SetStateAction<Asset[]>) => setField("assets", value);
  const setPieces = (value: SetStateAction<Piece[]>) => setField("pieces", value);
  const setTextures = (value: SetStateAction<Texture[]>) => setField("textures", value);
  const setSelectedPieceId = (value: SetStateAction<string>) => setField("selectedPieceId", value);
  const setPrompt = (value: SetStateAction<string>) => setField("prompt", value);
  const setJob = (value: SetStateAction<Job | null>) => setField("job", value);
  const setNotice = (value: SetStateAction<string>) => setField("notice", value);
  const setShowAiTextureDialog = (value: SetStateAction<boolean>) => setField("showAiTextureDialog", value);

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
  const setPieceDefaults = (value: SetStateAction<Record<string, PieceTransform>>) => setField("pieceDefaults", value);
  const setGlobalFitDefaults = (value: SetStateAction<StudioState["globalFitDefaults"]>) => setField("globalFitDefaults", value);
  const setGlobalLocked = (value: SetStateAction<boolean>) => setField("globalLocked", value);
  const prevJobRef = useRef<Job | null>(null);
  const layerRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fabricInputRef = useRef<HTMLInputElement | null>(null);
  const garmentInputRef = useRef<HTMLInputElement | null>(null);
  const aiTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const layerImageInputRef = useRef<HTMLInputElement | null>(null);

  const [fabricPrompts, setFabricPrompts] = useState<FabricPrompt[]>([]);
  const [showPromptMenu, setShowPromptMenu] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [aiResolution, setAiResolution] = useState<"1K" | "2K" | "4K">("2K");
  const [aiRatio, setAiRatio] = useState<"1:1" | "9:16" | "16:9" | "3:4" | "4:3">("1:1");
  const [showParamMenu, setShowParamMenu] = useState(false);
  const paramMenuRef = useRef<HTMLDivElement | null>(null);
  const [aiDialogMode, setAiDialogMode] = useState<"texture" | "layer">("texture");

  useEffect(() => {
    let active = true;
    api.listFabricPrompts().then((data) => {
      if (active) setFabricPrompts(data);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!showParamMenu) return;
    function handleDocClick(event: MouseEvent) {
      if (paramMenuRef.current && !paramMenuRef.current.contains(event.target as Node)) {
        setShowParamMenu(false);
      }
    }
    document.addEventListener("mousedown", handleDocClick);
    return () => document.removeEventListener("mousedown", handleDocClick);
  }, [showParamMenu]);

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        const [restored, sets] = await Promise.all([loadInitialProject(), api.listTemplateSets()]);
        if (!active) return;
        setProject(restored.project);
        setDesignCanvas(readDesignCanvas(restored.project));
        setPieces(restored.pieces);
        setPieceDefaults(extractPieceDefaults(restored.pieces));
        setGlobalFitDefaults({ texture_scale: 1, texture_angle: 0, texture_offset_x: 0, texture_offset_y: 0 });
        setTextures(restored.textures);
        setSelectedPieceId(restored.pieces[0]?.id ?? "");
        setTemplateSets(sets);
        localStorage.setItem(LAST_PROJECT_KEY, restored.project.id);
        setNotice(restored.created ? "项目已创建，请在左侧选择模板开始打样。" : "已恢复最近的裁片项目。");
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
  const primaryPieceCount = pieces.filter((piece) => !piece.mirror_of).length;
  const linkedPieceCount = pieces.length - primaryPieceCount;
  const globalPieceCount = pieces.filter((piece) => !piece.mirror_of && piece.transform.mode === "global_canvas" && piece.transform.global_enabled !== false).length;
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

  async function handleTexture(sourceType: TextureSourceType, file?: File) {
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
      if (sourceType === "ai") setShowAiTextureDialog(false);
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
      const mappedPieces = (done.output.pieces as Piece[]) ?? (await api.listPieces(project.id));
      setPieces(mappedPieces);
      setPieceDefaults(extractPieceDefaults(mappedPieces));
      setGlobalFitDefaults({ texture_scale: globalTextureScale, texture_angle: textureAngle, texture_offset_x: globalOffsetX, texture_offset_y: globalOffsetY });
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
      const fittedPieces = (done.output.pieces as Piece[]) ?? (await api.listPieces(project.id));
      setPieces(fittedPieces);
      setPieceDefaults(extractPieceDefaults(fittedPieces));
      setGlobalFitDefaults({ texture_scale: globalTextureScale, texture_angle: textureAngle, texture_offset_x: globalOffsetX, texture_offset_y: globalOffsetY });
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

  function resetPieceToDefault() {
    if (!selectedPiece) return;
    const defaultTransform = pieceDefaults[selectedPiece.id];
    if (defaultTransform) {
      void patchSelected({ ...defaultTransform, locked: selectedPiece.transform.locked });
    } else {
      void patchSelected({ ...emptyTransform, locked: selectedPiece.transform.locked });
    }
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
      setPieces(previous.map((p) => (p.id === saved.id ? saved : p)));
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

  async function handleLayerUpload(file: File) {
    if (!project || !designCanvas) {
      setNotice("请先上传或生成纹理，并点击“自动适配纹理”生成全局设计画布后，再添加图层。");
      return;
    }
    setNotice(`上传 ${file.name}...`);
    const asset = await api.uploadAsset(project.id, "pattern", file);
    setAssets((current) => [asset, ...current]);
    const layer = createLayer("image", designCanvas, asset);
    const next = { ...designCanvas, layers: [...designLayers, layer] };
    const previousSelectedLayerId = selectedLayerId;
    setSelectedLayerId(layer.id);
    await saveDesignCanvas(next, true, previousSelectedLayerId);
    setNotice(`${file.name} 已添加为图片层。`);
  }

  async function handleLayerAiImage() {
    if (!project || !designCanvas) {
      setNotice("请先上传或生成纹理，并点击“自动适配纹理”生成全局设计画布后，再添加图层。");
      return;
    }
    try {
      setNotice("正在生成 AI 图片层...");
      const created = await api.generateTexture(project.id, "", "ai", prompt);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current]);
      const layer = createLayer("image", designCanvas);
      const width = Math.min(520, Math.max(180, texture.width || 360));
      const height = Math.min(520, Math.max(180, texture.height || 360));
      const anchor = designCanvas.design_anchors?.[designCanvas.anchor] || { x: designCanvas.width / 2, y: designCanvas.height / 2 };
      layer.name = "AI 图片层";
      layer.source_url = texture.source_url;
      layer.width = width;
      layer.height = height;
      layer.x = Math.round(anchor.x - width / 2);
      layer.y = Math.round(anchor.y - height / 2);
      const next = { ...designCanvas, layers: [...designLayers, layer] };
      const previousSelectedLayerId = selectedLayerId;
      setSelectedLayerId(layer.id);
      await saveDesignCanvas(next, true, previousSelectedLayerId);
      setShowAiTextureDialog(false);
      setNotice("AI 图片层已生成。");
    } catch (error) {
      setNotice(readError(error));
    }
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
    setSelectedSetId("");
    setSelectedSetSizes([]);
  }

  async function onSelectTemplateSet(setId: string) {
    setSelectedSetId(setId);
    const sizes = await api.listTemplateSetSizes(setId);
    setSelectedSetSizes(sizes);
  }

  async function createFromTemplateSet() {
    const size = selectedSetSizes.find((s) => s.is_base);
    if (!selectedSetId || !size) {
      setNotice("该套装没有可用的基准尺寸");
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
      const [projectPieces, projectTextures] = await Promise.all([
        api.listPieces(created.id).catch(() => [] as Piece[]),
        api.listTextures(created.id).catch(() => [] as Texture[]),
      ]);
      setPieces(projectPieces);
      setPieceDefaults(extractPieceDefaults(projectPieces));
      setGlobalFitDefaults({ texture_scale: 1, texture_angle: 0, texture_offset_x: 0, texture_offset_y: 0 });
      setTextures(projectTextures);
      setSelectedPieceId(projectPieces[0]?.id || "");
      if (created.export_config?.design_canvas) {
        setDesignCanvas(created.export_config.design_canvas as DesignCanvas);
      }
      localStorage.setItem(LAST_PROJECT_KEY, created.id);
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "创建失败"));
    }
  }

  async function loadFromTemplateSet(setId: string) {
    try {
      setNotice("正在加载模板...");
      const sizes = await api.listTemplateSetSizes(setId);
      const baseSize = sizes.find((s) => s.is_base);
      if (!baseSize) {
        setNotice("该模板没有可用的基准尺寸");
        return;
      }
      const created = await api.createProjectFromTemplateSet(setId, baseSize.size_name, true);
      setProject(created);
      setDesignCanvas(readDesignCanvas(created));
      setNotice(`已加载模板：${created.name}`);
      const [projectPieces, projectTextures] = await Promise.all([
        api.listPieces(created.id).catch(() => [] as Piece[]),
        api.listTextures(created.id).catch(() => [] as Texture[]),
      ]);
      setPieces(projectPieces);
      setPieceDefaults(extractPieceDefaults(projectPieces));
      setTextures(projectTextures);
      setSelectedPieceId(projectPieces[0]?.id || "");
      if (created.export_config?.design_canvas) {
        setDesignCanvas(created.export_config.design_canvas as DesignCanvas);
      }
      localStorage.setItem(LAST_PROJECT_KEY, created.id);
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "加载失败"));
    }
  }

  return (
    <main className="min-h-screen bg-mist p-4 text-ink">
      <header className="mb-4 grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border border-line bg-white px-5 py-4 shadow-panel max-[980px]:grid-cols-1">
        <div>
          <h1 className="m-0 text-3xl font-bold">服装裁片</h1>
          <p className="m-0 mt-2 text-sm text-slate-500">{notice}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-action px-4 py-2 font-semibold text-white" onClick={exportPack}>
            导出打样包
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[340px_minmax(720px,1fr)_minmax(520px,0.95fr)] gap-4 max-[1500px]:grid-cols-1">
        <aside className="space-y-4">
          <Panel
            title="套装"
            action={
              <Link href="/templates" target="_blank" className="text-xs text-action hover:underline">
                管理套装
              </Link>
            }
          >
            <div className="grid gap-2">
              <select
                className="rounded-lg border border-line bg-white px-3 py-2"
                value={selectedSetId}
                onChange={(event) => {
                  const setId = event.target.value;
                  setSelectedSetId(setId);
                  if (setId) {
                    void loadFromTemplateSet(setId);
                  } else {
                    setPieces([]);
                    setAssets([]);
                    setTextures([]);
                    setDesignCanvas(null);
                    setSelectedPieceId("");
                    setProject(null);
                    localStorage.removeItem(LAST_PROJECT_KEY);
                  }
                }}
              >
                <option value="">未选择套装</option>
                {templateSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name} {set.version_label ? `(${set.version_label})` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs leading-5 text-slate-500">选择已确认的模板套装，自动加载基准尺寸及裁片。</p>
            </div>
          </Panel>

          <Panel
            title="纹理"
            action={
              <div className="flex gap-2">
                <button className="rounded-md bg-ink px-2.5 py-1.5 text-xs font-semibold text-white" onClick={() => fabricInputRef.current?.click()}>
                  上传布料
                </button>
                <button className="rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold ring-1 ring-line" onClick={() => garmentInputRef.current?.click()}>
                  上传衣服
                </button>
                <button className="rounded-md bg-action px-2.5 py-1.5 text-xs font-semibold text-white" onClick={() => { setAiDialogMode("texture"); setShowAiTextureDialog(true); }}>
                  AI 生图
                </button>
              </div>
            }
          >
            <div className="space-y-2">
              <input
                ref={fabricInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleTexture("pattern", file);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={garmentInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleTexture("garment_photo", file);
                  event.currentTarget.value = "";
                }}
              />
              <div className="relative">
                {activeTexture ? (
                  <img className="checkerboard h-40 w-full rounded-lg object-contain" src={selectedInputTextureUrl} alt="当前纹理" />
                ) : (
                  <div className="checkerboard flex h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line text-sm text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    暂无纹理
                  </div>
                )}
              </div>
              <p className="m-0 text-xs text-slate-500">
                {activeTexture ? `纹理大小：${activeTexture.width} x ${activeTexture.height}` : "纹理大小：未生成"}
              </p>
              {activeTexture ? (
                <>
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
                </>
              ) : (
                <p className="m-0 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">上传布料、上传衣服复刻，或使用 AI 生图纹理。</p>
              )}
            </div>

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
                  自动适配并应用
                </button>
              </div>
              <p className="m-0 text-xs leading-5 text-slate-500">上传模板时已自动拆片并识别部位；这里不会重新拆模板，只会重建前片、后片、袖片等全局取样区域。</p>
              <p className="m-0 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
                已启用全局坐标：{globalPieceCount}/{primaryPieceCount} 个主裁片；{linkedPieceCount} 个关联裁片由源裁片派生，不参与全局定位。
              </p>
            </div>
          </Panel>

          <Panel
            title="图层"
            action={
              <div className="flex gap-2">
                <button className="rounded-md bg-ink px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={!canUseLayers} onClick={() => layerImageInputRef.current?.click()}>
                  上传图片
                </button>
                <button className="rounded-md bg-action px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50" disabled={!canUseLayers} onClick={() => { setAiDialogMode("layer"); setShowAiTextureDialog(true); }}>
                  AI 生图
                </button>
              </div>
            }
          >
            <div className="grid gap-3 text-sm">
              <input
                ref={layerImageInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleLayerUpload(file);
                  event.currentTarget.value = "";
                }}
              />
              <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line disabled:opacity-50" disabled={!canUseLayers} onClick={addTextLayer}>
                添加文字层
              </button>
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
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="block truncate font-semibold">{layer.name}</span>
                        <span className="text-xs text-slate-500">{layer.type === "image" ? "图片层" : "文字层"} · {layer.visible ? "显示" : "隐藏"} · {layer.locked ? "锁定" : "可编辑"}</span>
                      </div>
                      {layer.type === "image" && layer.source_url && (
                        <div className="group relative shrink-0">
                          <img className="h-10 w-10 rounded-md object-cover" src={layer.source_url} alt="" />
                          <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-1 hidden rounded-lg border border-line bg-white p-1 shadow-lg group-hover:block">
                            <img className="max-h-40 max-w-40 rounded-md object-contain" src={layer.source_url} alt="" />
                          </div>
                        </div>
                      )}
                    </div>
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
              {pieces.map((piece) => {
                const isLinked = Boolean(piece.mirror_of);
                const sourceName = isLinked ? pieces.find((p) => p.id === piece.mirror_of)?.name || "" : "";
                const mx = piece.transform.mirror_x;
                const my = piece.transform.mirror_y;
                let linkLabel = "相同";
                if (mx && my) linkLabel = "上下镜像 + 左右镜像";
                else if (mx) linkLabel = "左右镜像";
                else if (my) linkLabel = "上下镜像";
                return (
                  <button
                    key={piece.id}
                    title={`${piece.name}：${piece.width} x ${piece.height}${isLinked ? "（" + linkLabel + "于 " + sourceName + "）" : ""}`}
                    className={`grid w-full justify-items-center gap-2 rounded-lg border p-2 text-center transition ${
                      piece.id === selectedPieceId ? "border-coral bg-red-50" : isLinked ? "cursor-not-allowed border-line bg-slate-100 opacity-60" : "border-line bg-white hover:border-coral/60"
                    }`}
                    disabled={isLinked}
                    onClick={() => {
                      if (!isLinked) {
                        setSelectedPieceId(piece.id);
                      }
                    }}
                  >
                    <img className={`h-20 w-20 rounded-md object-contain ${isLinked ? "bg-slate-200" : "checkerboard"}`} src={piece.mask_url} alt={piece.name} />
                    <span className="block max-w-full truncate text-xs font-semibold">{piece.name}</span>
                    {isLinked && <span className="text-[9px] text-slate-500">{linkLabel} {sourceName}</span>}
                  </button>
                );
              })}
            </div>
          </Panel>

          <div className="space-y-4">
            <SinglePieceCalibration
              pieces={pieces}
              selectedPieceId={selectedPieceId}
              textureUrl={workspaceTextureUrl}
              showOutlines={showOutlines}
              outlineWidth={outlineWidth}
              designCanvas={designCanvas}
              onToggleOutlines={setShowOutlines}
              onOutlineWidthChange={setOutlineWidth}
              onMovePiece={(piece, x, y) => {
                setSelectedPieceId(piece.id);
                void patchPiece(piece.id, { offset_x: Math.round(x), offset_y: Math.round(y) });
              }}
              onPatchTransform={patchSelected}
              onResetPiece={resetPieceToDefault}
            />
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
          globalTextureScale={globalTextureScale}
          textureAngle={textureAngle}
          globalOffsetX={globalOffsetX}
          globalOffsetY={globalOffsetY}
          onGlobalTextureScaleChange={setGlobalTextureScale}
          onTextureAngleChange={setTextureAngle}
          onGlobalOffsetXChange={setGlobalOffsetX}
          onGlobalOffsetYChange={setGlobalOffsetY}
          onApplyGlobalFit={handleGlobalFit}
          onResetGlobalFit={() => {
            setGlobalTextureScale(globalFitDefaults.texture_scale);
            setTextureAngle(globalFitDefaults.texture_angle);
            setGlobalOffsetX(globalFitDefaults.texture_offset_x);
            setGlobalOffsetY(globalFitDefaults.texture_offset_y);
          }}
          canApplyGlobalFit={Boolean(activeTexture && pieces.length > 0)}
          locked={globalLocked}
          onToggleLocked={() => setGlobalLocked((v) => !v)}
        />
      </div>
      {showAiTextureDialog && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-4">
          <form
            className="relative w-full max-w-2xl rounded-lg border border-line bg-white p-4 text-ink shadow-panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (aiDialogMode === "texture") {
                void handleTexture("ai");
              } else {
                void handleLayerAiImage();
              }
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex gap-2">
                <button type="button" className="rounded-lg border border-line bg-white px-4 py-3 text-xs text-slate-600">
                  风格
                </button>
                <button type="button" className="rounded-lg border border-line bg-white px-4 py-3 text-xs text-slate-600">
                  标记
                </button>
                <button type="button" className="rounded-lg border border-line bg-white px-4 py-3 text-xs text-slate-600">
                  聚焦
                </button>
              </div>
              <button type="button" className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={() => setShowAiTextureDialog(false)}>
                x
              </button>
            </div>
            <div className="relative">
              <textarea
                ref={aiTextareaRef}
                className="min-h-28 w-full resize-y rounded-lg border border-transparent bg-transparent px-1 py-2 text-sm text-ink outline-none placeholder:text-slate-400"
                value={prompt}
                onChange={(event) => {
                  const value = event.target.value;
                  setPrompt(value);
                  if (value.endsWith("/")) {
                    setShowPromptMenu(true);
                    setHighlightedIndex(0);
                  } else {
                    setShowPromptMenu(false);
                  }
                }}
                onKeyDown={(event) => {
                  if (!showPromptMenu || fabricPrompts.length === 0) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setHighlightedIndex((i) => (i + 1) % fabricPrompts.length);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setHighlightedIndex((i) => (i - 1 + fabricPrompts.length) % fabricPrompts.length);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = fabricPrompts[highlightedIndex];
                    if (selected) {
                      setPrompt(selected.prompt);
                      setShowPromptMenu(false);
                      setHighlightedIndex(0);
                    }
                  } else if (event.key === "Escape") {
                    setShowPromptMenu(false);
                  }
                }}
                placeholder="描述你想要生成的画面内容，按 / 呼出指令，@ 引用素材"
                autoFocus
              />
              {showPromptMenu && fabricPrompts.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-white py-1 shadow-lg">
                  {fabricPrompts.map((item, index) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`w-full px-3 py-2 text-left text-sm ${index === highlightedIndex ? "bg-slate-100" : "hover:bg-slate-50"}`}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => {
                        setPrompt(item.prompt);
                        setShowPromptMenu(false);
                        setHighlightedIndex(0);
                      }}
                    >
                      <span className="font-medium text-ink">{item.name}</span>
                      <span className="mx-1 text-slate-400">·</span>
                      <span className="text-slate-500">适用场景：{item.scenarios}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <span>Nano Banana Pro</span>
              <div ref={paramMenuRef} className="relative">
                <button
                  type="button"
                  className="rounded-md border border-line bg-white px-2 py-1 hover:bg-slate-50"
                  onClick={() => setShowParamMenu((v) => !v)}
                >
                  {aiRatio} · {aiResolution}
                </button>
                {showParamMenu && (
                  <div
                    className="absolute bottom-full left-0 z-50 mb-1 w-56 rounded-lg border border-line bg-white p-2 shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="mb-2 text-[10px] text-slate-500">分辨率</div>
                    <div className="mb-3 flex gap-1">
                      {(["1K", "2K", "4K"] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={`flex-1 rounded-md py-1 text-xs ${aiResolution === r ? "bg-slate-200 text-ink" : "text-slate-500 hover:bg-slate-100"}`}
                          onClick={() => setAiResolution(r)}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                    <div className="mb-2 text-[10px] text-slate-500">比例</div>
                    <div className="flex flex-wrap gap-1">
                      {(["1:1", "9:16", "16:9", "3:4", "4:3"] as const).map((rt) => (
                        <button
                          key={rt}
                          type="button"
                          className={`rounded-md px-2 py-1 text-xs ${aiRatio === rt ? "bg-slate-200 text-ink" : "text-slate-500 hover:bg-slate-100"}`}
                          onClick={() => setAiRatio(rt)}
                        >
                          {rt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <span className="ml-auto rounded-md border border-line bg-white px-2 py-1">1张</span>
              <button type="submit" className="rounded-lg bg-action px-4 py-2 font-semibold text-white">
                生成
              </button>
            </div>
          </form>
        </div>
      )}
      <ToastNotice notice={notice} job={job} />


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

function extractPieceDefaults(pieces: Piece[]): Record<string, PieceTransform> {
  return pieces.reduce<Record<string, PieceTransform>>((acc, piece) => {
    acc[piece.id] = { ...piece.transform };
    return acc;
  }, {});
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
