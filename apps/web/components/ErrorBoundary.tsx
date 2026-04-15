"use client";

import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("工作台渲染失败", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="min-h-screen bg-mist p-4 text-ink">
        <section className="mx-auto mt-16 max-w-2xl rounded-lg border border-line bg-white p-6 shadow-panel">
          <h1 className="m-0 text-xl font-semibold">工作台暂时无法显示</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">页面组件出现异常，当前项目数据仍保存在本地后端。请刷新页面重新进入工作台。</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-mist p-3 text-xs text-slate-600">{this.state.error.message}</pre>
          <button className="mt-4 rounded-lg bg-action px-4 py-2 font-semibold text-white" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </section>
      </main>
    );
  }
}
