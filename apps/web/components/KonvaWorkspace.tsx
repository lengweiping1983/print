"use client";

import type { DesignCanvas, DesignLayer, Piece } from "@print-studio/shared-types";
import { PIECE_ROLE_LABELS } from "@/lib/labels";
import "konva/lib/shapes/Image.js";
import "konva/lib/shapes/Rect.js";
import "konva/lib/shapes/Text.js";
import { useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva/es/ReactKonvaCore.js";

const loadedImageCache = new Map<string, Promise<HTMLImageElement | null>>();
const loadedImageValueCache = new Map<string, HTMLImageElement | null>();
const luminanceMaskCache = new Map<string, HTMLCanvasElement>();
const luminanceMaskPromiseCache = new Map<string, Promise<HTMLCanvasElement | null>>();
const MAX_CONCURRENT_IMAGE_LOADS = 4;
const IMAGE_CACHE_LIMIT = 64;
const MASK_CACHE_LIMIT = 48;
const MAX_SAMPLE_CANVAS_EDGE = 1024;
const MAX_SAMPLE_CANVAS_PIXELS = 1_048_576;
const WORKSPACE_CANVAS_HEIGHT = 640;
let activeImageLoads = 0;
const imageLoadQueue: Array<() => void> = [];
let maskWorker: Worker | null = null;
let maskWorkerRequestId = 0;
const maskWorkerRequests = new Map<
  number,
  {
    resolve: (canvas: HTMLCanvasElement | null) => void;
    reject: (error: Error) => void;
  }
>();

type TextureSnapSettings = {
  originX: number;
  originY: number;
  periodX: number;
  periodY: number;
};

type TextureImageSource = HTMLImageElement | HTMLCanvasElement;

function rememberCacheValue<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function readCacheValue<K, V>(cache: Map<K, V>, key: K, limit: number) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  rememberCacheValue(cache, key, value as V, limit);
  return value;
}

function limitedCanvasSize(width: number, height: number) {
  const naturalWidth = Math.max(1, Math.round(width));
  const naturalHeight = Math.max(1, Math.round(height));
  const edgeScale = Math.min(1, MAX_SAMPLE_CANVAS_EDGE / Math.max(naturalWidth, naturalHeight));
  const pixelScale = Math.min(1, Math.sqrt(MAX_SAMPLE_CANVAS_PIXELS / Math.max(1, naturalWidth * naturalHeight)));
  const scale = Math.min(edgeScale, pixelScale);
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
    scale
  };
}

function textureSourceWidth(image: TextureImageSource) {
  return ("naturalWidth" in image ? image.naturalWidth || image.width : image.width) || 1;
}

function textureSourceHeight(image: TextureImageSource) {
  return ("naturalHeight" in image ? image.naturalHeight || image.height : image.height) || 1;
}

function useLoadedImage(src: string, fallbackSrc = "") {
  const cacheKey = imageCacheKey(src, fallbackSrc);
  const [image, setImage] = useState<HTMLImageElement | null>(() => readCacheValue(loadedImageValueCache, cacheKey, IMAGE_CACHE_LIMIT) ?? null);
  useEffect(() => {
    if (!src) {
      setImage(null);
      return;
    }
    const cachedValue = readCacheValue(loadedImageValueCache, cacheKey, IMAGE_CACHE_LIMIT);
    if (cachedValue !== undefined) {
      setImage(cachedValue);
      return;
    }
    let active = true;
    loadCachedImage(src, fallbackSrc).then((next) => {
      if (active) setImage(next);
    });
    return () => {
      active = false;
    };
  }, [src, fallbackSrc, cacheKey]);
  return image;
}

function imageCacheKey(src: string, fallbackSrc = "") {
  return `${src}::${fallbackSrc}`;
}

function loadCachedImage(src: string, fallbackSrc = "") {
  const cacheKey = imageCacheKey(src, fallbackSrc);
  if (loadedImageValueCache.has(cacheKey)) {
    return Promise.resolve(readCacheValue(loadedImageValueCache, cacheKey, IMAGE_CACHE_LIMIT) ?? null);
  }
  const cached = readCacheValue(loadedImageCache, cacheKey, IMAGE_CACHE_LIMIT);
  if (cached) return cached;

  const promise = loadImage(src).then((image) => {
    if (image || !fallbackSrc || fallbackSrc === src) {
      rememberCacheValue(loadedImageValueCache, cacheKey, image, IMAGE_CACHE_LIMIT);
      return image;
    }
    return loadImage(fallbackSrc).then((fallback) => {
      rememberCacheValue(loadedImageValueCache, cacheKey, fallback, IMAGE_CACHE_LIMIT);
      return fallback;
    });
  });
  rememberCacheValue(loadedImageCache, cacheKey, promise, IMAGE_CACHE_LIMIT);
  return promise;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    imageLoadQueue.push(() => {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        finishQueuedImageLoad();
        resolve(img);
      };
      img.onerror = () => {
        finishQueuedImageLoad();
        resolve(null);
      };
      img.src = src;
    });
    pumpImageLoadQueue();
  });
}

function pumpImageLoadQueue() {
  while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS) {
    const next = imageLoadQueue.shift();
    if (!next) return;
    activeImageLoads += 1;
    next();
  }
}

function finishQueuedImageLoad() {
  activeImageLoads = Math.max(0, activeImageLoads - 1);
  pumpImageLoadQueue();
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      const width = Math.round(rect.width);
      const height = 0;
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

function useLuminanceMaskImage(image: HTMLImageElement | null, cacheKey = "") {
  const imageKey = cacheKey || image?.currentSrc || image?.src || "";
  const [mask, setMask] = useState<HTMLCanvasElement | null>(() => (imageKey ? readCacheValue(luminanceMaskCache, imageKey, MASK_CACHE_LIMIT) ?? null : null));

  useEffect(() => {
    if (!image) {
      setMask(null);
      return;
    }
    const key = cacheKey || image.currentSrc || image.src;
    const cached = readCacheValue(luminanceMaskCache, key, MASK_CACHE_LIMIT);
    if (cached) {
      setMask(cached);
      return;
    }
    let active = true;
    getLuminanceMaskCanvas(image, key).then((canvas) => {
      if (active) setMask(canvas);
    });
    return () => {
      active = false;
    };
  }, [image, cacheKey]);

  return mask;
}

function getLuminanceMaskCanvas(image: HTMLImageElement, key: string) {
  const cached = readCacheValue(luminanceMaskCache, key, MASK_CACHE_LIMIT);
  if (cached) return Promise.resolve(cached);
  const pending = readCacheValue(luminanceMaskPromiseCache, key, MASK_CACHE_LIMIT);
  if (pending) return pending;

  const promise = createLuminanceMaskCanvas(image)
    .then((canvas) => {
      if (canvas) rememberCacheValue(luminanceMaskCache, key, canvas, MASK_CACHE_LIMIT);
      luminanceMaskPromiseCache.delete(key);
      return canvas;
    })
    .catch(() => {
      luminanceMaskPromiseCache.delete(key);
      const fallback = createLuminanceMaskCanvasSync(image);
      if (fallback) rememberCacheValue(luminanceMaskCache, key, fallback, MASK_CACHE_LIMIT);
      return fallback;
    });
  rememberCacheValue(luminanceMaskPromiseCache, key, promise, MASK_CACHE_LIMIT);
  return promise;
}

async function createLuminanceMaskCanvas(image: HTMLImageElement) {
  if (!("Worker" in window) || !("createImageBitmap" in window) || !("OffscreenCanvas" in window)) {
    return createLuminanceMaskCanvasSync(image);
  }
  const bitmap = await createImageBitmap(image);
  return runMaskWorker(bitmap);
}

function runMaskWorker(bitmap: ImageBitmap) {
  return new Promise<HTMLCanvasElement | null>((resolve, reject) => {
    const worker = getMaskWorker();
    if (!worker) {
      bitmap.close();
      resolve(null);
      return;
    }
    const id = ++maskWorkerRequestId;
    maskWorkerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, bitmap }, [bitmap]);
  });
}

