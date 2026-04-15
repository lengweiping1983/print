"use client";

import type { Piece } from "@print-studio/shared-types";
import { PIECE_ROLE_LABELS } from "@/lib/labels";
import "konva/lib/shapes/Image.js";
import "konva/lib/shapes/Rect.js";
import "konva/lib/shapes/Text.js";
import { useEffect, useMemo, useState } from "react";
import { Image as KonvaImage, Layer, Rect, Stage, Text } from "react-konva/es/ReactKonvaCore.js";

function useLoadedImage(src: string) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImage(null);
      return;
    }
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setImage(img);
    img.src = src;
  }, [src]);
  return image;
}

function useLuminanceMaskImage(image: HTMLImageElement | null) {
  const [mask, setMask] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!image) {
      setMask(null);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d");
    if (!context) {
      setMask(null);
      return;
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = Math.max(data[index], data[index + 1], data[index + 2]);
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }
    context.putImageData(imageData, 0, 0);
    setMask(canvas);
  }, [image]);

  return mask;
}

function useMaskOutlineImage(mask: HTMLCanvasElement | null, strokeWidth = 1) {
  const [outline, setOutline] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!mask) {
      setOutline(null);
      return;
    }

    const context = mask.getContext("2d");
    if (!context) {
      setOutline(null);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const outlineContext = canvas.getContext("2d");
    if (!outlineContext) {
      setOutline(null);
      return;
    }

    const radius = Math.max(1, Math.round(strokeWidth));
    for (let y = -radius; y <= radius; y += 1) {
      for (let x = -radius; x <= radius; x += 1) {
        if (x * x + y * y > radius * radius) continue;
        outlineContext.drawImage(mask, x, y);
      }
    }
    outlineContext.globalCompositeOperation = "source-in";
    outlineContext.fillStyle = "#e05252";
    outlineContext.fillRect(0, 0, canvas.width, canvas.height);
    outlineContext.globalCompositeOperation = "destination-out";
    outlineContext.drawImage(mask, 0, 0);
    outlineContext.globalCompositeOperation = "source-over";
    setOutline(canvas);
  }, [mask, strokeWidth]);

  return outline;
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
  const alphaMaskImage = useLuminanceMaskImage(maskImage);
  const selectedOutlineImage = useMaskOutlineImage(alphaMaskImage, outlineWidth);
  const [pieceZoom, setPieceZoom] = useState(1);
  const selectedMaskFrame = useMemo(() => {
    if (!selected) return null;
    const scale = Math.min(440 / Math.max(1, selected.width), 520 / Math.max(1, selected.height));
    const width = Math.max(1, selected.width * scale);
    const height = Math.max(1, selected.height * scale);
    return { x: (520 - width) / 2, y: (640 - height) / 2, width, height };
  }, [selected]);

  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">单片校正</h2>
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
              className="rounded-lg border border-line bg-white px-1.5 py-1 text-xs font-semibold text-ink"
              value={outlineWidth}
              onChange={(event) => onOutlineWidthChange(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => (
                <option key={v} value={v}>{v}px</option>
              ))}
            </select>
          )}
          <ZoomButton label="-" onClick={() => setPieceZoom((zoom) => clampZoom(zoom - 0.1))} />
          <span className="min-w-14 rounded-md bg-mist px-2 py-1 text-center text-xs text-slate-600">{Math.round(pieceZoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => setPieceZoom((zoom) => clampZoom(zoom + 0.1))} />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-white">
        <Stage width={520} height={640}>
          <Layer>
            <Rect x={0} y={0} width={520} height={640} fill="#ffffff" />
            {!selected && <Text x={160} y={300} text="请先导入裁片模板" fill="#64748b" fontSize={18} />}
            {selected && !textureImage && <Text x={145} y={300} text="请上传图案或生成纹理" fill="#64748b" fontSize={18} />}
          </Layer>
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
          {showOutlines && (
            <Layer scaleX={pieceZoom} scaleY={pieceZoom}>
              {selectedMaskFrame && selectedOutlineImage && (
                <KonvaImage
                  image={selectedOutlineImage}
                  x={selectedMaskFrame.x}
                  y={selectedMaskFrame.y}
                  width={selectedMaskFrame.width}
                  height={selectedMaskFrame.height}
                />
              )}
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
  showOutlines: boolean;
  outlineWidth?: number;
  onSelectPiece: (id: string) => void;
};

export function LayoutPreview({ pieces, selectedPieceId, textureUrl, showOutlines, outlineWidth = 1, onSelectPiece }: LayoutPreviewProps) {
  const textureImage = useLoadedImage(textureUrl);
  const [layoutZoom, setLayoutZoom] = useState(0.25);
  const [previewMode, setPreviewMode] = useState<"layout" | "design">("layout");
  const bounds = useMemo(() => {
    if (previewMode === "design" && textureImage) {
      return { width: Math.max(1200, textureImage.naturalWidth), height: Math.max(760, textureImage.naturalHeight) };
    }
    const width = Math.max(1200, ...pieces.map((piece) => piece.source_x + piece.width + 80), 1200);
    const height = Math.max(760, ...pieces.map((piece) => piece.source_y + piece.height + 80), 760);
    return { width, height };
  }, [pieces, previewMode, textureImage]);
  const fitZoom = useMemo(() => {
    const maxWidth = 980;
    const maxHeight = 720;
    const next = Math.min(maxWidth / bounds.width, maxHeight / bounds.height, 1);
    return Math.max(0.05, Number(next.toFixed(2)));
  }, [bounds]);

  useEffect(() => {
    setLayoutZoom(fitZoom);
  }, [fitZoom]);

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
          <span className="rounded-md bg-mist px-2 py-1 text-xs text-slate-600">{pieces.length} 个裁片</span>
          <ZoomButton label="排版" onClick={() => setPreviewMode("layout")} />
          <ZoomButton label="设计画布" onClick={() => setPreviewMode("design")} />
          <ZoomButton label="-" onClick={() => setLayoutZoom((zoom) => clampZoom(zoom - 0.05))} />
          <span className="min-w-14 rounded-md bg-mist px-2 py-1 text-center text-xs text-slate-600">{Math.round(layoutZoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => setLayoutZoom((zoom) => clampZoom(zoom + 0.05))} />
          <ZoomButton label="100%" onClick={() => setLayoutZoom(1)} />
        </div>
      </div>
      <div className="flex max-h-[760px] justify-center overflow-auto rounded-lg border border-line bg-white">
        <Stage width={Math.ceil(bounds.width * layoutZoom)} height={Math.ceil(bounds.height * layoutZoom)}>
          <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
            <Rect x={0} y={0} width={bounds.width} height={bounds.height} fill="#ffffff" />
            {previewMode === "design" && textureImage && <KonvaImage image={textureImage} x={0} y={0} width={bounds.width} height={bounds.height} />}
          </Layer>
          {previewMode === "layout" &&
            textureImage &&
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
          {previewMode === "design" && (
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              {pieces.map((piece) => (
                <DesignRegionOutline key={`design-${piece.id}`} piece={piece} selected={piece.id === selectedPieceId} outlineWidth={outlineWidth} onSelect={() => onSelectPiece(piece.id)} />
              ))}
            </Layer>
          )}
          {previewMode === "layout" && showOutlines && (
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              {pieces.map((piece) => (
                <PieceOutline
                  key={`outline-${piece.id}`}
                  piece={piece}
                  selected={piece.id === selectedPieceId}
                  outlineWidth={outlineWidth}
                  onSelect={() => onSelectPiece(piece.id)}
                />
              ))}
            </Layer>
          )}
        </Stage>
      </div>
    </section>
  );
}

function DesignRegionOutline({ piece, selected, outlineWidth, onSelect }: { piece: Piece; selected: boolean; outlineWidth: number; onSelect: () => void }) {
  const x = piece.transform.design_x ?? piece.source_x;
  const y = piece.transform.design_y ?? piece.source_y;
  const width = piece.transform.design_width ?? piece.width;
  const height = piece.transform.design_height ?? piece.height;
  return (
    <>
      <Rect
        x={x}
        y={y}
        width={width}
        height={height}
        stroke={selected ? "#e05252" : "#2563eb"}
        strokeWidth={outlineWidth}
        dash={selected ? [] : [12, 8]}
        onClick={onSelect}
        onTap={onSelect}
      />
      <Text x={x + 8} y={y + 8} text={(piece.transform.piece_role ? PIECE_ROLE_LABELS[piece.transform.piece_role] || piece.transform.piece_role : "") || piece.name} fill={selected ? "#e05252" : "#0f172a"} fontSize={24} onClick={onSelect} onTap={onSelect} />
    </>
  );
}

function clampZoom(value: number) {
  return Math.min(2, Math.max(0.05, Number(value.toFixed(2))));
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-ink ring-1 ring-line" onClick={onClick}>
      {label}
    </button>
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
  const imageWidth = globalMode ? frame.width : Math.max(1, textureImage.naturalWidth * piece.transform.scale * frameScale);
  const imageHeight = globalMode ? frame.height : Math.max(1, textureImage.naturalHeight * piece.transform.scale * frameScale);
  const imageCenterX = frame.x + frame.width / 2 + (globalMode ? 0 : piece.transform.offset_x * frameScale);
  const imageCenterY = frame.y + frame.height / 2 + (globalMode ? 0 : piece.transform.offset_y * frameScale);

  return (
    <Layer scaleX={zoom} scaleY={zoom}>
      <KonvaImage
        image={textureImage}
        crop={crop}
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
  const alphaMask = useLuminanceMaskImage(mask);
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
  const mask = useLoadedImage(piece.mask_url);
  const alphaMask = useLuminanceMaskImage(mask);
  const outline = useMaskOutlineImage(alphaMask, outlineWidth);
  return (
    <>
      {outline && (
        <KonvaImage
          image={outline}
          x={piece.source_x}
          y={piece.source_y}
          width={piece.width}
          height={piece.height}
          opacity={selected ? 1 : 0.55}
          onClick={onSelect}
          onTap={onSelect}
        />
      )}
      <Rect
        x={piece.source_x}
        y={piece.source_y}
        width={piece.width}
        height={piece.height}
        stroke="rgba(0,0,0,0)"
        strokeWidth={1}
        onClick={onSelect}
        onTap={onSelect}
      />
      <Text x={piece.source_x + 8} y={piece.source_y + 8} text={piece.name} fill="#e05252" fontSize={14} />
    </>
  );
}
