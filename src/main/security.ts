import { session, shell, type BrowserWindow } from "electron";

const DEV_CSP = [
  "default-src 'self'",
  // Vite dev server injects an inline react-refresh preamble and evals modules.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:1420 ws://127.0.0.1:1420",
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // antd ships CSS-in-JS and injects <style> tags at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join("; ");

/**
 * Locks down the app's own UI session. The embedded browser uses a separate
 * partition and deliberately gets no CSP override.
 */
export function hardenRendererSession(isDev: boolean): void {
  const uiSession = session.defaultSession;

  uiSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [isDev ? DEV_CSP : PROD_CSP],
      },
    });
  });

  // The UI needs no device permissions at all.
  uiSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  uiSession.setPermissionCheckHandler(() => false);
}

/**
 * Applied to the app window only. Never attach this to the embedded browser's
 * webContents, or every link click inside the panel gets cancelled.
 */
export function hardenRendererWindow(win: BrowserWindow): void {
  const contents = win.webContents;

  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    console.warn("[security] blocked renderer navigation to", url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

function isAppUrl(url: string): boolean {
  return url.startsWith("file://") || url.startsWith("http://127.0.0.1:1420");
}
