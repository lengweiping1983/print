"use client";

import type { PieceTransform, SetPieceDef, SizeTemplate, SizeTemplatePiece, TemplateSet } from "@print-studio/shared-types";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { PIECE_ROLE_LABELS } from "@/lib/labels";

export default function SizeTemplateDetailPage() {
  const { setId, sizeId } = useParams<{ setId: string; sizeId: string }>();
  const [templateSet, setTemplateSet] = useState<TemplateSet | null>(null);
  const [sizeTemplate, setSizeTemplate] = useState<SizeTemplate | null>(null);
  const [pieces, setPieces] = useState<SizeTemplatePiece[]>([]);
  const [pieceDefs, setPieceDefs] = useState<SetPieceDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPieceId, setSelectedPieceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!setId || !sizeId) return;
    loadAll();
  }, [setId, sizeId]);

  async function loadAll() {
    if (!setId || !sizeId) return;
    setLoading(true);
    const [ts, st, pcs, defs] = await Promise.all([
      api.getTemplateSet(setId),
      api.listTemplateSetSizes(setId).then((sizes) => sizes.find((s) => s.id === sizeId) || null),
      api.listTemplateSizePieces(setId, sizeId),
      api.listTemplateSetPieceDefs(setId),
    ]);
    setTemplateSet(ts);
    setSizeTemplate(st);
    setPieces(pcs);
    setPieceDefs(defs);
    setSelectedPieceId(pcs[0]?.id || "");
    setLoading(false);
  }

  async function updatePieceDef(pieceId: string, pieceDefId: string) {
    if (!setId || !sizeId) return;
    setSaving(true);
    await api.patchTemplateSizePiece(setId, sizeId, pieceId, { piece_def_id: pieceDefId });
    const updated = await api.listTemplateSizePieces(setId, sizeId);
    setPieces(updated);
    setNotice("关联已更新");
    setSaving(false);
  }

  async function deletePiece(pieceId: string) {
    if (!setId || !sizeId) return;
    if (!confirm("确定删除该裁片吗？")) return;
    setSaving(true);
    await api.deleteTemplateSizePiece(setId, sizeId, pieceId);
    await loadAll();
    setNotice("裁片已删除");
    setSaving(false);
  }

  async function updateDefName(defId: string, name: string) {
    if (!setId) return;
    setSaving(true);
    await api.patchTemplateSetPieceDef(setId, defId, { name });
    await loadAll();
    setNotice("名称已更新");
    setSaving(false);
  }

  async function updateDefRole(defId: string, piece_role: string) {
    if (!setId) return;
    setSaving(true);
    await api.patchTemplateSetPieceDef(setId, defId, { piece_role });
    await loadAll();
    setNotice("角色已更新");
    setSaving(false);
  }

  async function updateBaseTransform(defId: string, patch: Partial<PieceTransform>) {
    if (!setId) return;
    setSaving(true);
    const def = pieceDefs.find((d) => d.id === defId);
    const current = (def?.base_transform || {}) as PieceTransform;
    await api.patchTemplateSetPieceDef(setId, defId, {
      base_transform: { ...current, ...patch },
    });
    await loadAll();
    setNotice("基准花位已更新");
    setSaving(false);
  }

  const selectedPiece = useMemo(() => pieces.find((p) => p.id === selectedPieceId) || pieces[0] || null, [pieces, selectedPieceId]);

  const bounds = useMemo(() => {
    if (!pieces.length) return { width: 800, height: 600 };
    const maxX = Math.max(...pieces.map((p) => p.source_x + p.width));
    const maxY = Math.max(...pieces.map((p) => p.source_y + p.height));
    return { width: Math.max(400, maxX + 40), height: Math.max(300, maxY + 40) };
  }, [pieces]);

  const scale = useMemo(() => {
    const containerW = 800;
    const containerH = 560;
    return Math.min(containerW / bounds.width, containerH / bounds.height, 1);
  }, [bounds]);

  if (loading) {
    return (
      <main className="min-h-screen bg-mist p-6 text-ink">
        <p className="text-slate-500">加载中...</p>
      </main>
    );
  }

  if (!templateSet || !sizeTemplate) {
    return (
      <main className="min-h-screen bg-mist p-6 text-ink">
        <p className="text-slate-500">数据不存在</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-mist p-6 text-ink">
      <header className="mb-4">
        <Link href={`/templates/${setId}`} className="text-sm text-action hover:underline">← 返回套装详情</Link>
        <h1 className="mt-1 text-2xl font-bold">
          {templateSet.name} · {sizeTemplate.size_name}
          {sizeTemplate.is_base && <span className="ml-2 rounded bg-action px-2 py-0.5 text-sm font-medium text-white">基准</span>}
        </h1>
      </header>

      {notice && (
        <div className="mb-4 rounded-lg border border-line bg-white px-4 py-2 text-sm shadow-panel">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-[220px_1fr_320px] gap-4 max-[1200px]:grid-cols-1">
        {/* Left: piece list */}
        <aside className="rounded-lg border border-line bg-white p-3 shadow-panel">
          <h2 className="mb-2 text-sm font-semibold">裁片列表</h2>
          <div className="max-h-[600px] space-y-2 overflow-auto">
            {pieces.map((piece) => (
              <div
                key={piece.id}
                className={`group flex items-center justify-between rounded border px-2 py-2 text-sm ${
                  piece.id === selectedPieceId ? "border-action bg-emerald-50" : "border-line bg-white"
                }`}
              >
                <button
                  onClick={() => setSelectedPieceId(piece.id)}
                  className="flex-1 text-left"
                >
                  <div className="font-medium">{piece.name}</div>
                  <div className="text-xs text-slate-500">
                    {piece.width}×{piece.height} · 比例 {piece.scale_to_base.toFixed(3)}
                  </div>
                </button>
                <button
                  onClick={() => deletePiece(piece.id)}
                  disabled={saving}
                  className="ml-2 rounded px-1.5 py-1 text-[10px] font-medium text-coral opacity-0 transition hover:bg-coral/10 group-hover:opacity-100 focus:opacity-100 disabled:opacity-50"
                  title="删除"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Center: layout preview */}
        <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
          <h2 className="mb-3 text-sm font-semibold">整套排版预览</h2>
          <div className="overflow-auto rounded border border-line bg-white">
            <div
              className="relative"
              style={{
                width: Math.floor(bounds.width * scale),
                height: Math.floor(bounds.height * scale),
              }}
            >
              {sizeTemplate.template_url && (
                <img
                  src={sizeTemplate.template_url}
                  alt="template"
                  className="absolute left-0 top-0 opacity-40"
                  style={{
                    width: Math.floor((sizeTemplate.width || bounds.width) * scale),
                    height: Math.floor((sizeTemplate.height || bounds.height) * scale),
                  }}
                />
              )}
              {pieces.map((piece) => (
                <div
                  key={piece.id}
                  onClick={() => setSelectedPieceId(piece.id)}
                  className={`absolute cursor-pointer border-2 transition ${
                    piece.id === selectedPieceId ? "border-action bg-emerald-100/40" : "border-coral bg-red-50/20"
                  }`}
                  style={{
                    left: piece.source_x * scale,
                    top: piece.source_y * scale,
                    width: piece.width * scale,
                    height: piece.height * scale,
                  }}
                >
                  <span className="absolute left-1 top-1 max-w-full truncate bg-white/80 px-1 text-[10px] font-medium text-ink">
                    {piece.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            画布尺寸：{bounds.width}×{bounds.height} · 缩放：{(scale * 100).toFixed(0)}%
          </p>
        </section>

        {/* Right: editor */}
        <aside className="rounded-lg border border-line bg-white p-4 shadow-panel">
          <h2 className="mb-3 text-sm font-semibold">裁片参数</h2>
          {selectedPiece ? (
            <div className="space-y-4 text-sm">
              <div>
                <span className="text-slate-500">名称：</span>
                <span className="font-medium">{selectedPiece.name}</span>
              </div>
              <div>
                <span className="text-slate-500">角色：</span>
                <span className="font-medium">{PIECE_ROLE_LABELS[selectedPiece.piece_role] || selectedPiece.piece_role || "未识别"}</span>
              </div>
              <div>
                <span className="text-slate-500">大小：</span>
                <span>
                  {selectedPiece.width}×{selectedPiece.height}
                </span>
              </div>
              <div>
                <span className="text-slate-500">位置：</span>
                <span>
                  ({selectedPiece.source_x}, {selectedPiece.source_y})
                </span>
              </div>
              <div>
                <span className="text-slate-500">相对于基准比例：</span>
                <span>{selectedPiece.scale_to_base.toFixed(4)}</span>
              </div>

              {sizeTemplate.is_base ? (
                (() => {
                  const def = pieceDefs.find((d) => d.id === selectedPiece.piece_def_id);
                  const bt = (def?.base_transform || {}) as PieceTransform;
                  const num = (label: string, key: keyof PieceTransform, min: number, max: number, step = 1) => (
                    <label key={key} className="block">
                      <span className="text-[10px] font-medium text-slate-500">{label}</span>
                      <input
                        type="number"
                        step={step}
                        min={min}
                        max={max}
                        className="mt-0.5 w-full rounded border border-line px-2 py-1 text-xs"
                        value={(bt[key] as number) ?? 0}
                        onChange={(e) => {
                          const v = step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                          if (!Number.isNaN(v)) updateBaseTransform(def!.id, { [key]: v } as Partial<PieceTransform>);
                        }}
                      />
                    </label>
                  );
                  return (
                    <div className="space-y-3 rounded bg-mist p-3">
                      <p className="text-xs text-slate-500">当前为基准尺寸，修改以下参数会同步影响所有尺寸。</p>
                      <label className="block">
                        <span className="text-xs font-semibold">裁片名称</span>
                        <input
                          className="mt-1 w-full rounded border border-line px-2 py-1"
                          defaultValue={selectedPiece.name}
                          onBlur={(e) => {
                            if (def && e.target.value !== def.name) {
                              updateDefName(def.id, e.target.value);
                            }
                          }}
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs font-semibold">裁片角色</span>
                        <select
                          className="mt-1 w-full rounded border border-line bg-white px-2 py-1"
                          defaultValue={selectedPiece.piece_role}
                          onChange={(e) => {
                            if (def) updateDefRole(def.id, e.target.value);
                          }}
                        >
                          {Object.entries(PIECE_ROLE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {def && (
                        <>
                          <div className="border-t border-line pt-2">
                            <p className="mb-2 text-xs font-semibold">基准花位设计</p>
                            <div className="grid grid-cols-2 gap-2">
                              {num("全局 X", "design_x", 0, 8192)}
                              {num("全局 Y", "design_y", 0, 8192)}
                              {num("平移 X", "offset_x", -1500, 1500)}
                              {num("平移 Y", "offset_y", -1500, 1500)}
                              {num("单片缩放", "scale", 0.2, 6, 0.01)}
                              {num("单片旋转", "rotation", -180, 180)}
                            </div>
                            <div className="mt-2 flex items-center gap-3">
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={bt.mirror_x || false}
                                  onChange={(e) => updateBaseTransform(def.id, { mirror_x: e.target.checked })}
                                />
                                水平镜像
                              </label>
                              <label className="flex items-center gap-1 text-xs">
                                <input
                                  type="checkbox"
                                  checked={bt.mirror_y || false}
                                  onChange={(e) => updateBaseTransform(def.id, { mirror_y: e.target.checked })}
                                />
                                垂直镜像
                              </label>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()
              ) : (
                <div className="space-y-3 rounded bg-amber-50 p-3">
                  <p className="text-xs text-amber-800">当前为非基准尺寸，若自动匹配有误，可手动关联到基准裁片。</p>
                  <label className="block">
                    <span className="text-xs font-semibold">关联基准裁片</span>
                    <select
                      disabled={saving}
                      className="mt-1 w-full rounded border border-line bg-white px-2 py-1"
                      value={selectedPiece.piece_def_id}
                      onChange={(e) => updatePieceDef(selectedPiece.id, e.target.value)}
                    >
                      <option value="">未关联</option>
                      {pieceDefs.map((def) => (
                        <option key={def.id} value={def.id}>
                          {def.name}（{def.piece_role}）
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <button
                onClick={() => deletePiece(selectedPiece.id)}
                disabled={saving}
                className="w-full rounded border border-coral/30 bg-coral/5 px-3 py-2 text-xs font-semibold text-coral hover:bg-coral/10"
              >
                删除该裁片
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-500">请选择裁片</p>
          )}
        </aside>
      </div>
    </main>
  );
}
