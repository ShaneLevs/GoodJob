import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const shared = path.resolve("src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      rollupOptions: { input: { index: path.resolve("src/main/index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      rollupOptions: {
        input: { index: path.resolve("src/preload/index.ts") },
        // Sandboxed preload scripts must be CommonJS, so keep the .cjs extension
        // even though package.json is "type": "module".
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: path.resolve("src/renderer"),
    // Tailwind 只挂在渲染层：main / preload 里没有任何 className。
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve("src/renderer/src"),
        "@shared": shared,
      },
    },
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
    },
    build: {
      rollupOptions: { input: { index: path.resolve("src/renderer/index.html") } },
    },
  },
});
