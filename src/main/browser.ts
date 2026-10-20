import {
  BrowserWindow,
  WebContentsView,
  session,
  shell,
  type Session,
  type WebContents,
} from "electron";

import type { BrowserState, Rect } from "@shared/types";

/** Isolated session: job-site cookies never mix with the app's own UI session. */
const PARTITION = "persist:browser";
const DEFAULT_HOME = "https://www.bing.com";

type StateListener = (state: BrowserState) => void;

/**
 * The embedded browser.
 *
 * A `WebContentsView` is a native child view, not a DOM node: the renderer reports the
 * rectangle it reserved for the browser and we mirror it here. That also means antd
 * overlays (Modal/Drawer/Dropdown) cannot paint on top of it — callers must hide the
 * panel while such an overlay is open.
 */
export class BrowserPanel {
  private readonly view: WebContentsView;
  private readonly win: BrowserWindow;
  private readonly listener: StateListener;
  private bounds: Rect | null = null;
  private visible = false;
  private disposed = false;

  constructor(win: BrowserWindow, listener: StateListener) {
    this.win = win;
    this.listener = listener;

    const browserSession = session.fromPartition(PARTITION);
    // The panel only reads pages; nothing it does needs a permission grant.
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    browserSession.setPermissionCheckHandler(() => false);

    this.view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The embedded page is untrusted third-party content.
        webSecurity: true,
      },
    });

    this.view.setBackgroundColor("#ffffff");
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(false);

    this.bindContents();
    void this.view.webContents.loadURL(DEFAULT_HOME);
  }

  /** Escape hatch for agent tooling (scripting, screenshots, CDP). */
  get contents(): WebContents {
    return this.view.webContents;
  }

  get session(): Session {
    return this.view.webContents.session;
  }

  /** Null once the view is gone, so late IPC calls become no-ops instead of throwing. */
  private get liveContents(): WebContents | null {
    if (this.disposed) return null;
    const contents = this.view.webContents;
    return contents.isDestroyed() ? null : contents;
  }

  setBounds(rect: Rect | null): void {
    if (this.disposed) return;

    if (rect === null || rect.width < 1 || rect.height < 1) {
      this.bounds = null;
      this.view.setVisible(false);
      return;
    }

    // Bounds are device-independent pixels; CSS pixels match them at zoom factor 1.
    const next: Rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    this.bounds = next;
    this.view.setBounds(next);
    this.applyVisibility();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.applyVisibility();
  }

  async navigate(input: string): Promise<void> {
    const url = normalizeInput(input);
    const contents = this.liveContents;
    if (url === null || contents === null) return;
    try {
      await contents.loadURL(url);
    } catch (error) {
      // Aborted navigations reject; the UI reflects the real state via events.
      if (!isAbort(error)) throw error;
    }
  }

  back(): void {
    const contents = this.liveContents;
    if (contents?.navigationHistory.canGoBack() === true) {
      contents.navigationHistory.goBack();
    }
  }

  forward(): void {
    const contents = this.liveContents;
    if (contents?.navigationHistory.canGoForward() === true) {
      contents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.liveContents?.reload();
  }

  stop(): void {
    this.liveContents?.stop();
  }

  toggleDevTools(): void {
    const contents = this.liveContents;
    if (contents === null) return;
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    else contents.openDevTools({ mode: "detach" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // `closed` fires after the window is already destroyed and before-quit can run even
    // later, so every handle here may be gone. Electron tears child views down with the
    // window; detach only when the window is still alive, and never call
    // webContents.close() here — doing so makes app.quit() hang instead of exiting.
    try {
      if (!this.win.isDestroyed()) {
        this.win.contentView.removeChildView(this.view);
      }
    } catch {
      // The view went away together with the window.
    }
  }

  private applyVisibility(): void {
    if (this.disposed) return;
    this.view.setVisible(this.visible && this.bounds !== null);
  }

  private bindContents(): void {
    const contents = this.view.webContents;

    // Keep popups inside the panel instead of spawning unmanaged windows.
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void contents.loadURL(url);
      return { action: "deny" };
    });

    // Only http(s) may render inside the panel; everything else goes to the OS.
    contents.on("will-navigate", (event, url) => {
      if (isHttpUrl(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });

    contents.on("will-frame-navigate", (event) => {
      if (!isHttpUrl(event.url)) event.preventDefault();
    });

    const push = (): void => {
      if (this.disposed) return;
      this.listener({
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      });
    };

    contents.on("did-start-loading", push);
    contents.on("did-stop-loading", push);
    contents.on("did-navigate", push);
    contents.on("did-navigate-in-page", push);
    contents.on("did-frame-finish-load", push);
    contents.on("page-title-updated", push);

    contents.on("render-process-gone", (_event, details) => {
      console.error("[browser] render process gone:", details.reason);
      push();
    });

    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      // -3 is ABORTED, which happens constantly during normal navigation.
      if (errorCode === -3) return;
      console.error("[browser] load failed:", errorCode, errorDescription, validatedURL);
      push();
    });
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && /ERR_ABORTED/.test(error.message);
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Accepts bare hosts (`jobs.example.com`), full URLs, and anything else as a search.
 */
function normalizeInput(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  if (isHttpUrl(value)) return value;
  if (/^(about|file|data|javascript):/i.test(value)) return null;
  if (/^[^\s/]+\.[^\s]{2,}/.test(value)) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}
