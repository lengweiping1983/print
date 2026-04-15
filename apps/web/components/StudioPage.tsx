"use client";

import type { Asset, Job, Piece, PieceTransform, Project, Texture } from "@print-studio/shared-types";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { api, waitForJob } from "@/lib/api";

const SinglePieceCalibration = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.SinglePieceCalibration), {
  ssr: false,
  loading: () => <SinglePieceLoading />
});

const LayoutPreview = dynamic(() => import("./KonvaWorkspace").then((mod) => mod.LayoutPreview), {
  ssr: false,
  loading: () => <LayoutPreviewLoading />
});

const emptyTransform: PieceTransform = {
  offset_x: 0,
  offset_y: 0,
  scale: 1,
  rotation: 0,
  mirror_x: false,
  mirror_y: false,
  texture_id: "",
  locked: false
};

export function StudioPage() {
  const [project, setProject] = useState<Project | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [textures, setTextures] = useState<Texture[]>([]);
  const [selectedPieceId, setSelectedPieceId] = useState("");
  const [sourceType, setSourceType] = useState<"pattern" | "garment_photo" | "ai" | "library">("pattern");
  const [prompt, setPrompt] = useState("深蓝底色，花卉与飞鹤纹样，适合男士衬衫裁片打样");
  const [job, setJob] = useState<Job | null>(null);
  const [notice, setNotice] = useState("正在准备工作台...");
  const [templateFileName, setTemplateFileName] = useState("");
  const [textureFileName, setTextureFileName] = useState("");
  const [textureViewMode, setTextureViewMode] = useState<"source" | "seamless">("source");
  const [showOutlines, setShowOutlines] = useState(true);
  const [outlineWidth, setOutlineWidth] = useState(1);

  useEffect(() => {
    api
      .createProject()
      .then((created) => {
        setProject(created);
        setNotice("项目已创建，先上传透明 PNG/WebP 裁片模板或白底排版原图。");
      })
      .catch((error) => setNotice(error.message));
  }, []);

  const selectedPiece = useMemo(
    () => pieces.find((piece) => piece.id === selectedPieceId) ?? pieces[0] ?? null,
    [pieces, selectedPieceId]
  );
  const assetSummary = useMemo(() => {
    const templateCount = assets.filter((asset) => asset.kind === "template").length;
    const patternCount = assets.filter((asset) => asset.kind === "pattern").length;
    const garmentPhotoCount = assets.filter((asset) => asset.kind === "garment_photo").length;
    return { templateCount, patternCount, garmentPhotoCount, total: assets.length };
  }, [assets]);
  const activeTexture = textures[0] ?? null;
  const hasSeamlessTexture = Boolean(activeTexture?.seamless_url);
  const activeTextureUrl = activeTexture
    ? textureViewMode === "seamless" && activeTexture.seamless_url
      ? activeTexture.seamless_url
      : activeTexture.source_url
    : "";

  async function upload(kind: string, file: File) {
    if (!project) return;
    setNotice(`上传 ${file.name}...`);
    const asset = await api.uploadAsset(project.id, kind, file);
    setAssets((current) => [asset, ...current]);
    setNotice(`${file.name} 已上传。`);
    return asset;
  }

  async function handleTemplate(file: File) {
    if (!project) return;
    try {
      setTemplateFileName(file.name);
      const asset = await upload("template", file);
      if (!asset) return;
      setNotice("正在识别模板/排版原图并拆分裁片...");
      const imported = await api.importTemplate(project.id, asset.id);
      setPieces(imported.pieces);
      setSelectedPieceId(imported.pieces[0]?.id ?? "");
      setNotice(`模板解析完成，共 ${imported.pieces.length} 个裁片。`);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleTexture(file?: File) {
    if (!project) return;
    try {
      let assetId = "";
      if (file) {
        setTextureFileName(file.name);
        const asset = await upload(sourceType === "garment_photo" ? "garment_photo" : "pattern", file);
        assetId = asset?.id ?? "";
      }
      setNotice("正在生成纹理任务...");
      const created = await api.generateTexture(project.id, assetId, sourceType, prompt);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current]);
      setTextureViewMode("source");
      setNotice("纹理已生成，可继续做无缝化或直接导出。");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function handleSeamless(mode: "mirror" | "offset") {
    if (!project || !activeTexture) return;
    try {
      setNotice("正在生成无缝大布料图...");
      const created = await api.createSeamless(project.id, activeTexture.id, mode);
      const done = await waitForJob(created.job_id, setJob);
      const texture = done.output.texture as Texture;
      setTextures((current) => [texture, ...current.filter((item) => item.id !== texture.id)]);
      setTextureViewMode("seamless");
      setNotice("无缝大布料图已生成。");
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function patchSelected(transform: Partial<PieceTransform>) {
    if (!selectedPiece) return;
    await patchPiece(selectedPiece.id, transform);
  }

  async function patchPiece(pieceId: string, transform: Partial<PieceTransform>) {
    if (!project) return;
    const piece = pieces.find((item) => item.id === pieceId);
    if (!piece) return;
    const next = { ...piece.transform, ...transform };
    setPieces((current) => current.map((item) => (item.id === piece.id ? { ...item, transform: next } : item)));
    const saved = await api.updatePiece(project.id, piece.id, next);
    setPieces((current) => current.map((piece) => (piece.id === saved.id ? saved : piece)));
  }

  async function exportPack() {
    if (!project) return;
    try {
      setNotice("正在导出打样包...");
      const created = await api.exportProject(project.id);
      const done = await waitForJob(created.job_id, setJob);
      const url = String(done.output.export_url || "");
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      setNotice(url ? `打样包已生成：${url}` : "打样包已生成。");
      await refreshTextures(project.id);
    } catch (error) {
      setNotice(readError(error));
    }
  }

  async function refreshTextures(projectId: string) {
    const next = await api.listTextures(projectId);
    setTextures(next);
  }

  return (
    <main className="min-h-screen bg-mist p-4 text-ink">
      <header className="mb-4 grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border border-line bg-white px-5 py-4 shadow-panel max-[980px]:grid-cols-1">
        <div>
          <p className="m-0 text-sm font-semibold text-jade">生产打样工作台</p>
          <h1 className="m-0 mt-1 text-3xl font-bold">服装裁片</h1>
          <p className="m-0 mt-2 text-sm text-slate-500">{notice}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-action px-4 py-2 font-semibold text-white" onClick={exportPack}>
            导出打样包
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[340px_minmax(720px,1fr)_minmax(520px,0.95fr)] gap-4 max-[1500px]:grid-cols-1">
        <aside className="space-y-4">
          <Panel title="素材">
            <FileField label="裁片模板 PNG/WebP 或白底排版原图 JPG/PNG/WebP" accept="image/png,image/webp,image/jpeg" selectedName={templateFileName} onFile={handleTemplate} />
            <div className="mt-4 grid gap-2">
              <label className="text-sm font-semibold">布料来源</label>
              <select className="rounded-lg border border-line bg-white px-3 py-2" value={sourceType} onChange={(event) => setSourceType(event.target.value as typeof sourceType)}>
                <option value="pattern">图案平铺</option>
                <option value="garment_photo">已有衣服复刻</option>
                <option value="ai">AI 生成</option>
                <option value="library">纹理库</option>
              </select>
            </div>
            <textarea
              className="mt-3 min-h-24 w-full resize-y rounded-lg border border-line px-3 py-2 text-sm"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <FileField label="上传图案或衣服照片" accept="image/*" selectedName={textureFileName} onFile={handleTexture} />
            <button className="mt-3 w-full rounded-lg bg-ink px-4 py-2 font-semibold text-white" onClick={() => handleTexture()}>
              仅用 Prompt 生成
            </button>
            <div className="mt-3 rounded-lg bg-mist p-3 text-xs leading-5 text-slate-600">
              <div>裁片模板：{templateFileName || "未上传"}</div>
              <div>素材图：{textureFileName || "未上传"}</div>
              <div>
                上传素材：{assetSummary.total} 个（模板 {assetSummary.templateCount} / 图案 {assetSummary.patternCount} / 衣照 {assetSummary.garmentPhotoCount}）
              </div>
            </div>
          </Panel>

          <Panel title="纹理">
            {activeTexture ? (
              <div className="space-y-3">
                <img className="checkerboard h-48 w-full rounded-lg object-contain" src={activeTextureUrl} alt="当前纹理" />
                <p className="m-0 text-xs text-slate-500">纹理大小：{activeTexture.width} x {activeTexture.height}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-line ${
                      textureViewMode === "source" || !hasSeamlessTexture ? "bg-ink text-white" : "bg-white text-ink"
                    }`}
                    onClick={() => setTextureViewMode("source")}
                  >
                    使用原图
                  </button>
                  <button
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-line ${
                      textureViewMode === "seamless" && hasSeamlessTexture ? "bg-ink text-white" : "bg-white text-ink"
                    } ${hasSeamlessTexture ? "" : "opacity-50"}`}
                    disabled={!hasSeamlessTexture}
                    onClick={() => setTextureViewMode("seamless")}
                  >
                    使用无缝图
                  </button>
                </div>
                <p className="m-0 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                  当前使用：{textureViewMode === "seamless" && hasSeamlessTexture ? "无缝图" : "原图"}。无缝处理适合满版纹理；透明底主体图案建议使用原图定位。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line" onClick={() => handleSeamless("mirror")}>
                    镜像无缝
                  </button>
                  <button className="rounded-lg bg-white px-3 py-2 font-semibold ring-1 ring-line" onClick={() => handleSeamless("offset")}>
                    Offset 修缝
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">上传图案或使用 Prompt 生成纹理。</p>
            )}
            <div className="mt-4 rounded-lg bg-mist p-3 text-sm text-slate-600">
              <div>任务：{job?.job_type ?? "空闲"}</div>
              <div>状态：{job?.status ?? "ready"}</div>
              <div>进度：{job ? Math.round(job.progress * 100) : 0}%</div>
            </div>
          </Panel>
        </aside>

        <section className="grid grid-cols-[128px_minmax(0,1fr)] gap-4 max-[980px]:grid-cols-1">
          <Panel title="裁片">
            <p className="m-0 mb-3 text-xs text-slate-500">裁片数量：{pieces.length}</p>
            <div className="max-h-[760px] space-y-2 overflow-auto pr-1">
              {pieces.length === 0 && <p className="text-xs leading-5 text-slate-500">上传透明模板后会显示裁片。</p>}
              {pieces.map((piece) => (
                <button
                  key={piece.id}
                  title={`${piece.name}：${piece.width} x ${piece.height}`}
                  className={`grid w-full justify-items-center gap-2 rounded-lg border p-2 text-center transition ${
                    piece.id === selectedPieceId ? "border-coral bg-red-50" : "border-line bg-white hover:border-coral/60"
                  }`}
                  onClick={() => setSelectedPieceId(piece.id)}
                >
                  <img className="checkerboard h-20 w-20 rounded-md object-contain" src={piece.mask_url} alt={piece.name} />
                  <span className="block max-w-full truncate text-xs font-semibold">{piece.name}</span>
                </button>
              ))}
            </div>
          </Panel>

          <div className="space-y-4">
            <SinglePieceCalibration
              pieces={pieces}
              selectedPieceId={selectedPieceId}
              textureUrl={activeTextureUrl}
              showOutlines={showOutlines}
              outlineWidth={outlineWidth}
              onToggleOutlines={setShowOutlines}
              onOutlineWidthChange={setOutlineWidth}
              onMovePiece={(piece, x, y) => {
                setSelectedPieceId(piece.id);
                void patchPiece(piece.id, { offset_x: Math.round(x), offset_y: Math.round(y) });
              }}
            />

            <Panel title="当前裁片参数">
              {selectedPiece ? (
                <div className="grid gap-4 min-[980px]:grid-cols-2">
                  <Range label="平移 X" value={selectedPiece.transform.offset_x} min={-1500} max={1500} onChange={(value) => patchSelected({ offset_x: value })} />
                  <Range label="平移 Y" value={selectedPiece.transform.offset_y} min={-1500} max={1500} onChange={(value) => patchSelected({ offset_y: value })} />
                  <Range label="缩放" value={selectedPiece.transform.scale} min={0.2} max={6} step={0.01} onChange={(value) => patchSelected({ scale: value })} />
                  <Range label="旋转" value={selectedPiece.transform.rotation} min={-180} max={180} onChange={(value) => patchSelected({ rotation: value })} />
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <label className="rounded-lg border border-line p-2">
                      <input type="checkbox" checked={selectedPiece.transform.mirror_x} onChange={(event) => patchSelected({ mirror_x: event.target.checked })} /> 左右镜像
                    </label>
                    <label className="rounded-lg border border-line p-2">
                      <input type="checkbox" checked={selectedPiece.transform.mirror_y} onChange={(event) => patchSelected({ mirror_y: event.target.checked })} /> 上下镜像
                    </label>
                  </div>
                  <button className="rounded-lg bg-white px-4 py-2 font-semibold text-ink ring-1 ring-line" onClick={() => patchSelected(emptyTransform)}>
                    重置当前裁片
                  </button>
                </div>
              ) : (
                <p className="text-sm text-slate-500">请选择裁片。</p>
              )}
            </Panel>
          </div>
        </section>

        <LayoutPreview
          pieces={pieces}
          selectedPieceId={selectedPieceId}
          textureUrl={activeTextureUrl}
          showOutlines={showOutlines}
          outlineWidth={outlineWidth}
          onSelectPiece={setSelectedPieceId}
        />
      </div>
    </main>
  );
}

function readError(error: unknown) {
  return error instanceof Error ? error.message.split("\n")[0] : "操作失败，请检查后端日志。";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <h2 className="m-0 mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SinglePieceLoading() {
  return (
    <section className="rounded-lg border border-line bg-white p-4 shadow-panel">
      <h2 className="m-0 text-lg font-semibold">单片校正</h2>
      <p className="m-0 mt-1 text-sm text-slate-500">画布组件加载中...</p>
      <div className="checkerboard mt-3 flex h-[640px] items-center justify-center rounded-lg border border-line text-sm text-slate-500">
        正在准备裁片画布
      </div>
    </section>
  );
}

function LayoutPreviewLoading() {
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

function FileField({
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

function Range({
  label,
  value,
  min,
  max,
  step = 1,
  onChange
}: {
  label: string;
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
    </label>
  );
}
