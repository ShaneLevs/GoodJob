import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  WebContentsView,
  session,
  shell,
  type Session,
  type WebContents,
} from "electron";

import type { BrowserState, BrowserTab, Rect } from "@shared/types";

/** Isolated session: job-site cookies never mix with the app's own UI session. */
const PARTITION = "persist:browser";
const DEFAULT_HOME = "https://www.bing.com";
/** 新建标签的起点。用 about:blank 而不是首页：用户在地址栏输入前不必先加载一个站。 */
const BLANK = "about:blank";
/** 标签数上限：再多就是失控（Agent 跑疯时也靠它收口）。 */
const MAX_TABS = 20;

type StateListener = (state: BrowserState) => void;

/** 一个标签：一个 WebContentsView + 它的 id 与状态。 */
interface Tab {
  id: string;
  view: WebContentsView;
  /** 最近一次已知的 URL / 标题（webContents 销毁后仍可读，用作事件兜底）。 */
  url: string;
  title: string;
  loading: boolean;
}

/**
 * The embedded browser — now a tab host.
 *
 * A `WebContentsView` is a native child view, not a DOM node: the renderer reports the
 * rectangle it reserved for the browser and we park the *active* tab's view there. Every
 * other tab's view is detached from the window (kept alive, page state intact) so hidden
 * tabs cost no compositing but still run — that's the whole point of tabs.
 *
 * Because the panel is native, any overlay (Modal/Drawer/Dropdown) cannot paint on top of
 * it; callers must hide the panel while such an overlay is open (see `setVisible`).
 *
 * Tab ids are ours (`tab_<hex>`); the agent maps them to CDP target ids by asking each
 * webContents for its own target id (see `agentContents` / agent/target.ts).
 */
export class BrowserPanel {
  private readonly win: BrowserWindow;
  private readonly listener: StateListener;
  private readonly browserSession: Session;
  /** 插入顺序即标签条顺序。 */
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private bounds: Rect | null = null;
  private visible = false;
  private disposed = false;
  /** 当前真正挂到窗口上的 view（只有活动标签那一个）。 */
  private attached: WebContentsView | null = null;
  /** agent 正在操作的标签（工具条据此显示「Agent 在这里干活」）。 */
  private agentTabId: string | null = null;

  constructor(win: BrowserWindow, listener: StateListener) {
    this.win = win;
    this.listener = listener;

    this.browserSession = session.fromPartition(PARTITION);
    // The panel only reads pages; nothing it does needs a permission grant.
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    this.browserSession.setPermissionCheckHandler(() => false);
    // 站点的弹窗（alert / confirm / beforeunload）不阻塞自动化：自动接受，
    // 否则一个 confirm 就能把 Agent 的 snapshot 卡死到超时。
    this.browserSession.setPreloads([]);
  }

  // ———————————————————— 标签生命周期 ————————————————————

