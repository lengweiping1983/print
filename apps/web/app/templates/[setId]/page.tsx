"use client";

import type { SetPieceDef, SizeTemplate, SizeTemplatePiece, TemplateSet } from "@print-studio/shared-types";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { PIECE_ROLE_LABELS } from "@/lib/labels";

type BatchItem = {
  id: string;
  file: File;
  sizeName: string;
  status: "pending" | "uploading" | "importing" | "done" | "error";
  message: string;
};

function guessSizeName(filename: string): string {
  const base = filename.replace(/\.[^/.]+$/, "");
  const m = base.match(/\b(XS|S|M|L|XL|XXL|XXXL|XXS)\b/i);
  if (m) return m[1].toUpperCase();
  const numM = base.match(/\b(\d{2,3})\s*[码号]?\b/);
  if (numM) return numM[1];
  return "";
}

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

  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{
    sizeId: string;
    sizeName: string;
    defId: string;
    defName: string;
  } | null>(null);

  useEffect(() => {
    if (!setId) return;
    refresh();
  }, [setId]);

  useEffect(() => {
    function handleVisibility() {
      if (!document.hidden) refresh();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

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

  function openBatch(files: FileList) {
    const items: BatchItem[] = Array.from(files).map((file, idx) => ({
      id: `batch_${idx}_${Date.now()}`,
      file,
      sizeName: guessSizeName(file.name),
      status: "pending",
      message: "等待中",
    }));
    setBatchQueue(items);
    setBatchOpen(true);
  }

  async function runBatchImport() {
    if (!setId || batchQueue.length === 0) return;
    setBatchRunning(true);
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < batchQueue.length; i++) {
      const item = batchQueue[i];
      if (!item.sizeName.trim()) {
        updateBatchItem(i, { status: "error", message: "缺少尺寸名称" });
        errorCount++;
        continue;
      }
      updateBatchItem(i, { status: "uploading", message: "上传中..." });
      try {
        const asset = await api.uploadTemplateSetAsset(setId, item.file);
        updateBatchItem(i, { status: "importing", message: "识别裁片中..." });
        const result = await api.importTemplateSetSize(setId, asset.id, item.sizeName.trim());
        const msg = result.warnings.length
          ? `完成，警告：${result.warnings.join("；")}`
          : `完成，共 ${result.pieces.length} 个裁片`;
        updateBatchItem(i, { status: "done", message: msg });
        successCount++;
      } catch (err) {
        updateBatchItem(i, {
          status: "error",
          message: String(err instanceof Error ? err.message : "导入失败"),
        });
        errorCount++;
      }
    }

    await refresh();
    setBatchRunning(false);
    setNotice(`批量导入结束：成功 ${successCount} 个，失败 ${errorCount} 个`);
  }

  function updateBatchItem(index: number, patch: Partial<BatchItem>) {
    setBatchQueue((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
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

  async function deleteDef(defId: string) {
    if (!setId) return;
    if (!confirm("确定删除该裁片定义吗？删除后所有尺寸中关联到该定义的裁片将变为未关联。")) return;
    await api.deleteTemplateSetPieceDef(setId, defId);
    await refresh();
    setNotice("裁片定义已删除");
  }

  async function reassignPiece(sizeId: string, pieceId: string, defId: string) {
    if (!setId) return;
    await api.patchTemplateSizePiece(setId, sizeId, pieceId, { piece_def_id: defId });
    await refresh();
    setNotice("关联已修正");
  }

  function openPicker(sizeId: string, sizeName: string, defId: string, defName: string) {
    setPickerTarget({ sizeId, sizeName, defId, defName });
    setPickerOpen(true);
  }

  async function pickPieceForDef(sizeId: string, defId: string, selectedPieceId: string) {
    if (!setId) return;
    const allPieces = sizePiecesMap[sizeId] || [];
    const pieceA = allPieces.find((p) => p.piece_def_id === defId);
    const pieceB = allPieces.find((p) => p.id === selectedPieceId);
    if (!pieceB) return;
    if (pieceA && pieceA.id === pieceB.id) {
      setPickerOpen(false);
      return;
    }
    const defB = pieceB.piece_def_id;
    try {
      const promises: Promise<unknown>[] = [
        api.patchTemplateSizePiece(setId, sizeId, pieceB.id, { piece_def_id: defId }),
      ];
      if (pieceA) {
        promises.push(api.patchTemplateSizePiece(setId, sizeId, pieceA.id, { piece_def_id: defB }));
      }
      await Promise.all(promises);
      await refresh();
      setNotice("对应关系已更新");
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "更新失败"));
    } finally {
      setPickerOpen(false);
    }
  }

  async function clearPieceDef(sizeId: string, defId: string) {
    if (!setId) return;
    const allPieces = sizePiecesMap[sizeId] || [];
    const pieceA = allPieces.find((p) => p.piece_def_id === defId);
    if (!pieceA) {
      setPickerOpen(false);
      return;
    }
    try {
      await api.patchTemplateSizePiece(setId, sizeId, pieceA.id, { piece_def_id: "" });
      await refresh();
      setNotice("对应关系已清空");
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : "更新失败"));
    } finally {
      setPickerOpen(false);
    }
  }

  async function confirmMapping() {
    if (!setId) return;
    if (problemSizes.length > 0) {
      setNotice("请先修正异常尺寸后再确认");
      return;
    }
    if (!confirm("确认当前裁片对照表无误吗？确认后该模板套装将标记为可用。")) return;
    await api.confirmTemplateSetMapping(setId);
    await refresh();
    setNotice("对照表已确认，模板套装可用");
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

  const batchProgress = useMemo(() => {
    if (batchQueue.length === 0) return 0;
    const done = batchQueue.filter((i) => i.status === "done" || i.status === "error").length;
    return Math.round((done / batchQueue.length) * 100);
  }, [batchQueue]);

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
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (!confirm(`确定删除套装「${templateSet.name}」？所有尺寸、裁片定义和文件都将被清空，且不可恢复。`)) return;
              await api.deleteTemplateSet(templateSet.id);
              router.push("/templates");
            }}
            className="rounded-lg border border-coral px-3 py-2 text-sm font-medium text-coral hover:bg-coral/10"
          >
            删除套装
          </button>
        </div>
      </header>

      {problemSizes.length > 0 ? (
        <div className="mb-4 rounded-lg border border-coral/30 bg-coral/10 px-4 py-3 text-sm text-coral">
          <p className="font-semibold">⚠️ 当前套装存在裁片对应关系异常</p>
          <p className="mt-1">请在对照表中核对并修正，否则导出结果可能不正确。异常尺寸：{problemSizes.join("、")}</p>
        </div>
      ) : !templateSet.mapping_confirmed_at ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-semibold">⏳ 裁片对应关系待确认</p>
          <p className="mt-1">当前各尺寸裁片一一对应正常，但尚未经过人工确认。点击下方「确认对照表」按钮后，该套装才可被项目使用。</p>
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <p className="font-semibold">✅ 已确认</p>
          <p className="mt-1">裁片对照表已确认无误，该模板套装可用。</p>
        </div>
      )}

      {notice && (
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
                      <button
                        onClick={() => deleteDef(def.id)}
                        className="mt-2 rounded px-2 py-1 text-[10px] font-medium text-coral hover:bg-coral/10"
                      >
                        删除定义
                      </button>
                    </td>
                    {sortedSizes.map((size) => {
                      const pieces = (sizePiecesMap[size.id] || []).filter((p) => p.piece_def_id === def.id);
                      const unmatched = (sizePiecesMap[size.id] || []).filter((p) => !p.piece_def_id);
                      if (pieces.length === 0) {
                        return (
                          <td
                            key={size.id}
                            onClick={() => openPicker(size.id, size.size_name, def.id, def.name)}
                            className="cursor-pointer border border-line bg-coral/5 px-2 py-2 align-top text-center hover:bg-coral/10"
                          >
                            <div className="text-xs font-medium text-coral">缺失</div>
                            {unmatched.length > 0 && (
                              <div className="mt-1 text-[10px] text-slate-400">点击修正</div>
                            )}
                          </td>
                        );
                      }
                      if (pieces.length > 1) {
                        return (
                          <td
                            key={size.id}
                            onClick={() => openPicker(size.id, size.size_name, def.id, def.name)}
                            className="cursor-pointer border border-line bg-coral/10 px-2 py-2 align-top text-center hover:bg-coral/20"
                          >
                            <div className="text-xs font-medium text-coral">重复绑定</div>
                            <div className="mt-1 text-[10px] text-slate-500">{pieces.length} 个裁片</div>
                            <div className="text-[10px] text-slate-400">点击修正</div>
                          </td>
                        );
                      }
                      const piece = pieces[0];
                      return (
                        <td
                          key={size.id}
                          onClick={() => openPicker(size.id, size.size_name, def.id, def.name)}
                          className="cursor-pointer border border-line px-2 py-2 align-top text-center hover:bg-slate-50"
                        >
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
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={confirmMapping}
              disabled={Boolean(problemSizes.length) || Boolean(templateSet.mapping_confirmed_at)}
              className={`rounded px-4 py-2 text-sm font-semibold ${
                problemSizes.length > 0 || templateSet.mapping_confirmed_at
                  ? "cursor-not-allowed bg-slate-200 text-slate-500"
                  : "bg-action text-white hover:bg-action/90"
              }`}
            >
              {templateSet.mapping_confirmed_at ? "已确认" : "确认对照表"}
            </button>
            {problemSizes.length > 0 && (
              <span className="text-xs text-coral">存在对应异常，无法确认</span>
            )}
            {!templateSet.mapping_confirmed_at && problemSizes.length === 0 && (
              <span className="text-xs text-slate-500">确认后该套装才可在项目中使用</span>
            )}
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
            <span className="mt-1 text-xs text-slate-400">可一次选择多张图片批量上传</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              disabled={Boolean(importingSize) || batchRunning}
              onChange={(e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                if (files.length === 1) {
                  const file = files[0];
                  const defaultName = guessSizeName(file.name) || "M";
                  const sizeName = prompt("请输入尺寸名称（如 S / M / L）：", defaultName);
                  if (sizeName) handleFile(sizeName, file);
                } else {
                  openBatch(files);
                }
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
        {importingSize && <p className="mt-3 text-sm text-slate-500">正在导入 {importingSize}...</p>}
      </section>

      {batchOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-line bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">批量导入尺寸模板</h3>
              <button
                onClick={() => {
                  if (batchRunning) return;
                  setBatchOpen(false);
                  setBatchQueue([]);
                }}
                className="text-sm text-slate-500 hover:text-ink"
                disabled={batchRunning}
              >
                关闭
              </button>
            </div>

            <div className="mb-3 max-h-[320px] overflow-auto rounded border border-line">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">文件名</th>
                    <th className="w-32 px-3 py-2 text-left font-medium">尺寸名称</th>
                    <th className="px-3 py-2 text-left font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {batchQueue.map((item, idx) => (
                    <tr key={item.id} className="border-t border-line">
                      <td className="px-3 py-2">
                        <div className="max-w-[200px] truncate text-xs" title={item.file.name}>
                          {item.file.name}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          className="w-full rounded border border-line px-2 py-1 text-xs"
                          value={item.sizeName}
                          disabled={batchRunning}
                          onChange={(e) => updateBatchItem(idx, { sizeName: e.target.value })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                            item.status === "pending"
                              ? "bg-slate-100 text-slate-600"
                              : item.status === "uploading" || item.status === "importing"
                                ? "bg-action/10 text-action"
                                : item.status === "done"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-coral/10 text-coral"
                          }`}
                        >
                          {item.status === "pending" && "等待中"}
                          {item.status === "uploading" && "上传中"}
                          {item.status === "importing" && "识别中"}
                          {item.status === "done" && "完成"}
                          {item.status === "error" && "失败"}
                        </span>
                        <div className="mt-0.5 max-w-[220px] truncate text-[10px] text-slate-500" title={item.message}>
                          {item.message}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mb-4">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                <span>
                  进度：{batchQueue.filter((i) => i.status === "done" || i.status === "error").length} / {batchQueue.length}
                </span>
                <span>{batchProgress}%</span>
              </div>
              <div className="h-2 w-full rounded bg-slate-100">
                <div
                  className="h-2 rounded bg-action transition-all"
                  style={{ width: `${batchProgress}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  if (batchRunning) return;
                  setBatchOpen(false);
                  setBatchQueue([]);
                }}
                disabled={batchRunning}
                className="rounded px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={runBatchImport}
                disabled={batchRunning || batchQueue.length === 0 || batchQueue.every((i) => i.status === "done" || i.status === "error")}
                className="rounded bg-action px-4 py-2 text-sm font-semibold text-white hover:bg-action/90 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {batchRunning
                  ? `正在导入 ${batchQueue.filter((i) => i.status === "done" || i.status === "error").length} / ${batchQueue.length}`
                  : batchQueue.every((i) => i.status === "done" || i.status === "error")
                    ? "完成"
                    : "开始导入"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pickerOpen && pickerTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-lg border border-line bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                为 {pickerTarget.sizeName} 的「{pickerTarget.defName}」选择对应裁片
              </h3>
              <button
                onClick={() => setPickerOpen(false)}
                className="text-sm text-slate-500 hover:text-ink"
              >
                关闭
              </button>
            </div>

            {(() => {
              const allPieces = sizePiecesMap[pickerTarget.sizeId] || [];
              return (
                <>
                  <div className="mb-4 max-h-[400px] overflow-auto">
                    <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                      {allPieces.map((piece) => {
                        const isCurrent = piece.piece_def_id === pickerTarget.defId;
                        const otherDef = piece.piece_def_id
                          ? pieceDefs.find((d) => d.id === piece.piece_def_id)
                          : null;
                        return (
                          <button
                            key={piece.id}
                            onClick={() => pickPieceForDef(pickerTarget.sizeId, pickerTarget.defId, piece.id)}
                            className={`relative rounded border p-2 text-center transition ${
                              isCurrent
                                ? "border-action bg-emerald-50 ring-1 ring-action"
                                : "border-line bg-white hover:border-action hover:bg-slate-50"
                            }`}
                          >
                            <img
                              src={piece.mask_url}
                              alt={piece.name}
                              className="checkerboard mx-auto h-14 w-14 rounded object-contain"
                            />
                            <div className="mt-1 text-[10px] text-slate-600">
                              {piece.width}×{piece.height}
                            </div>
                            {isCurrent && (
                              <span className="absolute right-1 top-1 rounded bg-action px-1 py-0.5 text-[9px] font-medium text-white">
                                当前
                              </span>
                            )}
                            {!isCurrent && otherDef && (
                              <span className="absolute left-1 top-1 rounded bg-slate-200 px-1 py-0.5 text-[9px] font-medium text-slate-600">
                                已关联 {otherDef.name}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-line pt-4">
                    <button
                      onClick={() => clearPieceDef(pickerTarget.sizeId, pickerTarget.defId)}
                      className="rounded px-3 py-2 text-sm font-medium text-coral hover:bg-coral/10"
                    >
                      清空对应
                    </button>
                    <span className="text-xs text-slate-400">
                      共 {allPieces.length} 个裁片 · 点击即可交换对应关系
                    </span>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </main>
  );
}
