"use client";

import type { SetPieceDef, SizeTemplate, TemplateSet } from "@print-studio/shared-types";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

export default function TemplateSetDetailPage() {
  const { setId } = useParams<{ setId: string }>();
  const router = useRouter();
  const [templateSet, setTemplateSet] = useState<TemplateSet | null>(null);
  const [sizes, setSizes] = useState<SizeTemplate[]>([]);
  const [pieceDefs, setPieceDefs] = useState<SetPieceDef[]>([]);
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
      // 如果这是第一个导入的，自动刷新套装信息以更新基准
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

  const sortedSizes = useMemo(() => {
    return [...sizes].sort((a, b) => a.size_name.localeCompare(b.size_name));
  }, [sizes]);

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