  /**
   * 新建标签。`url` 省略时开空白页；只接受 http(s) 与 about:blank。
   * 新标签立即成为活动标签（用户的直觉：点了「+」就是要在那里操作）。
   *
   * 返回时页面已经 commit 出第一个文档（除非是空白页）——CDP 要等这一步才登记
   * target，Agent 建完标签立刻锁它才不会扑空。
   */
  createTab(url?: string): Tab {
    if (this.disposed) throw new Error("浏览器面板已销毁。");
    if (this.tabs.size >= MAX_TABS) {
      throw new Error(`标签太多了（上限 ${MAX_TABS} 个），先关掉一些再开。`);
    }

    const target =
      url === undefined || url.trim() === "" ? BLANK : (normalizeInput(url) ?? BLANK);
    const tab: Tab = {
      id: `tab_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      view: new WebContentsView({
        webPreferences: {
          partition: PARTITION,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // The embedded page is untrusted third-party content.
          webSecurity: true,
        },
      }),
      url: target,
      title: "",
      loading: false,
    };
    tab.view.setBackgroundColor("#ffffff");
    this.tabs.set(tab.id, tab);
    this.bindContents(tab);

    this.activate(tab.id);
    if (target !== BLANK) {
      // 异步加载；调用方（用户点 + / agent 建 tab）不等导航完成，但 agent 那条
      // 走 createAgentTab()，那里会 await 首文档。
      void this.load(tab, target);
    } else {
      this.push();
    }
    return tab;
  }

  /**
   * Agent 建标签：先建，再等第一个文档 commit（CDP 登记 target 的时机），
   * 超时就不等了（仍返回标签，只是后续 lock 可能扑空，由 agent 侧报错）。
   */
  async createAgentTab(url?: string): Promise<{ id: string; contents: WebContents; active: boolean } | null> {
    if (this.disposed) return null;
    const tab = this.createTab(url);
    await waitForFirstDocument(tab.view.webContents);
    return { id: tab.id, contents: tab.view.webContents, active: tab.id === this.activeId };
  }

  /** 关掉一个标签；关掉的若是活动标签，顺位激活邻居。关到空时补一个空白页。 */
  closeTab(id: string): void {
    const tab = this.tabs.get(id);
    if (tab === undefined || this.disposed) return;

    const wasActive = this.activeId === id;
    this.tabs.delete(id);
    if (this.attached === tab.view) {
      this.detachView(tab.view);
      this.attached = null;
    }
    if (this.agentTabId === id) this.agentTabId = null;
    // WebContentsView 没有公开的 destroy()：把 webContents 关掉，视图随之失效。
    // 注意不能用 webContents.close() 在退出钩子里关（会让 app.quit() 挂住），
    // 但用户主动关标签是运行时行为，安全。
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();

    if (wasActive) {
      const next = this.lastTab();
      this.activeId = next === null ? null : next.id;
      if (next !== null) this.activate(next.id);
    }
    if (this.tabs.size === 0) {
      this.createTab();
      return;
    }
    this.push();
  }

  /** 切换活动标签：只换挂到窗口上的 view，页面状态全部保留。 */
  activateTab(id: string): void {
    if (!this.tabs.has(id) || this.disposed) return;
    this.activate(id);
    this.push();
  }

  /** 标签条顺序（渲染层也可从 state.tabs 拿到，这里给 main 内部用）。 */
  get tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  // ———————————————————— Agent 对接 ————————————————————

  /**
   * 给 agent 用的标签快照：id + webContents。
   * target.ts 用它把「我们的标签」翻译成 CDP targetId（webContents.debugger 的
   * Target.getTargetInfo），比按 URL/title 猜稳得多——两个标签开同一个站也不会串。
   */
  agentTabs(): { id: string; contents: WebContents; active: boolean }[] {
    if (this.disposed) return [];
    return [...this.tabs.values()]
      .map((tab) => ({
        id: tab.id,
        contents: tab.view.webContents,
        active: tab.id === this.activeId,
      }))
      .filter((tab) => !tab.contents.isDestroyed());
  }

  /** 活动标签的 webContents（agent 任务的默认落点）。 */
  get activeContents(): WebContents | null {
    if (this.disposed || this.activeId === null) return null;
    const contents = this.tabs.get(this.activeId)?.view.webContents;
    return contents === undefined || contents.isDestroyed() ? null : contents;
  }

  /**
   * 给一个标签打上「Agent 正在操作」的标记（工具条上显示小圆点）。
   * 传 null 清掉。只影响 UI，不影响任何行为。
   */
  markAgentTab(id: string | null): void {
    if (this.agentTabId === id) return;
    this.agentTabId = id;
    this.push();
  }

  get session(): Session {
    return this.browserSession;
  }

  // ———————————————————— 用户面（工具条 / 地址栏） ————————————————————

  setBounds(rect: Rect | null): void {
    if (this.disposed) return;

    if (rect === null || rect.width < 1 || rect.height < 1) {
      this.bounds = null;
      this.applyVisibility();
      return;
    }

    // Bounds are device-independent pixels; CSS pixels match them at zoom factor 1.
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    this.currentView()?.setBounds(this.bounds);
    this.applyVisibility();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    this.visible = visible;
    this.applyVisibility();
  }

  async navigate(input: string): Promise<void> {
    const url = normalizeInput(input);
    if (url === null) return;
    const tab = this.activeTab();
    if (tab === null) return;
    await this.load(tab, url);
  }

  back(): void {
    const contents = this.liveActiveContents();
    if (contents?.navigationHistory.canGoBack() === true) {
      contents.navigationHistory.goBack();
    }
  }

  forward(): void {
    const contents = this.liveActiveContents();
    if (contents?.navigationHistory.canGoForward() === true) {
      contents.navigationHistory.goForward();
    }
  }

  reload(): void {
    this.liveActiveContents()?.reload();
  }

  stop(): void {
    this.liveActiveContents()?.stop();
  }

  toggleDevTools(): void {
    const contents = this.liveActiveContents();
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
    for (const tab of this.tabs.values()) {
      try {
        if (!this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view);
      } catch {
        // The view went away together with the window.
      }
    }
    this.tabs.clear();
    this.attached = null;
    this.activeId = null;
  }

  // ———————————————————— 内部 ————————————————————

  /** 把某个标签设为活动：换挂 view + 设 bounds + 应用可见性。 */
  private activate(id: string): void {
    const tab = this.tabs.get(id);
    if (tab === undefined) return;

    if (this.activeId !== null && this.activeId !== id) {
      const previous = this.tabs.get(this.activeId);
      if (previous !== undefined && previous.view !== tab.view) this.detachView(previous.view);
    }

    this.activeId = id;
    if (this.attached !== tab.view) {
      if (this.attached !== null) this.detachView(this.attached);
      this.win.contentView.addChildView(tab.view);
      this.attached = tab.view;
    }
    if (this.bounds !== null) tab.view.setBounds(this.bounds);
    this.applyVisibility();
  }

  private detachView(view: WebContentsView): void {
    try {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
    } catch {
      // 窗口先走一步：视图已随它销毁。
    }
    // 隐藏的标签必须显式 setVisible(false)，否则 removeChildView 之后仍可能占位。
    try {
      view.setVisible(false);
    } catch {
      // 已销毁。
    }
  }

  private applyVisibility(): void {
    if (this.disposed) return;
    const show = this.visible && this.bounds !== null;
    for (const tab of this.tabs.values()) {
      try {
        tab.view.setVisible(show && tab.id === this.activeId);
      } catch {
        // 已销毁的视图忽略。
      }
    }
  }

  private currentView(): WebContentsView | null {
    if (this.activeId === null) return null;
    return this.tabs.get(this.activeId)?.view ?? null;
  }

  private activeTab(): Tab | null {
    if (this.activeId === null) return null;
    return this.tabs.get(this.activeId) ?? null;
  }

  private lastTab(): Tab | null {
    let last: Tab | null = null;
    for (const tab of this.tabs.values()) last = tab;
    return last;
  }

  private liveActiveContents(): WebContents | null {
    const contents = this.activeTab()?.view.webContents;
    return contents === undefined || contents.isDestroyed() ? null : contents;
  }

  private async load(tab: Tab, url: string): Promise<void> {
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error) {
      // Aborted navigations reject; the UI reflects the real state via events.
      if (!isAbort(error)) throw error;
    }
  }

  /** 当前状态快照（渲染层重新挂载时主动拉一次；main 平时只在变化时推送）。 */
  state(): BrowserState | null {
    if (this.disposed) return null;
    return this.buildState();
  }

  /** 状态广播：活动标签的 url / 导航能力 + 全部标签。 */
  private push(): void {
    if (this.disposed) return;
    const state = this.buildState();
    if (state !== null) this.listener(state);
  }

  private buildState(): BrowserState | null {
    const active = this.activeTab();
    const contents = active?.view.webContents;
    const live = contents !== undefined && !contents.isDestroyed();
    const tabs: BrowserTab[] = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      agentBusy: tab.id === this.agentTabId,
    }));
    return {
      activeId: this.activeId,
      url: live ? contents.getURL() : (active?.url ?? ""),
      title: live ? contents.getTitle() : (active?.title ?? ""),
      loading: live ? contents.isLoading() : false,
      canGoBack: live ? contents.navigationHistory.canGoBack() : false,
      canGoForward: live ? contents.navigationHistory.canGoForward() : false,
      tabs,
    };
  }

  private bindContents(tab: Tab): void {
    const contents = tab.view.webContents;

    // 站点的 target=_blank / window.open：开成新标签（这是标签式浏览该有的行为）。
    // 返回 deny 表示「不要给我一个原生弹窗」，我们自己建。
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) void this.openInNewTab(url);
      return { action: "deny" };
    });

    // Only http(s) (and the blank start page) may render inside the panel; everything
    // else goes to the OS.
    contents.on("will-navigate", (event, url) => {
      if (isHttpUrl(url) || url === BLANK) return;
      event.preventDefault();
      void shell.openExternal(url);
    });

    contents.on("will-frame-navigate", (event) => {
      if (!isHttpUrl(event.url) && event.url !== BLANK) event.preventDefault();
    });

    const update = (): void => {
      if (this.disposed || contents.isDestroyed()) return;
      tab.url = contents.getURL();
      tab.title = contents.getTitle();
      tab.loading = contents.isLoading();
      this.push();
    };

    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("did-frame-finish-load", update);
    contents.on("page-title-updated", update);

    contents.on("render-process-gone", (_event, details) => {
      console.error("[browser] render process gone:", details.reason);
      update();
    });

    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      // -3 is ABORTED, which happens constantly during normal navigation.
      if (errorCode === -3) return;
      console.error("[browser] load failed:", errorCode, errorDescription, validatedURL);
      update();
    });
  }

  /**
   * 从页面里开新标签（target=_blank）。标签数到上限就不再开，改为在来源标签里导航，
   * 免得一次批量打开把应用拖死。
   */
  private async openInNewTab(url: string): Promise<void> {
    try {
      if (this.tabs.size < MAX_TABS) {
        this.createTab(url);
        return;
      }
    } catch {
      // 落到下面的兜底。
    }
    const tab = this.activeTab();
    if (tab !== null) await this.load(tab, url);
  }
}

/** 等首文档 commit（did-finish-load / did-fail-load 都算结束），最多 15s。 */
function waitForFirstDocument(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.off("did-finish-load", done);
      contents.off("did-fail-load", done);
      resolve();
    };
    const timer = setTimeout(done, 15_000);
    contents.once("did-finish-load", done);
    contents.once("did-fail-load", done);
    // 已经是完成态（about:blank）时事件不再来，直接返回。
    if (!contents.isLoading()) done();
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && /ERR_ABORTED/.test(error.message);
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Accepts bare hosts (`jobs.example.com`), full URLs, and anything else as a search.
 * Returns null for schemes we refuse to load in the panel.
 */
function normalizeInput(input: string): string | null {
  const value = input.trim();
  if (value === "") return null;
  if (isHttpUrl(value)) return value;
  if (value === BLANK) return BLANK;
  if (/^(about|file|data|javascript|blob):/i.test(value)) return null;
  if (/^[^\s/]+\.[^\s]{2,}/.test(value)) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

// BrowserPanel 内部统一用 normalizeInput；只剩这两个导出给工具条 / 外部常驻。
export { DEFAULT_HOME, BLANK, MAX_TABS };