function getMaskWorker() {
  if (maskWorker) return maskWorker;
  try {
    maskWorker = new Worker(new URL("./maskWorker.ts", import.meta.url));
    maskWorker.onmessage = (
      event: MessageEvent<{ id: number; width?: number; height?: number; buffer?: ArrayBuffer; error?: string }>
    ) => {
      const request = maskWorkerRequests.get(event.data.id);
      if (!request) return;
      maskWorkerRequests.delete(event.data.id);
      if (event.data.error || !event.data.buffer || !event.data.width || !event.data.height) {
        request.reject(new Error(event.data.error || "mask worker 返回无效结果。"));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = event.data.width;
      canvas.height = event.data.height;
      const context = canvas.getContext("2d");
      if (!context) {
        request.resolve(null);
        return;
      }
      context.putImageData(new ImageData(new Uint8ClampedArray(event.data.buffer), event.data.width, event.data.height), 0, 0);
      request.resolve(canvas);
    };
    maskWorker.onerror = (event) => {
      const error = new Error(event.message || "mask worker 出错。");
      for (const request of maskWorkerRequests.values()) request.reject(error);
      maskWorkerRequests.clear();
      maskWorker?.terminate();
      maskWorker = null;
    };
    return maskWorker;
  } catch {
    maskWorker = null;
    return null;
  }
}

function createLuminanceMaskCanvasSync(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    const sourceAlpha = data[index + 3];
    const luminanceAlpha = Math.max(data[index], data[index + 1], data[index + 2]);
    const alpha = sourceAlpha < 255 ? sourceAlpha : luminanceAlpha;
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = alpha;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function createOutlineCanvas(source: CanvasImageSource, thickness = 2, color = "#e05252") {
  const img = source as HTMLImageElement | HTMLCanvasElement;
  const width = ("naturalWidth" in img ? img.naturalWidth || img.width : img.width) || 0;
  const height = ("naturalHeight" in img ? img.naturalHeight || img.height : img.height) || 0;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(source, -thickness, -thickness, width + thickness * 2, height + thickness * 2);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function getMirroredTexture(image: TextureImageSource, mirrorX: boolean, mirrorY: boolean) {
  if (!mirrorX && !mirrorY) return image;
  const w = ("naturalWidth" in image ? image.naturalWidth || image.width : image.width) || 1;
  const h = ("naturalHeight" in image ? image.naturalHeight || image.height : image.height) || 1;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return image;
  ctx.translate(mirrorX ? w : 0, mirrorY ? h : 0);
  ctx.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
  ctx.drawImage(image, 0, 0, w, h);
  return canvas;
}

function useLiveDesignCanvasImage(textureImage: TextureImageSource | null, designCanvas: DesignCanvas | null) {
  const imageLayerImages = useDesignLayerImages(designCanvas);
  return useMemo(() => {
    if (!textureImage || !designCanvas) return null;
    const width = Math.max(1, Math.round(designCanvas.width || ("naturalWidth" in textureImage ? textureImage.naturalWidth || textureImage.width : textureImage.width) || 1));
    const height = Math.max(1, Math.round(designCanvas.height || ("naturalHeight" in textureImage ? textureImage.naturalHeight || textureImage.height : textureImage.height) || 1));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    drawDesignTextureBackground(context, textureImage, width, height, designCanvas);
    for (const layer of designCanvas.layers || []) {
      drawDesignLayer(context, layer, imageLayerImages[layer.id] || null);
    }
    return canvas;
  }, [designCanvas, imageLayerImages, textureImage]);
}

function useDesignLayerImages(designCanvas: DesignCanvas | null) {
  const imageLayers = useMemo(
    () => (designCanvas?.layers || []).filter((layer) => layer.visible && layer.type === "image" && layer.source_url),
    [designCanvas?.layers]
  );
  const [images, setImages] = useState<Record<string, HTMLImageElement | null>>({});

  useEffect(() => {
    let active = true;
    if (imageLayers.length === 0) {
      setImages({});
      return;
    }
    Promise.all(imageLayers.map((layer) => loadCachedImage(layer.source_url || "").then((image) => [layer.id, image] as const))).then((entries) => {
      if (!active) return;
      setImages(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [imageLayers]);

  return images;
}

function shouldUseLiveDesignCanvas(designCanvas: DesignCanvas | null | undefined, pieces: Piece[]) {
  if (!designCanvas) return false;
  const hasLayers = (designCanvas.layers || []).some((layer) => layer.visible !== false);
  const hasGlobalPieces = pieces.some((piece) => !piece.mirror_of && piece.transform.mode === "global_canvas" && piece.transform.global_enabled !== false);
  return hasLayers || hasGlobalPieces;
}

function useWorkspacePreviewTexture(textureImage: TextureImageSource | null, designCanvas: DesignCanvas | null | undefined, pieces: Piece[]) {
  const liveDesignCanvas = shouldUseLiveDesignCanvas(designCanvas, pieces) ? designCanvas || null : null;
  const designTextureImage = useLiveDesignCanvasImage(textureImage, liveDesignCanvas);
  return designTextureImage || textureImage;
}

function drawDesignTextureBackground(
  context: CanvasRenderingContext2D,
  image: TextureImageSource,
  width: number,
  height: number,
  designCanvas: DesignCanvas
) {
  const tileSource = designCanvas.mirror && "naturalWidth" in image ? makeMirrorTileCanvas(image) : image;
  const sourceWidth = ("naturalWidth" in tileSource ? tileSource.naturalWidth || tileSource.width : tileSource.width) || 1;
  const sourceHeight = ("naturalHeight" in tileSource ? tileSource.naturalHeight || tileSource.height : tileSource.height) || 1;
  const scale = Math.max(0.05, Number(designCanvas.texture_scale || 1));
  const tileWidth = Math.max(1, Math.round(sourceWidth * scale));
  const tileHeight = Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = Number(designCanvas.texture_offset_x || 0);
  const offsetY = Number(designCanvas.texture_offset_y || 0);

  if (designCanvas.tile === false) {
    context.drawImage(tileSource, Math.round((width - tileWidth) / 2 + offsetX), Math.round((height - tileHeight) / 2 + offsetY), tileWidth, tileHeight);
    return;
  }

  const startX = -tileWidth + positiveModulo(offsetX, tileWidth);
  const startY = -tileHeight + positiveModulo(offsetY, tileHeight);
  for (let y = startY; y < height + tileHeight; y += tileHeight) {
    for (let x = startX; x < width + tileWidth; x += tileWidth) {
      context.drawImage(tileSource, x, y, tileWidth, tileHeight);
    }
  }
}

function drawDesignLayer(context: CanvasRenderingContext2D, layer: DesignLayer, image: HTMLImageElement | null) {
  if (!layer.visible) return;
  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, Number(layer.opacity ?? 1)));
  context.translate(layer.x, layer.y);
  if (layer.rotation) {
    context.translate(layer.width / 2, layer.height / 2);
    context.rotate((layer.rotation * Math.PI) / 180);
    context.translate(-layer.width / 2, -layer.height / 2);
  }
  if (layer.type === "image" && image) {
    context.drawImage(image, 0, 0, layer.width, layer.height);
  } else if (layer.type === "text" && layer.content) {
    const fontSize = Math.max(8, Number(layer.font_size || 96));
    context.font = `${layer.font_weight === "700" ? "700" : "400"} ${fontSize}px sans-serif`;
    context.textBaseline = "top";
    context.lineJoin = "round";
    const lines = String(layer.content).split("\n");
    const lineHeight = Math.max(fontSize, fontSize * 1.18);
    lines.forEach((line, index) => {
      const y = index * lineHeight;
      if (layer.stroke && (layer.stroke_width || 0) > 0) {
        context.strokeStyle = layer.stroke;
        context.lineWidth = layer.stroke_width || 0;
        context.strokeText(line, 0, y, layer.width);
      }
      context.fillStyle = layer.fill || "#111111";
      context.fillText(line, 0, y, layer.width);
    });
  }
  context.restore();
}

type Props = {
  pieces: Piece[];
  selectedPieceId: string;
  textureUrl: string;
  showOutlines: boolean;
  onSelectPiece: (id: string) => void;
  onToggleOutlines: (visible: boolean) => void;
  onMovePiece: (piece: Piece, x: number, y: number) => void;
};

export function KonvaWorkspace({ pieces, selectedPieceId, textureUrl, showOutlines, onSelectPiece, onToggleOutlines, onMovePiece }: Props) {
  return (
    <div className="grid min-h-[760px] grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.1fr)] gap-4 max-[1280px]:grid-cols-1">
      <SinglePieceCalibration
        pieces={pieces}
        selectedPieceId={selectedPieceId}
        textureUrl={textureUrl}
        showOutlines={showOutlines}
        onToggleOutlines={onToggleOutlines}
        onMovePiece={onMovePiece}
      />
      <LayoutPreview
        pieces={pieces}
        selectedPieceId={selectedPieceId}
        textureUrl={textureUrl}
        showOutlines={showOutlines}
        onSelectPiece={onSelectPiece}
      />
    </div>
  );
}

type SinglePieceCalibrationProps = {
  pieces: Piece[];
  selectedPieceId: string;
  textureUrl: string;
  showOutlines: boolean;
  outlineWidth?: number;
  designCanvas?: DesignCanvas | null;
  onToggleOutlines: (visible: boolean) => void;
  onOutlineWidthChange?: (width: number) => void;
  onMovePiece: (piece: Piece, x: number, y: number) => void;
  onPatchTransform?: (transform: Partial<Piece["transform"]>) => void;
  onResetPiece?: () => void;
  compact?: boolean;
  pieceZoom?: number;
  dragSnapEnabled?: boolean;
};

export function SinglePieceToolbar({
  showOutlines,
  outlineWidth = 1,
  designCanvas,
  pieceZoom = 1,
  dragSnapEnabled = true,
  onToggleOutlines,
  onOutlineWidthChange = () => {},
  onZoomIn,
  onZoomOut,
  onToggleDragSnap = () => {}
}: {
  showOutlines: boolean;
  outlineWidth?: number;
  designCanvas?: DesignCanvas | null;
  pieceZoom?: number;
  dragSnapEnabled?: boolean;
  onToggleOutlines: (visible: boolean) => void;
  onOutlineWidthChange?: (width: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleDragSnap: (enabled: boolean) => void;
}) {
  const snapSettings = useMemo(() => textureSnapSettings(designCanvas ?? null), [designCanvas]);
  return (
    <div className="flex items-center gap-2">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-ink ring-1 ring-line">
        <input type="checkbox" className="peer sr-only" checked={showOutlines} onChange={(event) => onToggleOutlines(event.target.checked)} />
        <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-slate-200 transition peer-checked:bg-jade">
          <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition peer-checked:translate-x-5" />
        </span>
        显示线框
      </label>
      {showOutlines && (
        <select
          className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm font-semibold text-ink"
          value={outlineWidth}
          onChange={(event) => onOutlineWidthChange(Number(event.target.value))}
        >
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => (
            <option key={v} value={v}>{v}px</option>
          ))}
        </select>
      )}
      <label className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-line ${snapSettings ? "cursor-pointer bg-white text-ink" : "cursor-not-allowed bg-slate-100 text-slate-400"}`}>
        <input
          type="checkbox"
          className="peer sr-only"
          checked={dragSnapEnabled && Boolean(snapSettings)}
          onChange={(event) => onToggleDragSnap(event.target.checked)}
          disabled={!snapSettings}
        />
        <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-slate-200 transition peer-checked:bg-action">
          <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition peer-checked:translate-x-5" />
        </span>
        拖动吸附
      </label>
      <ZoomButton label="-" onClick={onZoomOut} />
      <span className="min-w-14 rounded-md bg-mist px-2 py-1.5 text-center text-sm text-slate-600">{Math.round(pieceZoom * 100)}%</span>
      <ZoomButton label="+" onClick={onZoomIn} />
    </div>
  );
}

export function SinglePieceCalibration({ pieces, selectedPieceId, textureUrl, showOutlines, outlineWidth = 1, designCanvas, onToggleOutlines, onOutlineWidthChange = () => {}, onMovePiece, onPatchTransform, onResetPiece, compact = false, pieceZoom = 1, dragSnapEnabled = true }: SinglePieceCalibrationProps) {
  const textureImage = useLoadedImage(textureUrl);
  const previewTextureImage = useWorkspacePreviewTexture(textureImage, designCanvas, pieces);
  const selected = pieces.find((piece) => piece.id === selectedPieceId) ?? pieces[0];
  const maskImage = useLoadedImage(selected?.mask_url || "");
  const selectedMaskKey = selected?.mask_url || "";
  const alphaMaskImage = useLuminanceMaskImage(maskImage, selectedMaskKey);
  const outlineImage = useMemo(() => {
    if (!alphaMaskImage) return null;
    return createOutlineCanvas(alphaMaskImage, outlineWidth, "#e05252");
  }, [alphaMaskImage, outlineWidth]);
  const [stageWrapRef, stageWrapSize] = useElementSize<HTMLDivElement>();
  const stageWidth = Math.max(320, Math.round(stageWrapSize.width || 520));
  const stageHeight = compact ? WORKSPACE_CANVAS_HEIGHT : Math.max(440, Math.min(WORKSPACE_CANVAS_HEIGHT, Math.round(stageWidth * 1.22)));
  const selectedMaskFrame = useMemo(() => {
    if (!selected) return null;
    const innerWidth = Math.max(1, stageWidth - 80);
    const innerHeight = Math.max(1, stageHeight - 80);
    const scale = Math.min(innerWidth / Math.max(1, selected.width), innerHeight / Math.max(1, selected.height));
    const width = Math.max(1, selected.width * scale);
    const height = Math.max(1, selected.height * scale);
    return { x: (stageWidth - width) / 2, y: (stageHeight - height) / 2, width, height };
  }, [selected, stageHeight, stageWidth]);
  const [activeToolbarPopover, setActiveToolbarPopover] = useState("");
  const [dragPreviewOffset, setDragPreviewOffset] = useState<{ pieceId: string; x: number; y: number } | null>(null);
  const [localZoom, setLocalZoom] = useState(1);
  const [localSnap, setLocalSnap] = useState(true);
  const effectiveZoom = compact ? pieceZoom : localZoom;
  const effectiveSnap = compact ? dragSnapEnabled : localSnap;
  const snapSettings = useMemo(() => textureSnapSettings(designCanvas ?? null), [designCanvas]);
  const activeSnapSettings = effectiveSnap ? snapSettings : null;
  const displayPiece = useMemo(() => {
    if (!selected || dragPreviewOffset?.pieceId !== selected.id) return selected;
    return {
      ...selected,
      transform: {
        ...selected.transform,
        offset_x: dragPreviewOffset.x,
        offset_y: dragPreviewOffset.y
      }
    };
  }, [dragPreviewOffset, selected]);

  const canvas = (
    <div ref={stageWrapRef} className="relative overflow-hidden rounded-lg border border-line bg-white">
      <Stage width={stageWidth} height={stageHeight}>
        <Layer>
          <Rect x={0} y={0} width={stageWidth} height={stageHeight} fill="#ffffff" />
          {!selected && <Text x={Math.max(24, stageWidth / 2 - 100)} y={stageHeight / 2 - 12} text="请先选择套装！" fill="#64748b" fontSize={18} />}
          {selected && !textureImage && <Text x={Math.max(24, stageWidth / 2 - 120)} y={stageHeight / 2 - 12} text="请上传图案或处理面料" fill="#64748b" fontSize={18} />}
        </Layer>
        {previewTextureImage && displayPiece && selectedMaskFrame && (
          <DimmedTextureLayer
            piece={displayPiece}
            textureImage={previewTextureImage}
            frame={selectedMaskFrame}
            zoom={effectiveZoom}
            stageWidth={stageWidth}
            stageHeight={stageHeight}
          />
        )}
        {previewTextureImage && displayPiece && alphaMaskImage && selectedMaskFrame && (
          <ClippedTextureLayer
            piece={displayPiece}
            textureImage={previewTextureImage}
            maskImage={alphaMaskImage}
            frame={selectedMaskFrame}
            zoom={effectiveZoom}
            draggable={!displayPiece.mirror_of}
            opacity={displayPiece.mirror_of ? 0.45 : 1}
            snapSettings={activeSnapSettings}
            onPreviewMove={(x, y) => setDragPreviewOffset({ pieceId: displayPiece.id, x, y })}
            onMove={(x, y) => {
              setDragPreviewOffset(null);
              onMovePiece(selected, x, y);
            }}
            onMoveCancel={() => setDragPreviewOffset(null)}
          />
        )}
        {showOutlines && outlineImage && selectedMaskFrame && (
          <Layer scaleX={effectiveZoom} scaleY={effectiveZoom}>
            <KonvaImage
              image={outlineImage}
              x={selectedMaskFrame.x}
              y={selectedMaskFrame.y}
              width={selectedMaskFrame.width}
              height={selectedMaskFrame.height}
              listening={false}
            />
          </Layer>
        )}
      </Stage>
      {selected && onPatchTransform && !selected.mirror_of && (
        <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2">
          <ToolbarLockButton popoverId="single-lock" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} locked={selected.transform.locked} onToggle={() => onPatchTransform({ locked: !selected.transform.locked })} />
          {onResetPiece && (
            <ToolbarResetButton popoverId="single-reset" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} onReset={onResetPiece} disabled={selected.transform.locked} />
          )}
          <ToolbarSnapButton
            popoverId="single-snap"
            activePopover={activeToolbarPopover}
            setActivePopover={setActiveToolbarPopover}
            disabled={selected.transform.locked}
            designCanvas={designCanvas ?? null}
            piece={selected}
            onPatchTransform={onPatchTransform}
          />
          <ToolbarCenterButton
            popoverId="single-center"
            activePopover={activeToolbarPopover}
            setActivePopover={setActiveToolbarPopover}
            disabled={selected.transform.locked}
            piece={selected}
            onPatchTransform={onPatchTransform}
          />
          <ToolbarOrientationButton
            popoverId="single-orientation"
            activePopover={activeToolbarPopover}
            setActivePopover={setActiveToolbarPopover}
            disabled={selected.transform.locked}
            piece={selected}
            onPatchTransform={onPatchTransform}
          />
          <PieceToolbarButton popoverId="single-x" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="X" value={selected.transform.offset_x ?? 0} disabled={selected.transform.locked}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">平移 X</span>
              <span className="text-sm font-bold">{selected.transform.offset_x ?? 0}</span>
            </div>
            <input
              type="range"
              min={-2048}
              max={2048}
              value={selected.transform.offset_x ?? 0}
              onChange={(e) => onPatchTransform({ offset_x: Number(e.target.value) })}
              disabled={selected.transform.locked}
              className="w-full accent-action"
            />
            <p className="mt-1.5 text-xs leading-5 text-slate-500">左右移动裁片中的布料取样位置。</p>
          </PieceToolbarButton>
          <PieceToolbarButton popoverId="single-y" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="Y" value={selected.transform.offset_y ?? 0} disabled={selected.transform.locked}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">平移Y</span>
              <span className="text-sm font-bold">{selected.transform.offset_y ?? 0}</span>
            </div>
            <input
              type="range"
              min={-2048}
              max={2048}
              value={selected.transform.offset_y ?? 0}
              onChange={(e) => onPatchTransform({ offset_y: Number(e.target.value) })}
              disabled={selected.transform.locked}
              className="w-full accent-action"
            />
            <p className="mt-1.5 text-xs leading-5 text-slate-500">上下移动裁片中的布料取样位置。</p>
          </PieceToolbarButton>
          <PieceToolbarButton popoverId="single-scale" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="缩" value={selected.transform.scale} disabled={selected.transform.locked}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">单片缩放</span>
              <span className="text-sm font-bold">{selected.transform.scale.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.2}
              max={6}
              step={0.01}
              value={selected.transform.scale}
              onChange={(e) => onPatchTransform({ scale: Number(e.target.value) })}
              disabled={selected.transform.locked}
              className="w-full accent-action"
            />
            <p className="mt-1.5 text-xs leading-5 text-slate-500">叠加在全局设计画布之后，只影响当前裁片，默认保持 1。</p>
          </PieceToolbarButton>
          <PieceToolbarButton popoverId="single-rotate" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="转" value={selected.transform.rotation} disabled={selected.transform.locked}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-semibold">单片旋转</span>
              <span className="text-sm font-bold">{selected.transform.rotation}</span>
            </div>
            <input
              type="range"
              min={-180}
              max={180}
              value={selected.transform.rotation}
              onChange={(e) => onPatchTransform({ rotation: Number(e.target.value) })}
              disabled={selected.transform.locked}
              className="w-full accent-action"
            />
            <p className="mt-1.5 text-xs leading-5 text-slate-500">叠加在全局设计画布方向之后，只影响当前裁片，默认保持 0。</p>
          </PieceToolbarButton>
        </div>
      )}
    </div>
  );

  if (compact) {
    return canvas;
  }

  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">单裁片校正</h2>
          <p className="m-0 mt-1 text-sm text-slate-500">拖动裁片中的布料，微调重点花位。</p>
        </div>
        <SinglePieceToolbar
          showOutlines={showOutlines}
          outlineWidth={outlineWidth}
          designCanvas={designCanvas}
          pieceZoom={localZoom}
          dragSnapEnabled={localSnap}
          onToggleOutlines={onToggleOutlines}
          onOutlineWidthChange={onOutlineWidthChange}
          onZoomIn={() => setLocalZoom((z) => clampZoom(z + 0.1))}
          onZoomOut={() => setLocalZoom((z) => clampZoom(z - 0.1))}
          onToggleDragSnap={setLocalSnap}
        />
      </div>
      {canvas}
    </section>
  );
}

type LayoutPreviewProps = {
  pieces: Piece[];
  selectedPieceId: string;
  textureUrl: string;
  designCanvas?: DesignCanvas | null;
  selectedLayerId?: string;
  showOutlines: boolean;
  outlineWidth?: number;
  onSelectPiece: (id: string) => void;
  onSelectLayer?: (id: string) => void;
  onMoveDesignRegion?: (piece: Piece, update: Partial<Piece["transform"]>) => void;
  onMoveLayer?: (layer: DesignLayer, update: Partial<DesignLayer>) => void;
  globalTextureScale?: number;
  textureAngle?: number;
  globalOffsetX?: number;
  globalOffsetY?: number;
  onGlobalTextureScaleChange?: (value: number) => void;
  onTextureAngleChange?: (value: number) => void;
  onGlobalOffsetXChange?: (value: number) => void;
  onGlobalOffsetYChange?: (value: number) => void;
  onApplyGlobalFit?: () => void;
  onResetGlobalFit?: () => void;
  canApplyGlobalFit?: boolean;
  locked?: boolean;
  onToggleLocked?: () => void;
};

export function LayoutPreview({
  pieces,
  selectedPieceId,
  textureUrl,
  designCanvas,
  selectedLayerId = "",
  showOutlines,
  outlineWidth = 1,
  onSelectPiece,
  onSelectLayer = () => {},
  onMoveDesignRegion = () => {},
  onMoveLayer = () => {},
  globalTextureScale = 1,
  textureAngle = 0,
  globalOffsetX = 0,
  globalOffsetY = 0,
  onGlobalTextureScaleChange = () => {},
  onTextureAngleChange = () => {},
  onGlobalOffsetXChange = () => {},
  onGlobalOffsetYChange = () => {},
  onApplyGlobalFit = () => {},
  onResetGlobalFit = () => {},
  canApplyGlobalFit = false,
  locked = false,
  onToggleLocked = () => {}
}: LayoutPreviewProps) {
  const textureImage = useLoadedImage(textureUrl);
  const previewTextureImage = useWorkspacePreviewTexture(textureImage, designCanvas, pieces);
  const [layoutZoom, setLayoutZoom] = useState(0.25);
  const [designZoom, setDesignZoom] = useState(0.25);
  const [previewMode, setPreviewMode] = useState<"layout" | "design">("layout");
  const [dragSnapEnabled, setDragSnapEnabled] = useState(true);
  const [previewWrapRef, previewWrapSize] = useElementSize<HTMLDivElement>();
  const layoutBounds = useMemo(() => {
    const width = Math.max(1200, ...pieces.map((piece) => piece.source_x + piece.width + 80), 1200);
    const height = Math.max(760, ...pieces.map((piece) => piece.source_y + piece.height + 80), 760);
    return { width, height };
  }, [pieces]);
  const designBounds = useMemo(
    () => ({
      width: Math.max(1200, designCanvas?.width || textureImage?.naturalWidth || 1200),
      height: Math.max(760, designCanvas?.height || textureImage?.naturalHeight || 760)
    }),
    [designCanvas, textureImage]
  );
  const layoutFitZoom = useMemo(() => {
    const maxWidth = Math.max(360, previewWrapSize.width || 980);
    const maxHeight = WORKSPACE_CANVAS_HEIGHT;
    const next = Math.min(maxWidth / layoutBounds.width, maxHeight / layoutBounds.height, 1);
    return Math.max(0.05, Number(next.toFixed(2)));
  }, [layoutBounds, previewWrapSize.width]);
  const designFitZoom = useMemo(() => {
    const maxWidth = Math.max(360, previewWrapSize.width || 980);
    const maxHeight = WORKSPACE_CANVAS_HEIGHT;
    const next = Math.min(maxWidth / designBounds.width, maxHeight / designBounds.height, 1);
    return Math.max(0.05, Number(next.toFixed(2)));
  }, [designBounds, previewWrapSize.width]);
  const currentZoom = previewMode === "design" ? designZoom : layoutZoom;
  const snapSettings = useMemo(() => textureSnapSettings(designCanvas ?? null), [designCanvas]);
  const activeSnapSettings = dragSnapEnabled ? snapSettings : null;
  const updateCurrentZoom = (updater: (zoom: number) => number) => {
    if (previewMode === "design") {
      setDesignZoom(updater);
    } else {
      setLayoutZoom(updater);
    }
  };
  const [activeToolbarPopover, setActiveToolbarPopover] = useState("");

  useEffect(() => {
    setLayoutZoom(layoutFitZoom);
  }, [layoutFitZoom]);

  useEffect(() => {
    setDesignZoom(designFitZoom);
  }, [designFitZoom]);

  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">{previewMode === "design" ? "全局设计画布" : "整套排版"}</h2>
          <p className="m-0 mt-1 text-sm text-slate-500">
            {previewMode === "design" ? "查看裁片在全局设计画布中的位置。" : "按模板原始坐标回排，导出时保持同一坐标系。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="rounded-md bg-mist px-2 py-1.5 text-sm text-slate-600">{pieces.length} 个裁片</span>
          <ZoomButton label="排版" active={previewMode === "layout"} onClick={() => setPreviewMode("layout")} />
          <ZoomButton label="设计画布" active={previewMode === "design"} onClick={() => setPreviewMode("design")} />
          {previewMode === "design" && (
            <label className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-line ${snapSettings ? "cursor-pointer bg-white text-ink" : "cursor-not-allowed bg-slate-100 text-slate-400"}`}>
              <input
                type="checkbox"
                className="peer sr-only"
                checked={dragSnapEnabled && Boolean(snapSettings)}
                onChange={(event) => setDragSnapEnabled(event.target.checked)}
                disabled={!snapSettings}
              />
              <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-slate-200 transition peer-checked:bg-action">
                <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition peer-checked:translate-x-5" />
              </span>
              拖动吸附
            </label>
          )}
          <ZoomButton label="-" onClick={() => updateCurrentZoom((zoom) => clampZoom(zoom - 0.05))} />
          <span className="min-w-14 rounded-md bg-mist px-2 py-1.5 text-center text-sm text-slate-600">{Math.round(currentZoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => updateCurrentZoom((zoom) => clampZoom(zoom + 0.05))} />
          <ZoomButton label="100%" onClick={() => updateCurrentZoom(() => 1)} />
        </div>
      </div>
      <div ref={previewWrapRef} className="relative flex h-[640px] justify-center overflow-auto rounded-lg border border-line bg-white">
        {pieces.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-lg text-slate-500">
            请先选择套装！
          </div>
        )}
        <div className={previewMode === "layout" ? "block shrink-0" : "hidden shrink-0"}>
          <Stage width={Math.ceil(layoutBounds.width * layoutZoom)} height={Math.max(WORKSPACE_CANVAS_HEIGHT, Math.ceil(layoutBounds.height * layoutZoom))}>
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              <Rect x={0} y={0} width={layoutBounds.width} height={layoutBounds.height} fill="#ffffff" />
            </Layer>
            {previewTextureImage &&
              pieces.map((piece) => (
                <LayoutPieceTexture
                  key={`texture-${piece.id}`}
                  piece={piece}
                  sourcePiece={piece.mirror_of ? pieces.find((item) => item.id === piece.mirror_of) : undefined}
                  textureImage={previewTextureImage}
                  selected={piece.id === selectedPieceId}
                  zoom={layoutZoom}
                  onSelect={() => onSelectPiece(piece.id)}
                />
              ))}
            {selectedPieceId && (
              <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
                {pieces
                  .filter((piece) => piece.id === selectedPieceId)
                  .map((piece) => (
                    <PieceOutline
                      key={`selected-outline-${piece.id}`}
                      piece={piece}
                      selected
                      outlineWidth={Math.max(2, outlineWidth)}
                      onSelect={() => onSelectPiece(piece.id)}
                    />
                  ))}
              </Layer>
            )}
          </Stage>
        </div>
        <div className={previewMode === "design" ? "block shrink-0" : "hidden shrink-0"}>
          <Stage width={Math.ceil(designBounds.width * designZoom)} height={Math.max(WORKSPACE_CANVAS_HEIGHT, Math.ceil(designBounds.height * designZoom))}>
            <Layer scaleX={designZoom} scaleY={designZoom}>
              <Rect x={0} y={0} width={designBounds.width} height={designBounds.height} fill="#ffffff" />
              {textureImage && (
                <DesignTextureBackground
                  image={textureImage}
                  width={designBounds.width}
                  height={designBounds.height}
                  designCanvas={designCanvas || null}
                  directImage={false}
                />
              )}
            </Layer>
            <Layer scaleX={designZoom} scaleY={designZoom}>
              {(designCanvas?.layers || []).map((layer) => (
                <DesignLayerNode
                  key={layer.id}
                  layer={layer}
                  selected={layer.id === selectedLayerId}
                  onSelect={() => onSelectLayer(layer.id)}
                  onMove={(update) => onMoveLayer(layer, update)}
                />
              ))}
            </Layer>
            {showOutlines && (
              <Layer scaleX={designZoom} scaleY={designZoom}>
                {pieces.map((piece) => (
                  <DesignRegionOutline
                    key={`design-${piece.id}`}
                    piece={piece}
                    selected={piece.id === selectedPieceId}
                    outlineWidth={outlineWidth}
                    zoom={designZoom}
                    snapSettings={activeSnapSettings}
                    onSelect={() => onSelectPiece(piece.id)}
                    onChange={(update) => onMoveDesignRegion(piece, update)}
                  />
                ))}
              </Layer>
            )}
          </Stage>
        </div>
        {previewMode === "design" && pieces.length > 0 && (
          <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2">
            <ToolbarLockButton popoverId="layout-lock" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} locked={locked} onToggle={onToggleLocked} />
            <ToolbarResetButton popoverId="layout-reset" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} onReset={onResetGlobalFit} disabled={locked} />
            <PieceToolbarButton popoverId="layout-x" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="X" value={globalOffsetX} disabled={locked}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">全局平移 X</span>
                <span className="text-sm font-bold">{globalOffsetX}</span>
              </div>
              <input
                type="range"
                min={-2048}
                max={2048}
                value={globalOffsetX}
                onChange={(e) => onGlobalOffsetXChange(Number(e.target.value))}
                disabled={locked}
                className="w-full accent-action"
              />
              <p className="mt-1.5 text-xs leading-5 text-slate-500">左右移动整张设计画布。</p>
            </PieceToolbarButton>
            <PieceToolbarButton popoverId="layout-y" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="Y" value={globalOffsetY} disabled={locked}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">全局平移 Y</span>
                <span className="text-sm font-bold">{globalOffsetY}</span>
              </div>
              <input
                type="range"
                min={-2048}
                max={2048}
                value={globalOffsetY}
                onChange={(e) => onGlobalOffsetYChange(Number(e.target.value))}
                disabled={locked}
                className="w-full accent-action"
              />
              <p className="mt-1.5 text-xs leading-5 text-slate-500">上下移动整张设计画布。</p>
            </PieceToolbarButton>
            <PieceToolbarButton popoverId="layout-scale" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="缩" value={globalTextureScale.toFixed(2)} disabled={locked}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">全局缩放</span>
                <span className="text-sm font-bold">{globalTextureScale.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={4}
                step={0.05}
                value={globalTextureScale}
                onChange={(e) => onGlobalTextureScaleChange(Number(e.target.value))}
                disabled={locked}
                className="w-full accent-action"
              />
              <p className="mt-1.5 text-xs leading-5 text-slate-500">控制整张设计画布的花纹大小和密度，默认 1。</p>
            </PieceToolbarButton>
            <PieceToolbarButton popoverId="layout-rotate" activePopover={activeToolbarPopover} setActivePopover={setActiveToolbarPopover} label="转" value={textureAngle} disabled={locked}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">全局旋转</span>
                <span className="text-sm font-bold">{textureAngle}</span>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                value={textureAngle}
                onChange={(e) => onTextureAngleChange(Number(e.target.value))}
                disabled={locked}
                className="w-full accent-action"
              />
              <p className="mt-1.5 text-xs leading-5 text-slate-500">控制整张设计画布的面料方向，默认 0 度。</p>
            </PieceToolbarButton>
            <button
              className="flex h-9 w-9 items-center justify-center rounded-full bg-jade text-xs font-bold text-white shadow ring-1 ring-jade transition hover:-translate-y-0.5 disabled:opacity-50"
              disabled={!canApplyGlobalFit || locked}
              onClick={onApplyGlobalFit}
              title="应用全局设计画布"
            >
              用
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function DesignRegionOutline({
  piece,
  selected,
  outlineWidth,
  zoom,
  snapSettings,
  onSelect,
  onChange
}: {
  piece: Piece;
  selected: boolean;
  outlineWidth: number;
  zoom: number;
  snapSettings?: TextureSnapSettings | null;
  onSelect: () => void;
  onChange: (update: Partial<Piece["transform"]>) => void;
}) {
  const offsetX = piece.transform.offset_x || 0;
  const offsetY = piece.transform.offset_y || 0;
  const x = (piece.transform.design_x ?? piece.source_x) + offsetX;
  const y = (piece.transform.design_y ?? piece.source_y) + offsetY;
  const width = piece.width;
  const height = piece.height;
  const locked = Boolean(piece.transform.locked);
  const isLinked = Boolean(piece.mirror_of);
  return (
    <>
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        stroke={selected ? "#e05252" : "rgba(224,82,82,0.65)"}
        strokeWidth={outlineWidth}
        opacity={isLinked ? 0.35 : 1}
        strokeScaleEnabled={false}
        dash={selected ? [] : [12, 8]}
        draggable={selected && !locked && !isLinked}
        onClick={onSelect}
        onTap={onSelect}
        onDragMove={(event) => {
          if (!snapSettings) return;
          const snapped = snapDesignRegionPosition({
            sampleX: event.target.x(),
            sampleY: event.target.y(),
            offsetX,
            offsetY,
            ...snapSettings,
          });
          event.target.x(snapped.sampleX);
          event.target.y(snapped.sampleY);
        }}
        onDragEnd={(event) => {
          event.cancelBubble = true;
          const snapped = snapSettings
            ? snapDesignRegionPosition({
                sampleX: event.target.x(),
                sampleY: event.target.y(),
                offsetX,
                offsetY,
                ...snapSettings,
              })
            : { sampleX: event.target.x(), sampleY: event.target.y() };
          event.target.x(snapped.sampleX);
          event.target.y(snapped.sampleY);
          onChange({ design_x: Math.round(snapped.sampleX - offsetX), design_y: Math.round(snapped.sampleY - offsetY) });
        }}
      />
      <Text
        x={x}
        y={y + height + 8}
        width={width}
        text={piece.name}
        fill={selected ? "#e05252" : "rgba(224,82,82,0.9)"}
        fontSize={Math.max(18, 14 / Math.max(zoom, 0.05))}
        align="center"
        onClick={onSelect}
        onTap={onSelect}
      />
    </>
  );
}

function DesignTextureBackground({
  image,
  width,
  height,
  designCanvas,
  directImage
}: {
  image: HTMLImageElement;
  width: number;
  height: number;
  designCanvas: DesignCanvas | null;
  directImage: boolean;
}) {
  const tileSource = useMemo(() => {
    if (directImage) return image;
    if (!designCanvas?.mirror) return image;
    return makeMirrorTileCanvas(image);
  }, [designCanvas?.mirror, directImage, image]);

  const tiles = useMemo(() => {
    const sourceWidth = tileSource.width || image.naturalWidth || image.width;
    const sourceHeight = tileSource.height || image.naturalHeight || image.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) return [];

    if (directImage) {
      return [{ key: "direct", x: 0, y: 0, width, height }];
    }

    const scale = Math.max(0.05, Number(designCanvas?.texture_scale || 1));
    const tileWidth = Math.max(1, Math.round(sourceWidth * scale));
    const tileHeight = Math.max(1, Math.round(sourceHeight * scale));
    const tileEnabled = designCanvas?.tile !== false;
    if (!tileEnabled) {
      const offsetX = Number(designCanvas?.texture_offset_x || 0);
      const offsetY = Number(designCanvas?.texture_offset_y || 0);
      return [
        {
          key: "single",
          x: Math.round((width - tileWidth) / 2 + offsetX),
          y: Math.round((height - tileHeight) / 2 + offsetY),
          width: tileWidth,
          height: tileHeight
        }
      ];
    }

    const offsetX = Number(designCanvas?.texture_offset_x || 0);
    const offsetY = Number(designCanvas?.texture_offset_y || 0);
    const startX = -tileWidth + positiveModulo(offsetX, tileWidth);
    const startY = -tileHeight + positiveModulo(offsetY, tileHeight);
    const nextTiles: Array<{ key: string; x: number; y: number; width: number; height: number }> = [];
    for (let y = startY; y < height + tileHeight && nextTiles.length < 500; y += tileHeight) {
      for (let x = startX; x < width + tileWidth && nextTiles.length < 500; x += tileWidth) {
        nextTiles.push({ key: `${x}:${y}`, x, y, width: tileWidth, height: tileHeight });
      }
    }
    return nextTiles;
  }, [
    designCanvas?.texture_offset_x,
    designCanvas?.texture_offset_y,
    designCanvas?.texture_scale,
    designCanvas?.tile,
    directImage,
    height,
    image.height,
    image.naturalHeight,
    image.naturalWidth,
    image.width,
    tileSource,
    width
  ]);

  return (
    <>
      {tiles.map((tile) => (
        <KonvaImage key={tile.key} image={tileSource} x={tile.x} y={tile.y} width={tile.width} height={tile.height} listening={false} />
      ))}
    </>
  );
}

function makeMirrorTileCanvas(image: TextureImageSource) {
  const sourceWidth = textureSourceWidth(image);
  const sourceHeight = textureSourceHeight(image);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, sourceWidth * 2);
  canvas.height = Math.max(1, sourceHeight * 2);
  const context = canvas.getContext("2d");
  if (!context) return image;

  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  context.save();
  context.translate(sourceWidth * 2, 0);
  context.scale(-1, 1);
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  context.restore();
  context.save();
  context.translate(0, sourceHeight * 2);
  context.scale(1, -1);
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  context.restore();
  context.save();
  context.translate(sourceWidth * 2, sourceHeight * 2);
  context.scale(-1, -1);
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  context.restore();
  return canvas;
}

function positiveModulo(value: number, size: number) {
  if (!Number.isFinite(value) || size <= 0) return 0;
  return ((value % size) + size) % size;
}

function DesignLayerNode({ layer, selected, onSelect, onMove }: { layer: DesignLayer; selected: boolean; onSelect: () => void; onMove: (update: Partial<DesignLayer>) => void }) {
  const image = useLoadedImage(layer.type === "image" ? layer.source_url || "" : "");
  if (!layer.visible) return null;
  if (layer.type === "image" && image) {
    return (
      <>
        <KonvaImage
          image={image}
          x={layer.x}
          y={layer.y}
          width={layer.width}
          height={layer.height}
          rotation={layer.rotation}
          opacity={layer.opacity}
          draggable={!layer.locked}
          onClick={onSelect}
          onTap={onSelect}
          onDragEnd={(event) => onMove({ x: Math.round(event.target.x()), y: Math.round(event.target.y()) })}
        />
        {selected && <Rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} stroke="#14b8a6" strokeWidth={3} dash={[8, 6]} listening={false} />}
      </>
    );
  }
  if (layer.type === "text") {
    return (
      <>
        <Text
          x={layer.x}
          y={layer.y}
          width={layer.width}
          height={layer.height}
          text={layer.content || ""}
          fontSize={layer.font_size || 96}
          fontStyle={layer.font_weight === "700" ? "bold" : "normal"}
          fill={layer.fill || "#111111"}
          stroke={layer.stroke || ""}
          strokeWidth={layer.stroke_width || 0}
          rotation={layer.rotation}
          opacity={layer.opacity}
          draggable={!layer.locked}
          onClick={onSelect}
          onTap={onSelect}
          onDragEnd={(event) => onMove({ x: Math.round(event.target.x()), y: Math.round(event.target.y()) })}
        />
        {selected && <Rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} stroke="#14b8a6" strokeWidth={3} dash={[8, 6]} listening={false} />}
      </>
    );
  }
  return null;
}

