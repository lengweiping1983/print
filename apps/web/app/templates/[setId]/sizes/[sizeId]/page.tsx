"use client";

import type { SetPieceDef, SizeTemplate, SizeTemplatePiece, TemplateSet } from "@print-studio/shared-types";
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
              <button
                key={piece.id}
                onClick={() => setSelectedPieceId(piece.id)}
                className={`w-full rounded border px-2 py-2 text-left text-sm ${
                  piece.id === selectedPieceId ? "border-action bg-emerald-50" : "border-line bg-white"
                }`}
              >
                <div className="font-medium">{piece.name}</div>
                <div className="text-xs text-slate-500">
                  {piece.width}×{piece.height} · 比例 {piece.scale_to_base.toFixed(3)}
                </div>
              </button>
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
                <div className="space-y-3 rounded bg-mist p-3">
                  <p className="text-xs text-slate-500">当前为基准尺寸，修改以下参数会同步影响所有尺寸。</p>
                  <label className="block">
                    <span className="text-xs font-semibold">裁片名称</span>
                    <input
                      className="mt-1 w-full rounded border border-line px-2 py-1"
                      defaultValue={selectedPiece.name}
                      onBlur={(e) => {
                        const def = pieceDefs.find((d) => d.id === selectedPiece.piece_def_id);
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
                        const def = pieceDefs.find((d) => d.id === selectedPiece.piece_def_id);
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
                </div>
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
            </div>
          ) : (
            <p className="text-sm text-slate-500">请选择裁片</p>
          )}
        </aside>
      </div>
    </main>
  );
}
