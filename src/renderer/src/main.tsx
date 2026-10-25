import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ExportRoute } from "./components/ExportRoute";
import "./globals.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root is missing from index.html");

/*
 * 两个入口共用一份 bundle：
 * - `#export`：PDF 导出路由（main 的 pdf-export.ts 起隐藏窗口加载），
 *   不挂 App、不碰 window.goodjob——导出窗口故意不给 preload。
 * - 其余：主界面。
 */
if (window.location.hash === "#export") {
  createRoot(container).render(<ExportRoute />);
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