function clampZoom(value: number) {
  return Math.min(2, Math.max(0.05, Number(value.toFixed(2))));
}

function ZoomButton({ label, onClick, active }: { label: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      className={`rounded-lg px-3 py-1.5 text-sm font-semibold ring-1 ring-line ${
        active ? "bg-ink text-white" : "bg-white text-ink"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

type ToolbarPopoverProps = {
  popoverId: string;
  activePopover: string;
  setActivePopover: (value: SetStateAction<string>) => void;
};

function useToolbarPopover({ popoverId, activePopover, setActivePopover }: ToolbarPopoverProps, disabled = false) {
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = activePopover === popoverId;

  useEffect(() => {
    if (disabled && visible) setActivePopover("");
  }, [disabled, setActivePopover, visible]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const open = () => {
    if (disabled) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setActivePopover(popoverId);
  };

  const close = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setActivePopover((current) => (current === popoverId ? "" : current));
      closeTimerRef.current = null;
    }, 320);
  };

  return { visible, open, close };
}

function PieceToolbarButton({ popoverId, activePopover, setActivePopover, label, value, children, disabled }: ToolbarPopoverProps & { label: string; value: string | number; children: ReactNode; disabled?: boolean }) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover }, Boolean(disabled));
  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        disabled={disabled}
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 ring-line transition hover:-translate-y-0.5 ${
          disabled ? "bg-slate-100 text-slate-400" : "bg-white text-ink hover:bg-slate-50"
        }`}
      >
        {label}
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        {children}
      </div>
    </div>
  );
}

