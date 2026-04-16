"use client";

import type { DesignCanvas, DesignLayer, Piece } from "@print-studio/shared-types";
import { PIECE_ROLE_LABELS } from "@/lib/labels";
import "konva/lib/shapes/Image.js";
import "konva/lib/shapes/Rect.js";
import "konva/lib/shapes/Text.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva/es/ReactKonvaCore.js";

const loadedImageCache = new Map<string, Promise<HTMLImageElement | null>>();
const loadedImageValueCache = new Map<string, HTMLImageElement | null>();
const luminanceMaskCache = new Map<string, HTMLCanvasElement>();
const luminanceMaskPromiseCache = new Map<string, Promise<HTMLCanvasElement | null>>();
const MAX_CONCURRENT_IMAGE_LOADS = 4;
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

function useLoadedImage(src: string, fallbackSrc = "") {
  const cacheKey = imageCacheKey(src, fallbackSrc);
  const [image, setImage] = useState<HTMLImageElement | null>(() => loadedImageValueCache.get(cacheKey) ?? null);
  useEffect(() => {
    if (!src) {
      setImage(null);
      return;
    }
    const cachedValue = loadedImageValueCache.get(cacheKey);
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
    return Promise.resolve(loadedImageValueCache.get(cacheKey) ?? null);
  }
  const cached = loadedImageCache.get(cacheKey);
  if (cached) return cached;

  const promise = loadImage(src).then((image) => {
    if (image || !fallbackSrc || fallbackSrc === src) {
      loadedImageValueCache.set(cacheKey, image);
      return image;
    }
    return loadImage(fallbackSrc).then((fallback) => {
      loadedImageValueCache.set(cacheKey, fallback);
      return fallback;
    });
  });
  loadedImageCache.set(cacheKey, promise);
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
  const [mask, setMask] = useState<HTMLCanvasElement | null>(() => (imageKey ? luminanceMaskCache.get(imageKey) ?? null : null));

  useEffect(() => {
    if (!image) {
      setMask(null);
      return;
    }
    const key = cacheKey || image.currentSrc || image.src;
    const cached = luminanceMaskCache.get(key);
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
  const cached = luminanceMaskCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = luminanceMaskPromiseCache.get(key);
  if (pending) return pending;

  const promise = createLuminanceMaskCanvas(image)
    .then((canvas) => {
      if (canvas) luminanceMaskCache.set(key, canvas);
      luminanceMaskPromiseCache.delete(key);
      return canvas;
    })
    .catch(() => {
      luminanceMaskPromiseCache.delete(key);
      const fallback = createLuminanceMaskCanvasSync(image);
      if (fallback) luminanceMaskCache.set(key, fallback);
      return fallback;
    });
  luminanceMaskPromiseCache.set(key, promise);
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

function getMirroredTexture(image: HTMLImageElement | HTMLCanvasElement, mirrorX: boolean, mirrorY: boolean) {
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
  onToggleOutlines: (visible: boolean) => void;
  onOutlineWidthChange?: (width: number) => void;
  onMovePiece: (piece: Piece, x: number, y: number) => void;
};

export function SinglePieceCalibration({ pieces, selectedPieceId, textureUrl, showOutlines, outlineWidth = 1, onToggleOutlines, onOutlineWidthChange = () => {}, onMovePiece }: SinglePieceCalibrationProps) {
  const textureImage = useLoadedImage(textureUrl);
  const selected = pieces.find((piece) => piece.id === selectedPieceId) ?? pieces[0];
  const maskImage = useLoadedImage(selected?.mask_url || "");
  const selectedMaskKey = selected?.mask_url || "";
  const alphaMaskImage = useLuminanceMaskImage(maskImage, selectedMaskKey);
  const outlineImage = useMemo(() => {
    if (!alphaMaskImage) return null;
    return createOutlineCanvas(alphaMaskImage, outlineWidth, "#e05252");
  }, [alphaMaskImage, outlineWidth]);
  const [pieceZoom, setPieceZoom] = useState(1);
  const [stageWrapRef, stageWrapSize] = useElementSize<HTMLDivElement>();
  const stageWidth = Math.max(320, Math.round(stageWrapSize.width || 520));
  const stageHeight = Math.max(440, Math.min(640, Math.round(stageWidth * 1.22)));
  const selectedMaskFrame = useMemo(() => {
    if (!selected) return null;
    const innerWidth = Math.max(1, stageWidth - 80);
    const innerHeight = Math.max(1, stageHeight - 80);
    const scale = Math.min(innerWidth / Math.max(1, selected.width), innerHeight / Math.max(1, selected.height));
    const width = Math.max(1, selected.width * scale);
    const height = Math.max(1, selected.height * scale);
    return { x: (stageWidth - width) / 2, y: (stageHeight - height) / 2, width, height };
  }, [selected, stageHeight, stageWidth]);

  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">单裁片校正</h2>
          <p className="m-0 mt-1 text-sm text-slate-500">拖动裁片中的布料，微调重点花位。</p>
        </div>
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
          <ZoomButton label="-" onClick={() => setPieceZoom((zoom) => clampZoom(zoom - 0.1))} />
          <span className="min-w-14 rounded-md bg-mist px-2 py-1.5 text-center text-sm text-slate-600">{Math.round(pieceZoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => setPieceZoom((zoom) => clampZoom(zoom + 0.1))} />
        </div>
      </div>
      <div ref={stageWrapRef} className="overflow-hidden rounded-lg border border-line bg-white">
        <Stage width={stageWidth} height={stageHeight}>
          <Layer>
            <Rect x={0} y={0} width={stageWidth} height={stageHeight} fill="#ffffff" />
            {!selected && <Text x={Math.max(24, stageWidth / 2 - 100)} y={stageHeight / 2 - 12} text="请先导入裁片模板" fill="#64748b" fontSize={18} />}
            {selected && !textureImage && <Text x={Math.max(24, stageWidth / 2 - 120)} y={stageHeight / 2 - 12} text="请上传图案或生成纹理" fill="#64748b" fontSize={18} />}
          </Layer>
          {textureImage && selected && selectedMaskFrame && (
            <DimmedTextureLayer
              piece={selected}
              textureImage={textureImage}
              frame={selectedMaskFrame}
              zoom={pieceZoom}
              stageWidth={stageWidth}
              stageHeight={stageHeight}
            />
          )}
          {textureImage && selected && alphaMaskImage && selectedMaskFrame && (
            <ClippedTextureLayer
              piece={selected}
              textureImage={textureImage}
              maskImage={alphaMaskImage}
              frame={selectedMaskFrame}
              zoom={pieceZoom}
              draggable
              onMove={(x, y) => onMovePiece(selected, x, y)}
            />
          )}
          {showOutlines && outlineImage && selectedMaskFrame && (
            <Layer scaleX={pieceZoom} scaleY={pieceZoom}>
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
      </div>
    </section>
  );
}

type LayoutPreviewProps = {
  pieces: Piece[];
  selectedPieceId: string;
  textureUrl: string;
  fallbackTextureUrl?: string;
  textureIsDesignCanvas?: boolean;
  designCanvas?: DesignCanvas | null;
  selectedLayerId?: string;
  showOutlines: boolean;
  outlineWidth?: number;
  onSelectPiece: (id: string) => void;
  onSelectLayer?: (id: string) => void;
  onMoveDesignRegion?: (piece: Piece, update: Partial<Piece["transform"]>) => void;
  onMoveLayer?: (layer: DesignLayer, update: Partial<DesignLayer>) => void;
};

export function LayoutPreview({
  pieces,
  selectedPieceId,
  textureUrl,
  fallbackTextureUrl = "",
  textureIsDesignCanvas = false,
  designCanvas,
  selectedLayerId = "",
  showOutlines,
  outlineWidth = 1,
  onSelectPiece,
  onSelectLayer = () => {},
  onMoveDesignRegion = () => {},
  onMoveLayer = () => {}
}: LayoutPreviewProps) {
  const textureImage = useLoadedImage(textureUrl, fallbackTextureUrl);
  const [layoutZoom, setLayoutZoom] = useState(0.25);
  const [designZoom, setDesignZoom] = useState(0.25);
  const [previewMode, setPreviewMode] = useState<"layout" | "design">("layout");
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
    const maxHeight = 720;
    const next = Math.min(maxWidth / layoutBounds.width, maxHeight / layoutBounds.height, 1);
    return Math.max(0.05, Number(next.toFixed(2)));
  }, [layoutBounds, previewWrapSize.width]);
  const designFitZoom = useMemo(() => {
    const maxWidth = Math.max(360, previewWrapSize.width || 980);
    const maxHeight = 720;
    const next = Math.min(maxWidth / designBounds.width, maxHeight / designBounds.height, 1);
    return Math.max(0.05, Number(next.toFixed(2)));
  }, [designBounds, previewWrapSize.width]);
  const currentZoom = previewMode === "design" ? designZoom : layoutZoom;
  const updateCurrentZoom = (updater: (zoom: number) => number) => {
    if (previewMode === "design") {
      setDesignZoom(updater);
    } else {
      setLayoutZoom(updater);
    }
  };

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
            {previewMode === "design" ? "查看裁片在虚拟衣服平面中的取样区域。" : "按模板原始坐标回排，导出时保持同一坐标系。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="rounded-md bg-mist px-2 py-1.5 text-sm text-slate-600">{pieces.length} 个裁片</span>
          <ZoomButton label="排版" active={previewMode === "layout"} onClick={() => setPreviewMode("layout")} />
          <ZoomButton label="设计画布" active={previewMode === "design"} onClick={() => setPreviewMode("design")} />
          <ZoomButton label="-" onClick={() => updateCurrentZoom((zoom) => clampZoom(zoom - 0.05))} />
          <span className="min-w-14 rounded-md bg-mist px-2 py-1.5 text-center text-sm text-slate-600">{Math.round(currentZoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => updateCurrentZoom((zoom) => clampZoom(zoom + 0.05))} />
          <ZoomButton label="100%" onClick={() => updateCurrentZoom(() => 1)} />
        </div>
      </div>
      <div ref={previewWrapRef} className="flex max-h-[760px] min-h-[360px] justify-center overflow-auto rounded-lg border border-line bg-white">
        <div className={previewMode === "layout" ? "block shrink-0" : "hidden shrink-0"}>
          <Stage width={Math.ceil(layoutBounds.width * layoutZoom)} height={Math.ceil(layoutBounds.height * layoutZoom)}>
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              <Rect x={0} y={0} width={layoutBounds.width} height={layoutBounds.height} fill="#ffffff" />
            </Layer>
            {textureImage &&
              pieces.map((piece) => (
                <LayoutPieceTexture
                  key={`texture-${piece.id}`}
                  piece={piece}
                  textureImage={textureImage}
                  selected={piece.id === selectedPieceId}
                  zoom={layoutZoom}
                  onSelect={() => onSelectPiece(piece.id)}
                />
              ))}
            {/* 排版视图下只显示裁片图片，不显示线框 */}
          </Stage>
        </div>
        <div className={previewMode === "design" ? "block shrink-0" : "hidden shrink-0"}>
          <Stage width={Math.ceil(designBounds.width * designZoom)} height={Math.ceil(designBounds.height * designZoom)}>
            <Layer scaleX={designZoom} scaleY={designZoom}>
              <Rect x={0} y={0} width={designBounds.width} height={designBounds.height} fill="#ffffff" />
              {textureImage && (
                <DesignTextureBackground
                  image={textureImage}
                  width={designBounds.width}
                  height={designBounds.height}
                  designCanvas={designCanvas || null}
                  directImage={textureIsDesignCanvas}
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
                    onSelect={() => onSelectPiece(piece.id)}
                    onChange={(update) => onMoveDesignRegion(piece, update)}
                  />
                ))}
              </Layer>
            )}
          </Stage>
        </div>
      </div>
    </section>
  );
}

function DesignRegionOutline({
  piece,
  selected,
  outlineWidth,
  zoom,
  onSelect,
  onChange
}: {
  piece: Piece;
  selected: boolean;
  outlineWidth: number;
  zoom: number;
  onSelect: () => void;
  onChange: (update: Partial<Piece["transform"]>) => void;
}) {
  const offsetX = piece.transform.offset_x || 0;
  const offsetY = piece.transform.offset_y || 0;
  const x = (piece.transform.design_x ?? piece.source_x) + offsetX;
  const y = (piece.transform.design_y ?? piece.source_y) + offsetY;
  const width = piece.transform.design_width ?? piece.width;
  const height = piece.transform.design_height ?? piece.height;
  const locked = Boolean(piece.transform.locked);
  return (
    <>
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        stroke={selected ? "#e05252" : "rgba(224,82,82,0.65)"}
        strokeWidth={outlineWidth}
        strokeScaleEnabled={false}
        dash={selected ? [] : [12, 8]}
        draggable={selected && !locked}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(event) => {
          event.cancelBubble = true;
          onChange({ design_x: Math.round(event.target.x() - offsetX), design_y: Math.round(event.target.y() - offsetY) });
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
      {selected && !locked && (
        <>
          <ResizeHandle x={x} y={y} cursor="nwse-resize" onMove={(nx, ny) => onResizeRegion(x, y, width, height, offsetX, offsetY, nx, ny, "top_left", onChange)} />
          <ResizeHandle x={x + width} y={y} cursor="nesw-resize" onMove={(nx, ny) => onResizeRegion(x, y, width, height, offsetX, offsetY, nx, ny, "top_right", onChange)} />
          <ResizeHandle x={x} y={y + height} cursor="nesw-resize" onMove={(nx, ny) => onResizeRegion(x, y, width, height, offsetX, offsetY, nx, ny, "bottom_left", onChange)} />
          <ResizeHandle x={x + width} y={y + height} cursor="nwse-resize" onMove={(nx, ny) => onResizeRegion(x, y, width, height, offsetX, offsetY, nx, ny, "bottom_right", onChange)} />
        </>
      )}
    </>
  );
}

function ResizeHandle({ x, y, cursor, onMove }: { x: number; y: number; cursor: string; onMove: (x: number, y: number) => void }) {
  return (
    <Rect
      x={x - 7}
      y={y - 7}
      width={14}
      height={14}
      fill="#ffffff"
      stroke="#e05252"
      strokeWidth={2}
      draggable
      onMouseEnter={(event) => {
        const stage = event.target.getStage();
        if (stage) stage.container().style.cursor = cursor;
      }}
      onMouseLeave={(event) => {
        const stage = event.target.getStage();
        if (stage) stage.container().style.cursor = "default";
      }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        onMove(Math.round(event.target.x() + 7), Math.round(event.target.y() + 7));
      }}
    />
  );
}

function onResizeRegion(
  x: number,
  y: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  nextX: number,
  nextY: number,
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right",
  onChange: (update: Partial<Piece["transform"]>) => void
) {
  const minSize = 24;
  if (corner === "top_left") {
    const right = x + width;
    const bottom = y + height;
    const nx = Math.min(nextX, right - minSize);
    const ny = Math.min(nextY, bottom - minSize);
    onChange({ design_x: nx - offsetX, design_y: ny - offsetY, design_width: right - nx, design_height: bottom - ny });
  } else if (corner === "top_right") {
    const bottom = y + height;
    const ny = Math.min(nextY, bottom - minSize);
    onChange({ design_y: ny - offsetY, design_width: Math.max(minSize, nextX - x), design_height: bottom - ny });
  } else if (corner === "bottom_left") {
    const right = x + width;
    const nx = Math.min(nextX, right - minSize);
    onChange({ design_x: nx - offsetX, design_width: right - nx, design_height: Math.max(minSize, nextY - y) });
  } else {
    onChange({ design_width: Math.max(minSize, nextX - x), design_height: Math.max(minSize, nextY - y) });
  }
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

function makeMirrorTileCanvas(image: HTMLImageElement) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
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

function DimmedTextureLayer({
  piece,
  textureImage,
  frame,
  zoom = 1,
  stageWidth,
  stageHeight
}: {
  piece: Piece;
  textureImage: HTMLImageElement;
  frame: { x: number; y: number; width: number; height: number };
  zoom?: number;
  stageWidth: number;
  stageHeight: number;
}) {
  const frameScale = frame.width / Math.max(1, piece.width);
  const globalMode = piece.transform.mode === "global_canvas";
  const rotation = globalMode ? piece.transform.design_rotation ?? 0 : piece.transform.rotation;
  const cropX = wrapCropCoordinate((piece.transform.design_x ?? 0) + piece.transform.offset_x, textureImage.naturalWidth);
  const cropY = wrapCropCoordinate((piece.transform.design_y ?? 0) + piece.transform.offset_y, textureImage.naturalHeight);
  const crop = globalMode
    ? {
        x: cropX,
        y: cropY,
        width: Math.max(1, piece.transform.design_width ?? piece.width),
        height: Math.max(1, piece.transform.design_height ?? piece.height)
      }
    : undefined;
  const tiledSample = useTiledTextureSample(textureImage, crop || null);
  const imageCenterX = frame.x + frame.width / 2 + (globalMode ? 0 : piece.transform.offset_x * frameScale);
  const imageCenterY = frame.y + frame.height / 2 + (globalMode ? 0 : piece.transform.offset_y * frameScale);
  const basePatternSource = globalMode ? tiledSample || textureImage : textureImage;
  const patternSource = useMemo(
    () => getMirroredTexture(basePatternSource, piece.transform.mirror_x || false, piece.transform.mirror_y || false),
    [basePatternSource, piece.transform.mirror_x, piece.transform.mirror_y]
  );
  const sourceWidth = ("naturalWidth" in patternSource ? patternSource.naturalWidth || patternSource.width : patternSource.width) || 1;
  const sourceHeight = ("naturalHeight" in patternSource ? patternSource.naturalHeight || patternSource.height : patternSource.height) || 1;
  const patternScale = globalMode
    ? frame.width / Math.max(1, (tiledSample ? tiledSample.width : textureImage.naturalWidth) || 1)
    : piece.transform.scale * frameScale;
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
  textureImage,
  maskImage,
  frame,
  zoom = 1,
  draggable = false,
  onMove,
  onSelect
}: {
  piece: Piece;
  textureImage: HTMLImageElement;
  maskImage: CanvasImageSource;
  frame: { x: number; y: number; width: number; height: number };
  zoom?: number;
  draggable?: boolean;
  onMove?: (x: number, y: number) => void;
  onSelect?: () => void;
}) {
  const frameScale = frame.width / Math.max(1, piece.width);
  const globalMode = piece.transform.mode === "global_canvas";
  const cropX = wrapCropCoordinate((piece.transform.design_x ?? 0) + piece.transform.offset_x, textureImage.naturalWidth);
  const cropY = wrapCropCoordinate((piece.transform.design_y ?? 0) + piece.transform.offset_y, textureImage.naturalHeight);
  const crop = globalMode
    ? {
        x: cropX,
        y: cropY,
        width: Math.max(1, piece.transform.design_width ?? piece.width),
        height: Math.max(1, piece.transform.design_height ?? piece.height)
      }
    : undefined;
  const tiledSample = useTiledTextureSample(textureImage, crop || null);
  const renderedImage = tiledSample || textureImage;
  const imageWidth = globalMode ? frame.width : Math.max(1, textureImage.naturalWidth * piece.transform.scale * frameScale);
  const imageHeight = globalMode ? frame.height : Math.max(1, textureImage.naturalHeight * piece.transform.scale * frameScale);
  const imageCenterX = frame.x + frame.width / 2 + (globalMode ? 0 : piece.transform.offset_x * frameScale);
  const imageCenterY = frame.y + frame.height / 2 + (globalMode ? 0 : piece.transform.offset_y * frameScale);

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
        rotation={globalMode ? piece.transform.design_rotation ?? 0 : piece.transform.rotation}
        scaleX={piece.transform.mirror_x ? -1 : 1}
        scaleY={piece.transform.mirror_y ? -1 : 1}
        draggable={draggable && !piece.transform.locked}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(event) => {
          if (!onMove) return;
          if (globalMode) {
            const deltaX = Math.round((event.target.x() - (frame.x + frame.width / 2)) / frameScale);
            const deltaY = Math.round((event.target.y() - (frame.y + frame.height / 2)) / frameScale);
            event.target.x(frame.x + frame.width / 2);
            event.target.y(frame.y + frame.height / 2);
            onMove(piece.transform.offset_x - deltaX, piece.transform.offset_y - deltaY);
          } else {
            onMove(
              Math.round((event.target.x() - (frame.x + frame.width / 2)) / frameScale),
              Math.round((event.target.y() - (frame.y + frame.height / 2)) / frameScale)
            );
          }
        }}
      />
      <KonvaImage
        image={maskImage}
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        globalCompositeOperation="destination-in"
        onClick={onSelect}
        onTap={onSelect}
      />
    </Layer>
  );
}

function wrapCropCoordinate(value: number, size: number) {
  if (!Number.isFinite(value) || size <= 0) return 0;
  return ((value % size) + size) % size;
}

function useTiledTextureSample(
  textureImage: HTMLImageElement,
  crop: { x: number; y: number; width: number; height: number } | null
) {
  return useMemo(() => {
    if (!crop) return null;
    const sourceWidth = textureImage.naturalWidth || textureImage.width;
    const sourceHeight = textureImage.naturalHeight || textureImage.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) return null;
    const width = Math.max(1, Math.round(crop.width));
    const height = Math.max(1, Math.round(crop.height));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
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

function LayoutPieceTexture({
  piece,
  textureImage,
  selected,
  zoom,
  onSelect
}: {
  piece: Piece;
  textureImage: HTMLImageElement;
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
      textureImage={textureImage}
      maskImage={alphaMask}
      frame={{ x: piece.source_x, y: piece.source_y, width: piece.width, height: piece.height }}
      zoom={zoom}
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
      <Text x={piece.source_x + 8} y={piece.source_y + 8} text={piece.name} fill="#e05252" fontSize={14} />
    </>
  );
}
