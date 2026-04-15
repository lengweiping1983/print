"use client";

import type { DesignLayer, Job, Piece, SafetyReportItem } from "@print-studio/shared-types";
import { useEffect, useState } from "react";
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

export function LayerEditor({
  layer,
  pieces,
  onChange,
  onDelete
}: {
  layer: DesignLayer;
  pieces: Piece[];
  onChange: (update: Partial<DesignLayer>) => void;
  onDelete: () => void;
}) {
  const roles = Array.from(new Set(pieces.map((piece) => piece.transform.piece_role).filter(Boolean))) as string[];
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
        <NumberField label="X" value={layer.x} onChange={(x) => onChange({ x })} />
        <NumberField label="Y" value={layer.y} onChange={(y) => onChange({ y })} />
        <NumberField label="宽" value={layer.width} onChange={(width) => onChange({ width })} />
        <NumberField label="高" value={layer.height} onChange={(height) => onChange({ height })} />
        <NumberField label="旋转" value={layer.rotation} onChange={(rotation) => onChange({ rotation })} />
        <NumberField label="透明度" value={layer.opacity} step={0.05} onChange={(opacity) => onChange({ opacity })} />
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
        <label className="rounded-lg border border-line p-2">
          <input type="checkbox" checked={layer.visible} onChange={(event) => onChange({ visible: event.target.checked })} /> 显示
        </label>
        <label className="rounded-lg border border-line p-2">
          <input type="checkbox" checked={layer.locked} onChange={(event) => onChange({ locked: event.target.checked })} /> 锁定
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

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <h2 className="m-0 mb-3 text-lg font-semibold">{title}</h2>
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