function ToolbarLockButton({ popoverId, activePopover, setActivePopover, locked, onToggle }: ToolbarPopoverProps & { locked: boolean; onToggle: () => void }) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover });
  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 transition hover:-translate-y-0.5 ${
          locked
            ? "bg-amber-100 text-amber-700 ring-amber-200"
            : "bg-white text-ink ring-line hover:bg-slate-50"
        }`}
        onClick={onToggle}
      >
        {locked ? "锁" : "开"}
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-action" checked={locked} onChange={onToggle} />
          <span className="text-sm font-semibold">锁定裁片</span>
        </label>
        <p className="mt-1.5 text-xs leading-5 text-slate-500">避免误拖动或误改参数。</p>
      </div>
    </div>
  );
}

function ToolbarResetButton({ popoverId, activePopover, setActivePopover, onReset, disabled }: ToolbarPopoverProps & { onReset: () => void; disabled?: boolean }) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover }, Boolean(disabled));
  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 ring-line transition hover:-translate-y-0.5 ${
          disabled ? "bg-slate-100 text-slate-400" : "bg-white text-red-600 hover:bg-red-50"
        }`}
        onClick={onReset}
        disabled={disabled}
      >
        重
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        <button className="w-full rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-700" onClick={onReset}>
          重置当前裁片
        </button>
        <p className="mt-1.5 text-xs leading-5 text-slate-500">将当前裁片的所有参数恢复为默认值。</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 快捷操作：吸附 & 居中
