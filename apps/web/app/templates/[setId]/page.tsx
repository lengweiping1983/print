"use client";

import type { SetPieceDef, SizeTemplate, SizeTemplatePiece, TemplateSet } from "@print-studio/shared-types";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { PIECE_ROLE_LABELS } from "@/lib/labels";

export default function TemplateSetDetailPage() {
  const { setId } = useParams<{ setId: string }>();
  const router = useRouter();
  const [templateSet, setTemplateSet] = useState<TemplateSet | null>(null);
  const [sizes, setSizes] = useState<SizeTemplate[]>([]);
  const [pieceDefs, setPieceDefs] = useState<SetPieceDef[]>([]);
  const [sizePiecesMap, setSizePiecesMap] = useState<Record<string, SizeTemplatePiece[]>>({});
  const [loading, setLoading] = useState(true);
  const [importingSize, setImportingSize] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!setId) return;
    refresh();
  }, [setId]);

  async function refresh() {
    if (!setId) return;
    setLoading(true);
    const [ts, szs, defs] = await Promise.all([
      api.getTemplateSet(setId),
      api.listTemplateSetSizes(setId),
      api.listTemplateSetPieceDefs(setId),
    ]);
    setTemplateSet(ts);
    setSizes(szs);
    setPieceDefs(defs);

    const piecesMap: Record<string, SizeTemplatePiece[]> = {};
    if (szs.length) {
      const piecesResults = await Promise.all(
        szs.map((s) => api.listTemplateSizePieces(setId, s.id).catch(() => [] as SizeTemplatePiece[]))
      );
      szs.forEach((s, idx) => {
        piecesMap[s.id] = piecesResults[idx];
      });
    }
    setSizePiecesMap(piecesMap);
    setLoading(false);
  }

  async function handleFile(sizeName: string, file: File) {
    if (!setId || !file) return;
    setImportingSize(sizeName);
    setNotice(`正在上传 ${sizeName} 模板图...`);
    try {
      const asset = await api.uploadTemplateSetAsset(setId, file);
      setNotice(`正在识别 ${sizeName} 尺寸裁片...`);
      const result = await api.importTemplateSetSize(setId, asset.id, sizeName);
      setSizes((prev) => [...prev, result.size_template]);
      if (result.warnings.length) {
        setNotice(`${sizeName} 导入完成，警告：${result.warnings.join("；")}`);
      } else {
        setNotice(`${sizeName} 导入完成，共 ${result.pieces.length} 个裁片。`);
      }
      await refresh();
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "导入失败"));
    } finally {
      setImportingSize("");
    }
  }

  async function setBase(sizeTemplateId: string) {
    if (!setId) return;
    await api.setTemplateSetBaseSize(setId, sizeTemplateId);
    await refresh();
    setNotice("基准尺寸已更新");
  }

  async function removeSize(sizeId: string, sizeName: string) {
    if (!setId) return;
    if (!confirm(`确定删除 ${sizeName} 尺寸模板吗？`)) return;
    await api.deleteTemplateSetSize(setId, sizeId);
    await refresh();
    setNotice(`${sizeName} 已删除`);
  }

  async function updateDefName(defId: string, name: string) {
    if (!setId) return;
    await api.patchTemplateSetPieceDef(setId, defId, { name });
    await refresh();
    setNotice("名称已更新");
  }

  async function updateDefRole(defId: string, piece_role: string) {
    if (!setId) return;
    await api.patchTemplateSetPieceDef(setId, defId, { piece_role });
    await refresh();
    setNotice("角色已更新");
  }

  async function reassignPiece(sizeId: string, pieceId: string, defId: string) {
    if (!setId) return;
    await api.patchTemplateSizePiece(setId, sizeId, pieceId, { piece_def_id: defId });
    await refresh();
    setNotice("关联已修正");
  }

  const sortedSizes = useMemo(() => {
    return [...sizes].sort((a, b) => a.size_name.localeCompare(b.size_name));
  }, [sizes]);

  const sortedDefs = useMemo(() => {
    return [...pieceDefs].sort((a, b) => a.sort_order - b.sort_order);
  }, [pieceDefs]);

  const problemSizes = useMemo(() => {
    const problems: string[] = [];
    for (const size of sortedSizes) {
      const pieces = sizePiecesMap[size.id] || [];
      if (pieces.length !== pieceDefs.length) {
        problems.push(size.size_name);
        continue;
      }
      const seen = new Set<string>();
      let ok = true;
      for (const p of pieces) {
        if (!p.piece_def_id || seen.has(p.piece_def_id)) {
          ok = false;
          break;
        }
        seen.add(p.piece_def_id);
      }
      if (!ok) problems.push(size.size_name);
    }
    return problems;
  }, [sortedSizes, sizePiecesMap, pieceDefs.length]);

  if (loading) {
    return (
      <main className="min-h-screen bg-mist p-6 text-ink">
        <p className="text-slate-500">加载中...</p>
      </main>
    );
  }

  if (!templateSet) {
    return (
      <main className="min-h-screen bg-mist p-6 text-ink">
        <p className="text-slate-500">套装不存在</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-mist p-6 text-ink">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <Link href="/templates" className="text-sm text-action hover:underline">← 返回列表</Link>
          <h1 className="mt-1 text-2xl font-bold">{templateSet.name}</h1>
          <p className="text-sm text-slate-500">
            {templateSet.version_label || "无版本"} · {" "}
            {templateSet.garment_type === "shirt" ? "衬衫" : templateSet.garment_type === "t_shirt" ? "T 恤" : "未知类型"} · 基准：
            {sizes.find((s) => s.is_base)?.size_name || "未设置"}
          </p>
        </div>
      </header>

      {templateSet.has_mapping_issues && (
        <div className="mb-4 rounded-lg border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
          <p className="font-semibold">⚠️ 当前套装存在裁片对应关系异常</p>
          <p className="mt-1">请在对照表中核对并修正，否则导出结果可能不正确。异常尺寸：{problemSizes.join("、") || "—"}</p>
        </div>
      )}

      {notice && !templateSet.has_mapping_issues && (
        <div className="mb-4 rounded-lg border border-line bg-white px-4 py-3 text-sm shadow-panel">
          {notice}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-line bg-white p-4 shadow-panel">
        <h2 className="mb-3 text-lg font-semibold">裁片定义（{pieceDefs.length} 个）</h2>
        {pieceDefs.length === 0 ? (
          <p className="text-sm text-slate-500">尚未导入任何尺寸模板，导入后会自动识别裁片类型。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pieceDefs.map((def) => (
              <span key={def.id} className="rounded-full bg-mist px-3 py-1 text-xs font-medium text-slate-700">
                {def.name}（{def.piece_role}）
              </span>
            ))}
          </div>
        )}
      </section>

      {sortedSizes.length > 0 && sortedDefs.length > 0 && (
        <section className="mb-6 rounded-lg border border-line bg-white p-4 shadow-panel">
          <h2 className="mb-4 text-lg font-semibold">裁片对照表</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-[180px] border border-line bg-slate-50 px-3 py-2 text-left font-semibold">
                    裁片定义
                  </th>
                  {sortedSizes.map((size) => (
                    <th
                      key={size.id}
                      className={`min-w-[120px] border border-line px-2 py-2 text-center font-semibold ${
                        problemSizes.includes(size.size_name) ? "bg-coral/10 text-coral" : "bg-slate-50"
                      }`}
                    >
                      {size.size_name}
                      {size.is_base && <span className="ml-1 text-[10px] text-action">基准</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedDefs.map((def) => (
                  <tr key={def.id}>
                    <td className="sticky left-0 z-10 border border-line bg-white px-3 py-2 align-top">
                      <div className="space-y-2">
                        <input
                          className="w-full rounded border border-line px-2 py-1 text-xs"
                          defaultValue={def.name}
                          onBlur={(e) => {
                            if (e.target.value !== def.name) {
                              updateDefName(def.id, e.target.value);
                            }
                          }}
                        />
                        <select
                          className="w-full rounded border border-line bg-white px-2 py-1 text-xs"
                          defaultValue={def.piece_role}
                          onChange={(e) => updateDefRole(def.id, e.target.value)}
                        >
                          {Object.entries(PIECE_ROLE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    {sortedSizes.map((size) => {
                      const pieces = (sizePiecesMap[size.id] || []).filter((p) => p.piece_def_id === def.id);
                      const unmatched = (sizePiecesMap[size.id] || []).filter((p) => !p.piece_def_id);
                      if (pieces.length === 0) {
                        return (
                          <td key={size.id} className="border border-line bg-coral/5 px-2 py-2 align-top text-center">
                            <div className="text-xs font-medium text-coral">缺失</div>
                            {unmatched.length > 0 && (
                              <select
                                className="mt-1 w-full rounded border border-coral/30 bg-white px-1 py-1 text-[10px]"
                                value=""
                                onChange={(e) => reassignPiece(size.id, e.target.value, def.id)}
                              >
                                <option value="">绑定未分配裁片</option>
                                {unmatched.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.width}×{p.height}
                                  </option>
                                ))}
                              </select>
                            )}
                          </td>
                        );
                      }
                      if (pieces.length > 1) {
                        return (
                          <td key={size.id} className="border border-line bg-coral/10 px-2 py-2 align-top text-center">
                            <div className="text-xs font-medium text-coral">重复绑定</div>
                            <div className="mt-1 text-[10px] text-slate-500">{pieces.length} 个裁片</div>
                          </td>
                        );
                      }
                      const piece = pieces[0];
                      return (
                        <td key={size.id} className="border border-line px-2 py-2 align-top text-center">
                          <img
                            src={piece.mask_url}
                            alt={piece.name}
                            className="checkerboard mx-auto h-12 w-12 rounded object-contain"
                          />
                          <div className="mt-1 text-[10px] text-slate-600">
                            {piece.width}×{piece.height}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
        <h2 className="mb-4 text-lg font-semibold">尺寸模板</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedSizes.map((size) => (
            <div
              key={size.id}
              className={`rounded-lg border p-4 transition ${size.is_base ? "border-action bg-emerald-50" : "border-line bg-white"}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold">{size.size_name}</h3>
                {size.is_base && <span className="rounded bg-action px-2 py-0.5 text-xs font-semibold text-white">基准</span>}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                裁片数：{size.pieces_count} · 宽×高：{size.width}×{size.height}
              </p>
              {size.template_url && (
                <img
                  src={size.template_url}
                  alt={size.size_name}
                  className="checkerboard mt-3 h-32 w-full rounded-md object-contain"
                />
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Link
                  href={`/templates/${setId}/sizes/${size.id}`}
                  className="rounded bg-white px-3 py-1.5 text-sm font-semibold ring-1 ring-line"
                >
                  查看裁片
                </Link>
                {!size.is_base && (
                  <button
                    onClick={() => setBase(size.id)}
                    className="rounded bg-jade px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    设为基准
                  </button>
                )}
                <button
                  onClick={() => removeSize(size.id, size.size_name)}
                  className="rounded bg-white px-3 py-1.5 text-sm font-semibold text-coral ring-1 ring-line"
                >
                  删除
                </button>
              </div>
            </div>
          ))}

          <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-line bg-white p-4 hover:bg-mist">
            <span className="text-sm font-semibold text-slate-600">+ 导入新尺寸</span>
            <span className="mt-1 text-xs text-slate-400">上传白底排版原图</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              disabled={Boolean(importingSize)}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const sizeName = prompt("请输入尺寸名称（如 S / M / L）：", "M");
                if (sizeName) handleFile(sizeName, file);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        {importingSize && <p className="mt-3 text-sm text-slate-500">正在导入 {importingSize}...</p>}
      </section>
    </main>
  );
}
