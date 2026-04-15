"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function NewTemplateSetPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [garmentType, setGarmentType] = useState<"unknown" | "t_shirt" | "shirt">("unknown");
  const [versionLabel, setVersionLabel] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    const created = await api.createTemplateSet(name.trim(), garmentType, versionLabel.trim());
    router.push(`/templates/${created.id}`);
  }

  return (
    <main className="min-h-screen bg-mist p-6 text-ink">
      <h1 className="mb-6 text-2xl font-bold">新建模板套装</h1>
      <form onSubmit={handleSubmit} className="max-w-xl rounded-lg border border-line bg-white p-6 shadow-panel">
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold">套装名称</label>
          <input
            className="w-full rounded-lg border border-line px-3 py-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：男士衬衫"
            required
          />
        </div>
        <div className="mb-4">
          <label className="mb-1 block text-sm font-semibold">衣服类型</label>
          <select
            className="w-full rounded-lg border border-line bg-white px-3 py-2"
            value={garmentType}
            onChange={(e) => setGarmentType(e.target.value as typeof garmentType)}
          >
            <option value="unknown">未知</option>
            <option value="t_shirt">T 恤</option>
            <option value="shirt">衬衫</option>
          </select>
        </div>
        <div className="mb-6">
          <label className="mb-1 block text-sm font-semibold">版本标签</label>
          <input
            className="w-full rounded-lg border border-line px-3 py-2"
            value={versionLabel}
            onChange={(e) => setVersionLabel(e.target.value)}
            placeholder="例如：标准版"
          />
        </div>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-action px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {creating ? "创建中..." : "创建套装"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/templates")}
            className="rounded-lg bg-white px-4 py-2 font-semibold ring-1 ring-line"
          >
            取消
          </button>
        </div>
      </form>
    </main>
  );
}