// ---------------------------------------------------------------------------

function ToolbarSnapButton({
  popoverId,
  activePopover,
  setActivePopover,
  disabled,
  designCanvas,
  piece,
  onPatchTransform,
}: ToolbarPopoverProps & {
  disabled?: boolean;
  designCanvas: DesignCanvas | null;
  piece: Piece;
  onPatchTransform: (transform: Partial<Piece["transform"]>) => void;
}) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover }, Boolean(disabled));
  const snapSettings = textureSnapSettings(designCanvas);
  const hasRepeat = Boolean(snapSettings);
  const periodX = snapSettings?.periodX ?? 0;
  const periodY = snapSettings?.periodY ?? 0;

  const handleSnap = () => {
    if (!snapSettings) return;
    const snapped = snapPieceSamplingOffset({
      designX: piece.transform.design_x ?? 0,
      designY: piece.transform.design_y ?? 0,
      offsetX: piece.transform.offset_x ?? 0,
      offsetY: piece.transform.offset_y ?? 0,
      ...snapSettings,
    });
    if (snapped.changed) {
      onPatchTransform({ offset_x: snapped.offsetX, offset_y: snapped.offsetY });
    }
  };

  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 ring-line transition hover:-translate-y-0.5 ${
          disabled || !hasRepeat ? "bg-slate-100 text-slate-400" : "bg-white text-blue-600 hover:bg-blue-50"
        }`}
        onClick={handleSnap}
        disabled={disabled || !hasRepeat}
      >
        吸
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        <p className="text-sm font-semibold">吸附到面料周期</p>
        {hasRepeat ? (
          <>
            <p className="mt-1.5 text-xs leading-5 text-slate-500">
              将取样坐标对齐到面料周期的最近整数倍，确保接缝处花型连续。
            </p>
            <p className="mt-1 text-xs text-slate-400">
              周期: X={periodX > 0 ? `${Math.round(periodX)}px` : "未检测"} &nbsp; Y={periodY > 0 ? `${Math.round(periodY)}px` : "未检测"}
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-xs leading-5 text-slate-500">当前面料无可检测的重复周期，吸附不可用。</p>
        )}
      </div>
    </div>
  );
}

export function snapPieceSamplingOffset({
  designX,
  designY,
  offsetX,
  offsetY,
  originX,
  originY,
  periodX,
  periodY,
}: {
  designX: number;
  designY: number;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  periodX: number;
  periodY: number;
}): { offsetX: number; offsetY: number; changed: boolean } {
  const sampleX = designX + offsetX;
  const sampleY = designY + offsetY;
  const snappedX = periodX > 0 ? originX + Math.round((sampleX - originX) / periodX) * periodX : sampleX;
  const snappedY = periodY > 0 ? originY + Math.round((sampleY - originY) / periodY) * periodY : sampleY;
  const nextOffsetX = Math.round(offsetX + snappedX - sampleX);
  const nextOffsetY = Math.round(offsetY + snappedY - sampleY);
  return {
    offsetX: nextOffsetX,
    offsetY: nextOffsetY,
    changed: Math.abs(nextOffsetX - offsetX) > 0.5 || Math.abs(nextOffsetY - offsetY) > 0.5,
  };
}

function snapDesignRegionPosition({
  sampleX,
  sampleY,
  offsetX,
  offsetY,
  originX,
  originY,
  periodX,
  periodY,
}: {
  sampleX: number;
  sampleY: number;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  periodX: number;
  periodY: number;
}): { sampleX: number; sampleY: number; designX: number; designY: number } {
  const designX = sampleX - offsetX;
  const designY = sampleY - offsetY;
  const snapped = snapPieceSamplingOffset({ designX, designY, offsetX, offsetY, originX, originY, periodX, periodY });
  const nextSampleX = designX + snapped.offsetX;
  const nextSampleY = designY + snapped.offsetY;
  return {
    sampleX: nextSampleX,
    sampleY: nextSampleY,
    designX: nextSampleX - offsetX,
    designY: nextSampleY - offsetY,
  };
}

function textureSnapSettings(designCanvas: DesignCanvas | null): TextureSnapSettings | null {
  const repeat = designCanvas?.texture_repeat;
  if (!repeat?.has_repeat || (!repeat.period_x && !repeat.period_y)) return null;
  const angle = Number(designCanvas?.global_texture_angle || 0) % 180;
  if (Math.min(Math.abs(angle), Math.abs(180 - angle)) > 0.01) return null;
  const scale = Math.max(0.05, Number(designCanvas?.texture_scale || 1));
  const periodX = repeat.period_x > 0 ? repeat.period_x * scale : 0;
  const periodY = repeat.period_y > 0 ? repeat.period_y * scale : 0;
  if (periodX < 4 && periodY < 4) return null;
  return {
    originX: Number(designCanvas?.texture_offset_x || 0),
    originY: Number(designCanvas?.texture_offset_y || 0),
    periodX: periodX >= 4 ? periodX : 0,
    periodY: periodY >= 4 ? periodY : 0,
  };
}

function ToolbarCenterButton({
  popoverId,
  activePopover,
  setActivePopover,
  disabled,
  piece,
  onPatchTransform,
}: ToolbarPopoverProps & {
  disabled?: boolean;
  piece: Piece;
  onPatchTransform: (transform: Partial<Piece["transform"]>) => void;
}) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover }, Boolean(disabled));

  const handleCenter = () => {
    const hasOffset = (piece.transform.offset_x ?? 0) !== 0 || (piece.transform.offset_y ?? 0) !== 0;
    if (hasOffset) {
      onPatchTransform({ offset_x: 0, offset_y: 0 });
    }
  };

  const isAlreadyCentered = (piece.transform.offset_x ?? 0) === 0 && (piece.transform.offset_y ?? 0) === 0;

  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 ring-line transition hover:-translate-y-0.5 ${
          disabled || isAlreadyCentered ? "bg-slate-100 text-slate-400" : "bg-white text-green-600 hover:bg-green-50"
        }`}
        onClick={handleCenter}
        disabled={disabled || isAlreadyCentered}
      >
        中
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        <p className="text-sm font-semibold">居中取样位置</p>
        <p className="mt-1.5 text-xs leading-5 text-slate-500">
          清除手动偏移，将裁片取样位置恢复到自动分配的默认坐标。
        </p>
        {!isAlreadyCentered && (
          <p className="mt-1 text-xs text-slate-400">
            当前偏移: X={piece.transform.offset_x ?? 0}, Y={piece.transform.offset_y ?? 0}
          </p>
        )}
      </div>
    </div>
  );
}

