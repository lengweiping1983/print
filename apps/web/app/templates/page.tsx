"use client";

import type { TemplateSet } from "@print-studio/shared-types";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function TemplatesPage() {
  const [sets, setSets] = useState<TemplateSet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.listTemplateSets().then((data) => {
      setSets(data);
      setLoading(false);
    });
  }, []);

  return (
    <main className="min-h-screen bg-mist p-6 text-ink">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">裁片模板套装管理</h1>
          <p className="text-sm text-slate-500">配置多尺寸裁片模板，供生产打样直接调用</p>
        </div>
        <Link
          href="/templates/new"
          className="rounded-lg bg-action px-4 py-2 font-semibold text-white"
        >
          新建套装
        </Link>
      </header>

      {loading ? (
        <p className="text-slate-500">加载中...</p>
      ) : sets.length === 0 ? (
        <div className="rounded-lg border border-line bg-white p-8 text-center">
          <p className="text-slate-500">暂无模板套装，点击右上角新建</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sets.map((set) => (
            <Link
              key={set.id}
              href={`/templates/${set.id}`}
              className="rounded-lg border border-line bg-white p-4 shadow-panel transition hover:border-action"
            >
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                {set.name}
                {set.has_mapping_issues && <span className="text-coral" title="裁片对应关系异常">!</span>}
              </h2>
              <p className="text-sm text-slate-500">
                {set.version_label ? `版本：${set.version_label}` : "无版本标签"} · {" "}
                {set.garment_type === "shirt" ? "衬衫" : set.garment_type === "t_shirt" ? "T 恤" : "未知类型"}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <p className="text-xs text-slate-400">基准尺寸：{set.base_size_template_id ? "已设置" : "未设置"}</p>
                {set.has_mapping_issues && (
                  <span className="rounded bg-coral/10 px-1.5 py-0.5 text-[10px] font-medium text-coral">裁片对应待确认</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
