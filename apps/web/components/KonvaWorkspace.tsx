"use client";

import type { Piece, Texture } from "@print-studio/shared-types";
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

type Props = {
  pieces: Piece[];
  selectedPieceId: string;
  texture: Texture | null;
  textureUrl: string;
  onSelectPiece: (id: string) => void;
  onMovePiece: (piece: Piece, x: number, y: number) => void;
};

export function KonvaWorkspace({ pieces, selectedPieceId, texture, textureUrl, onSelectPiece, onMovePiece }: Props) {
  const textureImage = useLoadedImage(textureUrl);
  const selected = pieces.find((piece) => piece.id === selectedPieceId) ?? pieces[0];
  const maskImage = useLoadedImage(selected?.mask_url || "");
  const alphaMaskImage = useLuminanceMaskImage(maskImage);
  const [pieceZoom, setPieceZoom] = useState(1);
  const [layoutZoom, setLayoutZoom] = useState(0.25);
  const selectedMaskFrame = useMemo(() => {
    if (!selected) return null;
    const width = 440;
    const height = Math.min(520, Math.max(160, selected.height * (width / Math.max(1, selected.width))));
    return { x: 40, y: 60, width, height };
  }, [selected]);
  const bounds = useMemo(() => {
    const width = Math.max(1200, ...pieces.map((piece) => piece.source_x + piece.width + 80), 1200);
    const height = Math.max(760, ...pieces.map((piece) => piece.source_y + piece.height + 80), 760);
    return { width, height };
  }, [pieces]);
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
    <div className="grid min-h-[760px] grid-cols-[minmax(360px,0.9fr)_minmax(520px,1.1fr)] gap-4 max-[1280px]:grid-cols-1">
      <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-lg font-semibold">单片校正</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">拖动裁片中的布料，微调重点花位。</p>
          </div>
          <div className="flex items-center gap-2">
            <ZoomButton label="-" onClick={() => setPieceZoom((zoom) => clampZoom(zoom - 0.1))} />
            <span className="min-w-14 rounded-md bg-mist px-2 py-1 text-center text-xs text-slate-600">{Math.round(pieceZoom * 100)}%</span>
            <ZoomButton label="+" onClick={() => setPieceZoom((zoom) => clampZoom(zoom + 0.1))} />
          </div>
        </div>
        <div className="checkerboard overflow-hidden rounded-lg border border-line">
          <Stage width={520} height={640}>
            <Layer>
              <Rect x={0} y={0} width={520} height={640} fill="rgba(255,255,255,0.6)" />
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
            <Layer scaleX={pieceZoom} scaleY={pieceZoom}>
              {selectedMaskFrame && selected && (
                <Rect
                  x={selectedMaskFrame.x}
                  y={selectedMaskFrame.y}
                  width={selectedMaskFrame.width}
                  height={selectedMaskFrame.height}
                  stroke="#e05252"
                  strokeWidth={2}
                  dash={[10, 7]}
                />
              )}
            </Layer>
          </Stage>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-lg font-semibold">整套排版</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">按模板原始坐标回排，导出时保持同一坐标系。</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="rounded-md bg-mist px-2 py-1 text-xs text-slate-600">{pieces.length} 个裁片</span>
            <ZoomButton label="适配" onClick={() => setLayoutZoom(fitZoom)} />
            <ZoomButton label="-" onClick={() => setLayoutZoom((zoom) => clampZoom(zoom - 0.05))} />
            <span className="min-w-14 rounded-md bg-mist px-2 py-1 text-center text-xs text-slate-600">{Math.round(layoutZoom * 100)}%</span>
            <ZoomButton label="+" onClick={() => setLayoutZoom((zoom) => clampZoom(zoom + 0.05))} />
            <ZoomButton label="100%" onClick={() => setLayoutZoom(1)} />
          </div>
        </div>
        <div className="checkerboard max-h-[760px] overflow-auto rounded-lg border border-line">
          <Stage width={Math.ceil(bounds.width * layoutZoom)} height={Math.ceil(bounds.height * layoutZoom)}>
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              <Rect x={0} y={0} width={bounds.width} height={bounds.height} fill="rgba(255,255,255,0.55)" />
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
            <Layer scaleX={layoutZoom} scaleY={layoutZoom}>
              {pieces.map((piece) => (
                <PieceOutline
                  key={`outline-${piece.id}`}
                  piece={piece}
                  selected={piece.id === selectedPieceId}
                  onSelect={() => onSelectPiece(piece.id)}
                />
              ))}
            </Layer>
          </Stage>
        </div>
      </section>
    </div>
  );
}

function clampZoom(value: number) {
  return Math.min(2, Math.max(0.05, Number(value.toFixed(2))));
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-ink ring-1 ring-line" onClick={onClick}>
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
  const imageWidth = Math.max(1, textureImage.naturalWidth * piece.transform.scale * frameScale);
  const imageHeight = Math.max(1, textureImage.naturalHeight * piece.transform.scale * frameScale);
  const imageCenterX = frame.x + frame.width / 2 + piece.transform.offset_x * frameScale;
  const imageCenterY = frame.y + frame.height / 2 + piece.transform.offset_y * frameScale;

  return (
    <Layer scaleX={zoom} scaleY={zoom}>
      <KonvaImage
        image={textureImage}
        x={imageCenterX}
        y={imageCenterY}
        width={imageWidth}
        height={imageHeight}
        offsetX={imageWidth / 2}
        offsetY={imageHeight / 2}
        rotation={piece.transform.rotation}
        scaleX={piece.transform.mirror_x ? -1 : 1}
        scaleY={piece.transform.mirror_y ? -1 : 1}
        draggable={draggable && !piece.transform.locked}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(event) => {
          if (!onMove) return;
          onMove(
            Math.round((event.target.x() - (frame.x + frame.width / 2)) / frameScale),
            Math.round((event.target.y() - (frame.y + frame.height / 2)) / frameScale)
          );
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

function PieceOutline({ piece, selected, onSelect }: { piece: Piece; selected: boolean; onSelect: () => void }) {
  return (
    <>
      <Rect
        x={piece.source_x}
        y={piece.source_y}
        width={piece.width}
        height={piece.height}
        stroke={selected ? "#e05252" : "#2563eb"}
        strokeWidth={selected ? 4 : 2}
        dash={selected ? [] : [9, 7]}
        onClick={onSelect}
        onTap={onSelect}
      />
      <Text x={piece.source_x + 8} y={piece.source_y + 8} text={piece.name} fill="#e05252" fontSize={14} />
    </>
  );
}