function ToolbarOrientationButton({
  popoverId,
  activePopover,
  setActivePopover,
  disabled,
  piece,
  onPatchTransform,
}: ToolbarPopoverProps & {
  disabled?: boolean;
  piece: Piece;
  onPatchTransform: (transform: Partial<Piece["transform"]>) => void;
}) {
  const popover = useToolbarPopover({ popoverId, activePopover, setActivePopover }, Boolean(disabled));
  const normalizedRotation = normalizeHalfTurn(piece.transform.rotation || 0);
  const inverted = normalizedRotation === 180;
  const handleToggle = () => {
    onPatchTransform({ rotation: inverted ? 0 : 180 });
  };

  return (
    <div className="relative" onMouseEnter={popover.open} onMouseLeave={popover.close} onFocus={popover.open} onBlur={popover.close}>
      <button
        className={`flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold shadow ring-1 ring-line transition hover:-translate-y-0.5 ${
          disabled ? "bg-slate-100 text-slate-400" : inverted ? "bg-amber-100 text-amber-700 hover:bg-amber-50" : "bg-white text-teal-600 hover:bg-teal-50"
        }`}
        onClick={handleToggle}
        disabled={disabled}
      >
        向
      </button>
      <div className={`absolute right-full top-0 h-full w-3 ${popover.visible ? "pointer-events-auto" : "pointer-events-none"}`} />
      <div className={`absolute right-full top-1/2 w-56 -translate-y-1/2 -translate-x-2 rounded-xl border border-line bg-white p-3 shadow-xl transition ${popover.visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}>
        <div className="absolute -right-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-t border-r border-line bg-white" />
        <p className="text-sm font-semibold">版型方向</p>
        <p className="mt-1.5 text-xs leading-5 text-slate-500">
          当前为{inverted ? "倒置取样" : "正向取样"}。如果模板中这个裁片上下颠倒，点击按钮可旋转 180°，让前后身在全局设计画布中保持同一穿着方向。
        </p>
      </div>
    </div>
  );
}

function normalizeHalfTurn(rotation: number) {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized >= 90 && normalized < 270 ? 180 : 0;
}

function DimmedTextureLayer({
  piece,
  textureImage,
  frame,
  zoom = 1,
  stageWidth,
  stageHeight
}: {
  piece: Piece;
  textureImage: TextureImageSource;
  frame: { x: number; y: number; width: number; height: number };
  zoom?: number;
  stageWidth: number;
  stageHeight: number;
}) {
  const frameScale = frame.width / Math.max(1, piece.width);
  const globalMode = piece.transform.mode === "global_canvas";
  const rotation = globalMode ? 0 : piece.transform.rotation;
  const designX = (piece.transform.design_x ?? 0) + piece.transform.offset_x;
  const designY = (piece.transform.design_y ?? 0) + piece.transform.offset_y;
  const view = globalMode
    ? {
        x: -frame.x / frameScale,
        y: -frame.y / frameScale,
        width: Math.max(1, stageWidth / frameScale),
        height: Math.max(1, stageHeight / frameScale),
        pixelWidth: stageWidth,
        pixelHeight: stageHeight
      }
    : null;
  const globalSample = useGlobalCanvasSample(textureImage, {
    originX: designX,
    originY: designY,
    pieceWidth: piece.width,
    pieceHeight: piece.height,
    view,
    scale: piece.transform.scale,
    rotation: piece.transform.rotation,
    mirrorX: piece.transform.mirror_x,
    mirrorY: piece.transform.mirror_y
  });
  const basePatternSource = globalMode ? globalSample || textureImage : textureImage;
  const patternSource = useMemo(
    () => getMirroredTexture(basePatternSource, piece.transform.mirror_x || false, piece.transform.mirror_y || false),
    [basePatternSource, piece.transform.mirror_x, piece.transform.mirror_y]
  );
  if (globalMode && globalSample) {
    return (
      <Layer scaleX={zoom} scaleY={zoom}>
        <KonvaImage image={globalSample} x={0} y={0} width={stageWidth} height={stageHeight} opacity={0.25} listening={false} />
      </Layer>
    );
  }
  const imageCenterX = frame.x + frame.width / 2 + (globalMode ? 0 : piece.transform.offset_x * frameScale);
  const imageCenterY = frame.y + frame.height / 2 + (globalMode ? 0 : piece.transform.offset_y * frameScale);
  const sourceWidth = ("naturalWidth" in patternSource ? patternSource.naturalWidth || patternSource.width : patternSource.width) || 1;
  const sourceHeight = ("naturalHeight" in patternSource ? patternSource.naturalHeight || patternSource.height : patternSource.height) || 1;
  const patternScale = piece.transform.scale * frameScale;
  return (
    <Layer scaleX={zoom} scaleY={zoom}>
      <Rect
        x={0}
        y={0}
        width={stageWidth}
        height={stageHeight}
        fillPatternImage={patternSource as unknown as HTMLImageElement}
        fillPatternScaleX={patternScale}
        fillPatternScaleY={patternScale}
        fillPatternRotation={rotation}
        fillPatternX={imageCenterX}
        fillPatternY={imageCenterY}
        fillPatternOffsetX={sourceWidth / 2}
        fillPatternOffsetY={sourceHeight / 2}
        opacity={0.25}
        listening={false}
      />
    </Layer>
  );
}

function ClippedTextureLayer({
  piece,
  contentPiece,
  contentMirrorX = false,
  contentMirrorY = false,
  textureImage,
  maskImage,
  frame,
  zoom = 1,
  draggable = false,
  opacity = 1,
  snapSettings,
  onPreviewMove,
  onMove,
  onMoveCancel,
  onSelect
}: {
  piece: Piece;
  contentPiece?: Piece;
  contentMirrorX?: boolean;
  contentMirrorY?: boolean;
  textureImage: TextureImageSource;
  maskImage: CanvasImageSource;
  frame: { x: number; y: number; width: number; height: number };
  zoom?: number;
  draggable?: boolean;
  opacity?: number;
  snapSettings?: TextureSnapSettings | null;
  onPreviewMove?: (x: number, y: number) => void;
  onMove?: (x: number, y: number) => void;
  onMoveCancel?: () => void;
  onSelect?: () => void;
}) {
  const renderPiece = contentPiece || piece;
  const frameScale = frame.width / Math.max(1, renderPiece.width);
  const globalMode = renderPiece.transform.mode === "global_canvas";
  const canDrag = draggable && !piece.transform.locked;
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  const lastDragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const effectiveMirrorX = Boolean(renderPiece.transform.mirror_x) !== contentMirrorX;
  const effectiveMirrorY = Boolean(renderPiece.transform.mirror_y) !== contentMirrorY;
  const designX = (renderPiece.transform.design_x ?? 0) + renderPiece.transform.offset_x;
  const designY = (renderPiece.transform.design_y ?? 0) + renderPiece.transform.offset_y;
  const globalSample = useGlobalCanvasSample(textureImage, {
    originX: designX,
    originY: designY,
    pieceWidth: renderPiece.width,
    pieceHeight: renderPiece.height,
    view: globalMode
      ? {
          x: 0,
          y: 0,
          width: renderPiece.width,
          height: renderPiece.height,
          pixelWidth: Math.max(1, Math.round(frame.width)),
          pixelHeight: Math.max(1, Math.round(frame.height))
        }
      : null,
    scale: renderPiece.transform.scale,
    rotation: renderPiece.transform.rotation,
    mirrorX: effectiveMirrorX,
    mirrorY: effectiveMirrorY
  });
  const renderedImage = globalMode ? globalSample || textureImage : textureImage;
  const imageWidth = globalMode ? frame.width : Math.max(1, textureSourceWidth(textureImage) * renderPiece.transform.scale * frameScale);
  const imageHeight = globalMode ? frame.height : Math.max(1, textureSourceHeight(textureImage) * renderPiece.transform.scale * frameScale);
  const imageCenterX = frame.x + frame.width / 2 + (globalMode ? 0 : renderPiece.transform.offset_x * frameScale);
  const imageCenterY = frame.y + frame.height / 2 + (globalMode ? 0 : renderPiece.transform.offset_y * frameScale);
  const dragOffsetFromNode = (x: number, y: number) => {
    const state = dragStateRef.current;
    const baseOffsetX = state?.startOffsetX ?? renderPiece.transform.offset_x;
    const baseOffsetY = state?.startOffsetY ?? renderPiece.transform.offset_y;
    const baseX = state?.startX ?? frame.x;
    const baseY = state?.startY ?? frame.y;
    const deltaX = Math.round((x - baseX) / frameScale);
    const deltaY = Math.round((y - baseY) / frameScale);
    return globalMode
      ? { x: baseOffsetX - deltaX, y: baseOffsetY - deltaY }
      : { x: baseOffsetX + deltaX, y: baseOffsetY + deltaY };
  };
  const snapDragOffset = (next: { x: number; y: number }) => {
    if (!snapSettings) return next;
    const snapped = snapPieceSamplingOffset({
      designX: renderPiece.transform.design_x ?? 0,
      designY: renderPiece.transform.design_y ?? 0,
      offsetX: next.x,
      offsetY: next.y,
      ...snapSettings,
    });
    return { x: snapped.offsetX, y: snapped.offsetY };
  };
  const resetDragTarget = (target: { x: (value: number) => void; y: (value: number) => void }) => {
    target.x(frame.x);
    target.y(frame.y);
  };
  const setStageCursor = (target: { getStage: () => { container: () => HTMLDivElement } | null }, cursor: string) => {
    const container = target.getStage()?.container();
    if (container) container.style.cursor = cursor;
  };

  return (
    <Layer scaleX={zoom} scaleY={zoom}>
      <KonvaImage
        image={renderedImage}
        x={imageCenterX}
        y={imageCenterY}
        width={imageWidth}
        height={imageHeight}
        offsetX={imageWidth / 2}
        offsetY={imageHeight / 2}
        rotation={globalMode ? 0 : renderPiece.transform.rotation}
        scaleX={!globalMode && effectiveMirrorX ? -1 : 1}
        scaleY={!globalMode && effectiveMirrorY ? -1 : 1}
        opacity={opacity}
        listening={!canDrag}
        onClick={onSelect}
        onTap={onSelect}
      />
      <KonvaImage
        image={maskImage}
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        globalCompositeOperation="destination-in"
        listening={!canDrag}
        onClick={onSelect}
        onTap={onSelect}
      />
      {canDrag && (
        <Rect
          x={frame.x}
          y={frame.y}
          width={frame.width}
          height={frame.height}
          fill="#000000"
          opacity={0.001}
          draggable
          onClick={onSelect}
          onTap={onSelect}
          onMouseEnter={(event) => setStageCursor(event.target, "grab")}
          onMouseLeave={(event) => setStageCursor(event.target, "")}
          onDragStart={(event) => {
            dragStateRef.current = {
              startX: event.target.x(),
              startY: event.target.y(),
              startOffsetX: renderPiece.transform.offset_x,
              startOffsetY: renderPiece.transform.offset_y,
            };
            lastDragOffsetRef.current = { x: renderPiece.transform.offset_x, y: renderPiece.transform.offset_y };
            setStageCursor(event.target, "grabbing");
            onPreviewMove?.(renderPiece.transform.offset_x, renderPiece.transform.offset_y);
          }}
          onDragMove={(event) => {
            if (!onPreviewMove) return;
            const next = dragOffsetFromNode(event.target.x(), event.target.y());
            lastDragOffsetRef.current = next;
            onPreviewMove(next.x, next.y);
          }}
          onDragEnd={(event) => {
            const next = snapDragOffset(lastDragOffsetRef.current || dragOffsetFromNode(event.target.x(), event.target.y()));
            resetDragTarget(event.target);
            dragStateRef.current = null;
            lastDragOffsetRef.current = null;
            setStageCursor(event.target, "grab");
            if (onMove) {
              onMove(next.x, next.y);
            } else {
              onMoveCancel?.();
            }
          }}
        />
      )}
    </Layer>
  );
}

function wrapCropCoordinate(value: number, size: number) {
  if (!Number.isFinite(value) || size <= 0) return 0;
  return ((value % size) + size) % size;
}

function useTiledTextureSample(
  textureImage: TextureImageSource,
  crop: { x: number; y: number; width: number; height: number } | null
) {
  return useMemo(() => {
    if (!crop) return null;
    const sourceWidth = textureSourceWidth(textureImage);
    const sourceHeight = textureSourceHeight(textureImage);
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    const width = Math.max(1, Math.round(crop.width));
    const height = Math.max(1, Math.round(crop.height));
    const limited = limitedCanvasSize(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = limited.width;
    canvas.height = limited.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.scale(limited.scale, limited.scale);
    const offsetX = wrapCropCoordinate(crop.x, sourceWidth);
    const offsetY = wrapCropCoordinate(crop.y, sourceHeight);
    for (let y = -offsetY; y < height; y += sourceHeight) {
      for (let x = -offsetX; x < width; x += sourceWidth) {
        context.drawImage(textureImage, x, y, sourceWidth, sourceHeight);
      }
    }
    return canvas;
  }, [textureImage, crop?.x, crop?.y, crop?.width, crop?.height]);
}

type GlobalCanvasSampleOptions = {
  originX: number;
  originY: number;
  pieceWidth: number;
  pieceHeight: number;
  view: { x: number; y: number; width: number; height: number; pixelWidth: number; pixelHeight: number } | null;
  scale: number;
  rotation: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
};

function useGlobalCanvasSample(textureImage: TextureImageSource, options: GlobalCanvasSampleOptions) {
  return useMemo(() => {
    if (!options.view) return null;
    const sourceWidth = textureSourceWidth(textureImage);
    const sourceHeight = textureSourceHeight(textureImage);
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;

    const view = options.view;
    const outputSize = limitedCanvasSize(view.pixelWidth, view.pixelHeight);
    const canvas = document.createElement("canvas");
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const scale = Math.max(0.05, Number(options.scale || 1));
    const rotation = Number(options.rotation || 0);
    const angle = (rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const centerX = options.pieceWidth / 2;
    const centerY = options.pieceHeight / 2;

    const sourcePoint = (px: number, py: number) => {
      const localX = options.mirrorX ? options.pieceWidth - px : px;
      const localY = options.mirrorY ? options.pieceHeight - py : py;
      const dx = localX - centerX;
      const dy = localY - centerY;
      return {
        x: options.originX + centerX + (cos * dx + sin * dy) / scale,
        y: options.originY + centerY + (-sin * dx + cos * dy) / scale
      };
    };

    const corners = [
      sourcePoint(view.x, view.y),
      sourcePoint(view.x + view.width, view.y),
      sourcePoint(view.x, view.y + view.height),
      sourcePoint(view.x + view.width, view.y + view.height)
    ];
    const minX = Math.min(...corners.map((point) => point.x));
    const minY = Math.min(...corners.map((point) => point.y));
    const maxX = Math.max(...corners.map((point) => point.x));
    const maxY = Math.max(...corners.map((point) => point.y));
    const padding = 3;
    const cropX = Math.floor(minX) - padding;
    const cropY = Math.floor(minY) - padding;
    const cropWidth = Math.max(1, Math.ceil(maxX) - cropX + padding);
    const cropHeight = Math.max(1, Math.ceil(maxY) - cropY + padding);
    const crop = createTiledTextureSample(textureImage, { x: cropX, y: cropY, width: cropWidth, height: cropHeight });
    if (!crop) return null;

    const pixelScaleX = canvas.width / Math.max(1, view.width);
    const pixelScaleY = canvas.height / Math.max(1, view.height);
    context.scale(pixelScaleX, pixelScaleY);
    context.translate(-view.x, -view.y);
    context.translate(centerX, centerY);
    if (options.mirrorX || options.mirrorY) {
      context.scale(options.mirrorX ? -1 : 1, options.mirrorY ? -1 : 1);
    }
    context.rotate(angle);
    context.scale(scale, scale);
    context.translate(cropX - options.originX - centerX, cropY - options.originY - centerY);
    context.drawImage(crop.canvas, 0, 0, crop.width, crop.height);
    return canvas;
  }, [
    textureImage,
    options.originX,
    options.originY,
    options.pieceWidth,
    options.pieceHeight,
    options.view?.x,
    options.view?.y,
    options.view?.width,
    options.view?.height,
    options.view?.pixelWidth,
    options.view?.pixelHeight,
    options.scale,
    options.rotation,
    options.mirrorX,
    options.mirrorY
  ]);
}

function createTiledTextureSample(
  textureImage: TextureImageSource,
  crop: { x: number; y: number; width: number; height: number }
) {
  const sourceWidth = textureSourceWidth(textureImage);
  const sourceHeight = textureSourceHeight(textureImage);
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const width = Math.max(1, Math.round(crop.width));
  const height = Math.max(1, Math.round(crop.height));
  const limited = limitedCanvasSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = limited.width;
  canvas.height = limited.height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(limited.scale, limited.scale);
  const offsetX = wrapCropCoordinate(crop.x, sourceWidth);
  const offsetY = wrapCropCoordinate(crop.y, sourceHeight);
  for (let y = -offsetY; y < height; y += sourceHeight) {
    for (let x = -offsetX; x < width; x += sourceWidth) {
      context.drawImage(textureImage, x, y, sourceWidth, sourceHeight);
    }
  }
  return { canvas, width, height };
}

function LayoutPieceTexture({
  piece,
  sourcePiece,
  textureImage,
  selected,
  zoom,
  onSelect
}: {
  piece: Piece;
  sourcePiece?: Piece;
  textureImage: TextureImageSource;
  selected: boolean;
  zoom: number;
  onSelect: () => void;
}) {
  const mask = useLoadedImage(piece.mask_url);
  const alphaMask = useLuminanceMaskImage(mask, piece.mask_url);
  if (!alphaMask) return null;

  return (
    <ClippedTextureLayer
      piece={piece}
      contentPiece={sourcePiece}
      contentMirrorX={Boolean(piece.mirror_of && piece.transform.mirror_x)}
      contentMirrorY={Boolean(piece.mirror_of && piece.transform.mirror_y)}
      textureImage={textureImage}
      maskImage={alphaMask}
      frame={{ x: piece.source_x, y: piece.source_y, width: piece.width, height: piece.height }}
      zoom={zoom}
      opacity={1}
      onSelect={onSelect}
    />
  );
}

function PieceOutline({ piece, selected, outlineWidth, onSelect }: { piece: Piece; selected: boolean; outlineWidth: number; onSelect: () => void }) {
  return (
    <>
      <Rect
        x={piece.source_x}
        y={piece.source_y}
        width={piece.width}
        height={piece.height}
        stroke="#e05252"
        strokeWidth={outlineWidth}
        strokeScaleEnabled={false}
        opacity={selected ? 1 : 0.55}
        onClick={onSelect}
        onTap={onSelect}
      />
      <Text x={piece.source_x + 8} y={piece.source_y + 8} text={piece.name} fill="#e05252" fontSize={14} opacity={1} />
    </>
  );
}
