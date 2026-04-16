"use client";

import type { DesignCanvas, DesignLayer, Job, Piece, SafetyReportItem, Texture } from "@print-studio/shared-types";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PIECE_ROLE_LABELS } from "@/lib/labels";

export function ToastNotice({ notice, job }: { notice: string; job: Job | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!notice) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (job?.status === "succeeded") {
      const timer = setTimeout(() => setVisible(false), 30000);
      return () => clearTimeout(timer);
    }
  }, [notice, job?.status, job?.job_type]);

  if (!visible || !notice) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-line bg-white px-4 py-3 text-sm shadow-panel">
      <span className="mt-0.5 leading-5">{notice}</span>
      <button
        className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        onClick={() => setVisible(false)}
        aria-label="关闭提示"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18" />
          <path d="M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function SliderField({ label, value, min, max, step = 1, onChange, format }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void; format?: (v: number) => string }) {
  return (
    <label className="grid gap-1 text-xs font-semibold">
      <span className="flex justify-between">
        {label}
        <strong>{format ? format(value) : Number(value).toFixed(step < 1 ? 2 : 0)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-action"
      />
    </label>
  );
}

export function LayerEditor({
  layer,
  pieces,
  designCanvas,
  onChange,
  onDelete
}: {
  layer: DesignLayer;
  pieces: Piece[];
  designCanvas?: DesignCanvas | null;
  onChange: (update: Partial<DesignLayer>) => void;
  onDelete: () => void;
}) {
  const roles = Array.from(new Set(pieces.map((piece) => piece.transform.piece_role).filter(Boolean))) as string[];
  const canvasW = designCanvas?.width ?? 2400;
  const canvasH = designCanvas?.height ?? 1600;
  return (
    <div className="grid gap-3 rounded-lg border border-line p-3">
      <label className="grid gap-1 text-sm font-semibold">
        <span>图层名称</span>
        <input className="rounded-lg border border-line px-3 py-2" value={layer.name} onChange={(event) => onChange({ name: event.target.value })} />
      </label>
      {layer.type === "text" && (
        <label className="grid gap-1 text-sm font-semibold">
          <span>文字内容</span>
          <input className="rounded-lg border border-line px-3 py-2" value={layer.content || ""} onChange={(event) => onChange({ content: event.target.value })} />
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <SliderField label="X" value={layer.x} min={-Math.max(0, Math.round(layer.width))} max={canvasW} onChange={(x) => onChange({ x })} />
        <SliderField label="Y" value={layer.y} min={-Math.max(0, Math.round(layer.height))} max={canvasH} onChange={(y) => onChange({ y })} />
        <SliderField label="宽" value={layer.width} min={20} max={Math.round(canvasW * 1.5)} onChange={(width) => onChange({ width })} />
        <SliderField label="高" value={layer.height} min={20} max={Math.round(canvasH * 1.5)} onChange={(height) => onChange({ height })} />
        <SliderField label="旋转" value={layer.rotation} min={-180} max={180} step={1} onChange={(rotation) => onChange({ rotation })} />
        <SliderField label="透明度" value={layer.opacity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => onChange({ opacity })} />
      </div>
      {layer.type === "text" && (
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="字号" value={layer.font_size || 120} onChange={(font_size) => onChange({ font_size })} />
          <NumberField label="描边" value={layer.stroke_width || 0} onChange={(stroke_width) => onChange({ stroke_width })} />
          <label className="grid gap-1 text-xs font-semibold">
            <span>填充色</span>
            <input className="h-10 rounded-lg border border-line px-2" value={layer.fill || "#ffffff"} onChange={(event) => onChange({ fill: event.target.value })} />
          </label>
          <label className="grid gap-1 text-xs font-semibold">
            <span>描边色</span>
            <input className="h-10 rounded-lg border border-line px-2" value={layer.stroke || "#111111"} onChange={(event) => onChange({ stroke: event.target.value })} />
          </label>
        </div>
      )}
      <label className="grid gap-1 text-sm font-semibold">
        <span>目标部位</span>
        <select
          className="rounded-lg border border-line bg-white px-3 py-2"
          value={layer.target_roles[0] || ""}
          onChange={(event) => onChange({ target_roles: event.target.value ? [event.target.value] : [] })}
        >
          <option value="">自动匹配</option>
          {roles.map((role) => (
            <option key={role} value={role}>{PIECE_ROLE_LABELS[role] || role}</option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line p-2">
          <input type="checkbox" className="peer sr-only" checked={layer.visible} onChange={(event) => onChange({ visible: event.target.checked })} />
          <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-slate-200 transition peer-checked:bg-jade">
            <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition peer-checked:translate-x-5" />
          </span>
          <span className="font-medium">显示</span>
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-line p-2">
          <input type="checkbox" className="peer sr-only" checked={layer.locked} onChange={(event) => onChange({ locked: event.target.checked })} />
          <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-slate-200 transition peer-checked:bg-action">
            <span className="inline-block h-3.5 w-3.5 translate-x-1 rounded-full bg-white transition peer-checked:translate-x-5" />
          </span>
          <span className="font-medium">锁定</span>
        </label>
      </div>
      <button className="rounded-lg bg-white px-3 py-2 font-semibold text-coral ring-1 ring-line" onClick={onDelete}>
        删除图层
      </button>
    </div>
  );
}

export function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-1 text-xs font-semibold">
      <span>{label}</span>
      <input className="rounded-lg border border-line px-2 py-2" type="number" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function SafetyReportList({ report }: { report: SafetyReportItem[] }) {
  if (report.length === 0) {
    return <p className="m-0 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">暂无安全区风险。图层更新后会自动刷新检查结果。</p>;
  }
  return (
    <div className="grid gap-2">
      {report.map((item, index) => (
        <div key={`${item.layer_id}-${index}`} className={`rounded-lg p-3 text-xs leading-5 ${item.level === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
          <strong>{item.layer_name}</strong>：{item.message}
        </div>
      ))}
    </div>
  );
}

export function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="m-0 text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SinglePieceLoading() {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <h2 className="m-0 text-lg font-semibold">单裁片校正</h2>
      <p className="m-0 mt-1 text-sm text-slate-500">画布组件加载中...</p>
      <div className="checkerboard mt-3 flex h-[640px] items-center justify-center rounded-lg border border-line text-sm text-slate-500">
        正在准备裁片画布
      </div>
    </section>
  );
}

export function LayoutPreviewLoading() {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <h2 className="m-0 text-lg font-semibold">整套排版</h2>
      <p className="m-0 mt-1 text-sm text-slate-500">画布组件加载中...</p>
      <div className="checkerboard mt-3 flex h-[640px] items-center justify-center rounded-lg border border-line text-sm text-slate-500">
        正在准备排版画布
      </div>
    </section>
  );
}

export function FileField({
  label,
  accept,
  selectedName,
  onFile
}: {
  label: string;
  accept: string;
  selectedName?: string;
  onFile: (file: File) => void;
}) {
  return (
    <label className="mt-3 grid gap-2 text-sm font-semibold">
      {label}
      <input
        className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm"
        type="file"
        accept={accept}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = "";
        }}
      />
      <span className="min-h-5 break-all text-xs font-normal text-slate-500">{selectedName ? `已选择：${selectedName}` : "未选择文件"}</span>
    </label>
  );
}

export function Range({
  label,
  description,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold">
      <span className="flex justify-between">
        {label}
        <strong>{Number(value).toFixed(step < 1 ? 2 : 0)}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      {description && <span className="text-xs font-normal leading-5 text-slate-500">{description}</span>}
    </label>
  );
}

function PreviewPortal({ url, rect }: { url: string; rect: DOMRect }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] rounded-lg border border-line bg-white p-1 shadow-lg"
      style={{
        left: rect.left + rect.width / 2,
        top: rect.top - 8,
        transform: "translate(-50%, -100%)",
      }}
    >
      <img src={url} alt="" className="max-h-48 max-w-48 rounded-md object-contain" />
    </div>,
    document.body
  );
}

function useHoverPreview() {
  const [preview, setPreview] = useState<{ url: string; rect: DOMRect } | null>(null);
  const refs = useState(() => new Map<string, HTMLDivElement>())[0];

  const register = (id: string, url: string) => (el: HTMLDivElement | null) => {
    if (!el) {
      const prev = refs.get(id);
      if (prev) refs.delete(id);
      return;
    }
    if (refs.get(id) === el) return;
    refs.set(id, el);
    const enter = () => url && setPreview({ url, rect: el.getBoundingClientRect() });
    const leave = () => setPreview((p) => (p && p.url === url ? null : p));
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
  };

  return { preview, register };
}

export function ResourceBar({
  textures,
  imageLayers,
  activeTextureId,
  onDeleteTexture,
  onDeleteLayer,
  onSelectTexture,
}: {
  textures: Texture[];
  imageLayers: DesignLayer[];
  activeTextureId?: string;
  onDeleteTexture: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onSelectTexture: (id: string) => void;
}) {
  const { preview, register } = useHoverPreview();

  if (textures.length === 0 && imageLayers.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4">
      <div className="w-full max-w-5xl rounded-xl border border-line bg-white px-4 py-3 shadow-panel">
        <div className="flex items-start gap-4">
          {textures.length > 0 && (
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-sm font-semibold text-slate-700">面料 ({textures.length})</div>
              <div className="flex gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {textures.map((t) => {
                  const thumb = t.design_canvas_url || t.seamless_url || t.source_url;
                  const isActive = t.id === activeTextureId;
                  return (
                    <div key={t.id} ref={register(t.id, thumb || "")} className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectTexture(t.id)}
                        className={`block h-14 w-14 overflow-hidden rounded-lg border-2 ${isActive ? "border-action" : "border-transparent"} bg-slate-50`}
                        title="切换面料"
                      >
                        {thumb ? (
                          <img src={thumb} alt="面料" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">无图</div>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteTexture(t.id);
                        }}
                        className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs text-slate-500 shadow hover:text-coral ring-1 ring-line"
                        title="删除"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {textures.length > 0 && imageLayers.length > 0 && <div className="w-px self-stretch bg-line" />}

          {imageLayers.length > 0 && (
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-sm font-semibold text-slate-700">图片 ({imageLayers.length})</div>
              <div className="flex gap-2 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {imageLayers.map((layer) => {
                  const thumb = layer.source_url || "";
                  return (
                    <div key={layer.id} ref={register(layer.id, thumb)} className="relative shrink-0">
                      <div className="h-14 w-14 overflow-hidden rounded-lg border border-line bg-slate-50">
                        {thumb ? (
                          <img src={thumb} alt={layer.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-400">无图</div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteLayer(layer.id);
                        }}
                        className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-white text-xs text-slate-500 shadow hover:text-coral ring-1 ring-line"
                        title="删除"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      {preview && (
        <PreviewPortal url={preview.url} rect={preview.rect} />
      )}
    </div>
  );
}
