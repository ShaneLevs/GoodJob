/**
 * p3-*-smoke.mjs 系列共用的 electron 桩：store / 服务逻辑冒烟在纯 Node（jiti）里跑，
 * 不会调用任何 Electron API，但 paths.ts 顶层 `import { app } from "electron"`、
 * notify-store 顶层 `import { safeStorage } from "electron"` 需要能解析。
 *
 * safeStorage 桩是恒等编解码：加密结果再过一层 base64 落盘（对齐真实用法——
 * 存进 JSON 的是 `encryptString(...).toString("base64")`），文件里因此搜不到明文。
 */
export const app = {
  getPath(name) {
    throw new Error(`smoke 桩不应调用 app.getPath(${String(name)})`);
  },
  whenReady() {
    return Promise.reject(new Error("smoke 桩不应启动应用"));
  },
};
export const ipcMain = new Proxy({}, { get: () => () => {} });
export class BrowserWindow {}

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(plain) {
    return Buffer.from(plain, "utf8");
  },
  decryptString(buffer) {
    return buffer.toString("utf8");
  },
};
