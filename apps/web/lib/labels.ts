export const PIECE_ROLE_LABELS: Record<string, string> = {
  front_left: "左前片",
  front_right: "右前片",
  back: "后片",
  sleeve_left: "左袖",
  sleeve_right: "右袖",
  collar: "领片",
  placket: "门襟",
  strip: "条带",
  unknown: "未识别",
};

export const JOB_TYPE_LABELS: Record<string, string> = {
  template_import: "模板解析",
  texture_generate: "纹理生成",
  texture_seamless: "无缝化",
  render_preview: "预览渲染",
  export_render: "导出渲染",
  auto_map_layout: "自动排版",
  layout_auto_map: "自动排版",
  fit_global_texture: "全局适配",
  texture_fit_global: "全局适配",
  design_canvas_render: "设计画布生成",
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  ready: "就绪",
};
