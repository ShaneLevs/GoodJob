import type { WebContents } from "electron";

import type { CliResult } from "./agent-browser";

/**
 * tab 锁定（BROWSER-AGENT §3 M2）。
 *
 * 多标签之后这一层比以前更关键，也更简单了：
 *
 * 1. CDP 端口把「全部 webContents」都暴露了，UI 窗口也在列表里。所以应用自身
 *    窗口的 URL / title 先建排除集，把 UI target 滤掉；
 * 2. 我们的每个标签都是一个 WebContentsView，**每个 webContents 都能自己报出
 *    自己的 CDP targetId**（debugger 附着后 `Target.getTargetInfo`，实测与
 *    `tab list --json` 的 targetId 完全一致、跨导航稳定）。于是「我们的标签」
 *    到「agent 的 tab」是**确定性对账**，不再靠 URL/title 猜——两个标签开同一
 *    个站也不会串，标题变了也不会失配；
 * 3. 每个浏览器任务开始时锁定一个标签（默认活动标签），任务期间的 tab 动作只能
 *    在我们自己的标签集合里切换；UI 窗口的 target 永远不在这个集合里。
 *
 * 关键设计：**Agent 的「新建标签」不直接调 CLI 的 `tab new`**。那会在同一个
 * Chromium 里造一个我们拿不到 WebContentsView 的页面——用户看不见，等于 Agent
 * 在一个隐形的页面里点按钮。所有标签的新建 / 关闭 / 切换都过 panel 适配器
 * （BrowserPanel），Agent 与用户操作的是同一组标签。
 */

/** 跑一条 CLI 命令；options.pin=false 用于会话尚未绑定标签时的 tab list。 */
export type CliRun = (args: string[], options?: { pin?: boolean }) => Promise<CliResult>;

/** tab list --json 里单个 tab 的形状（agent-browser 0.39.x）。 */
export interface TabInfo {
  tabId: string;
  /** CDP target id：跨 daemon 重启稳定，用它做锁定凭据。 */
  targetId: string;
  url: string;
  title: string;
  type: string;
  active: boolean;
}

/** 我们自己的一个标签（panel 适配器的最小形状）。 */
export interface PanelTab {
  id: string;
  contents: WebContents;
  active: boolean;
}

/**
 * 面板适配器：main 侧由 BrowserPanel 实现；target.ts 不依赖 BrowserPanel 本体，
 * 也不碰 electron 运行时之外的东西。
 */
export interface PanelDescriptor {
  tabs(): PanelTab[];
  /** 新建标签并等它 commit 出第一个文档（否则 CDP 还没登记这个 target）。 */
  createTab(url?: string): Promise<PanelTab | null>;
  closeTab(id: string): void;
  activateTab(id: string): void;
  /** 在标签上打「Agent 正在操作」的标记（纯 UI）。 */
  markAgentTab(id: string | null): void;
}

/**
 * 应用自身窗口（主 UI / 导出窗）的 URL 与 title 排除集。由 index.ts 用
 * BrowserWindow.getAllWindows() 计算（面板是 WebContentsView 不是 BrowserWindow，
 * 它的 URL / title 不会进来）。
 */
export interface OwnWindowSignatures {
  urls: Set<string>;
  titles: Set<string>;
}

/** 解析 `tab list --json` 的 data 字段；形状不符（版本漂移）按空列表处理并让上层报错。 */
export function parseTabList(data: Record<string, unknown>): TabInfo[] {
  const tabs = data.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const tab = raw as Record<string, unknown>;
    if (
      typeof tab.tabId !== "string" ||
      typeof tab.targetId !== "string" ||
      typeof tab.url !== "string"
    ) {
      return [];
    }
    return [
      {
        tabId: tab.tabId,
        targetId: tab.targetId,
        url: tab.url,
        title: typeof tab.title === "string" ? tab.title : "",
        type: typeof tab.type === "string" ? tab.type : "",
        active: tab.active === true,
      },
    ];
  });
}

/**
 * 问一个 webContents 要它自己的 CDP targetId。
 *
 * Electron 没有「我自己的 target id」API（`fromDevToolsTargetId` 是反查），所以
 * 反向用 debugger：attach → `Target.getTargetInfo` → detach。attach 时如果已经有
 * 别的 debugger 附着（用户开着 DevTools），Electron 会抛错——那时返回 undefined，
 * 由调用方退回按 URL 匹配，不让整个任务失败。
 */
export async function targetIdOf(contents: WebContents): Promise<string | undefined> {
  if (contents.isDestroyed()) return undefined;
  let attachedHere = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
      attachedHere = true;
    }
    const info = (await contents.debugger.sendCommand("Target.getTargetInfo")) as {
      targetInfo?: { targetId?: unknown };
    };
    const id = info.targetInfo?.targetId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  } finally {
    if (attachedHere) {
      try {
        contents.debugger.detach();
      } catch {
        // 已经 detach / webContents 没了。
      }
    }
  }
}

/** 我们的一个标签 → CDP targetId（解析不出来时按 URL / 标题在 tab 列表里回退）。 */
export interface ResolvedTab {
  /** 我们的标签 id（tab_xxx）。 */
  id: string;
  targetId: string;
  active: boolean;
  url: string;
  title: string;
}

/**
 * 把我们自己的全部标签翻译成 CDP targetId。只认 tab 列表里真实存在的 target
 * （防 webContents 刚建、CDP 还没登记），并且先滤掉应用自身窗口的排除集。
 */
export async function resolveOwnTargets(
  panel: PanelDescriptor,
  tabList: TabInfo[],
  own: OwnWindowSignatures,
): Promise<ResolvedTab[]> {
  const candidates = tabList.filter(
    (tab) => tab.type === "page" && !own.urls.has(tab.url) && !own.titles.has(tab.title),
  );
  const resolved: ResolvedTab[] = [];

  for (const tab of panel.tabs()) {
    if (tab.contents.isDestroyed()) continue;
    const direct = await targetIdOf(tab.contents);
    const url = tab.contents.getURL();
    const title = tab.contents.getTitle();
    const targetId =
      (direct !== undefined ? candidates.find((held) => held.targetId === direct)?.targetId : undefined) ??
      (url !== "" && url !== "about:blank"
        ? candidates.find((held) => held.url === url)?.targetId
        : undefined) ??
      (title !== "" ? candidates.find((held) => held.title === title)?.targetId : undefined);
    if (targetId === undefined) continue;
    const known = candidates.find((held) => held.targetId === targetId);
    if (known === undefined) continue;
    resolved.push({ id: tab.id, targetId, active: tab.active, url: known.url, title: known.title });
  }
  return resolved;
}

/** 锁定结果：任务期间允许触碰的 target 集合 + 当前所在的那个。 */
export interface TargetLock {
  /** 当前锁定的标签 id（我们的 id，跟 UI 的标签条一致）。 */
  tabId: string;
  /** 当前锁定的 CDP targetId。 */
  targetId: string;
  /** 允许切换的 targetId 集合（我们自己的标签；UI 窗口永不在内）。 */
  allowed: Set<string>;
}

/** 列一次 tab 列表；会话未绑定时第一条命令不能带 --pin-tab（见 AgentBrowserCli.run）。 */
async function listTabs(run: CliRun): Promise<TabInfo[]> {
  const result = await run(["tab", "list"], { pin: false });
  if (!result.ok) throw new Error(`列出浏览器标签失败：${result.error ?? "未知错误"}`);
  return parseTabList(result.data);
}

/**
 * 锁定面板的一个标签作为任务落点：默认活动标签；活动标签解析不出来时取第一个
 * 能解析的。一个都解析不出来就报错——宁可不跑，也不落到「当前默认 tab」
 * （那可能是 UI 窗口）。
 */
export async function lockPanelTarget(
  run: CliRun,
  panel: PanelDescriptor,
  own: OwnWindowSignatures,
): Promise<TargetLock> {
  if (panel.tabs().length === 0) {
    throw new Error("内嵌浏览器面板还没有就绪，先打开浏览器（顶栏地球图标）再试。");
  }

  const resolved = await resolveOwnTargets(panel, await listTabs(run), own);
  if (resolved.length === 0) {
    throw new Error(
      "没有在浏览器面板里找到当前页面。请先在内嵌浏览器里打开目标页面，或新建一个标签再让 Agent 操作。",
    );
  }

  const picked = resolved.find((tab) => tab.active) ?? resolved[0]!;
  const switched = await run(["tab", picked.targetId]);
  if (!switched.ok) throw new Error(`锁定浏览器面板标签失败：${switched.error ?? "未知错误"}`);

  return {
    tabId: picked.id,
    targetId: picked.targetId,
    allowed: new Set(resolved.map((tab) => tab.targetId)),
  };
}

/**
 * 把锁换成另一个标签：目标必须在我们自己的标签集合里，否则拒绝——这是 M2 在
 * 多标签下的写法。同时把该标签设为面板的活动标签（用户看得见 Agent 跳到哪）。
 */
export async function switchLockedTarget(
  run: CliRun,
  panel: PanelDescriptor,
  lock: TargetLock,
  tabId: string,
): Promise<TargetLock> {
  const target = panel.tabs().find((tab) => tab.id === tabId);
  if (target === undefined) throw new Error(`标签不存在：${tabId}`);
  const targetId = await targetIdOf(target.contents);
  if (targetId === undefined || !lock.allowed.has(targetId)) {
    throw new Error("只能切换到应用内嵌浏览器面板里已经打开的标签。");
  }
  panel.activateTab(tabId);
  const switched = await run(["tab", targetId]);
  if (!switched.ok) throw new Error(`切换标签失败：${switched.error ?? "未知错误"}`);
  return { ...lock, tabId, targetId };
}

/**
 * Agent 新建标签：走 panel（用户看得见），然后把新标签的 targetId 登记进 allowed
 * 并锁过去。
 */
export async function createLockedTab(
  run: CliRun,
  panel: PanelDescriptor,
  lock: TargetLock,
  url?: string,
): Promise<{ lock: TargetLock; tabId: string; targetId: string }> {
  const created = await panel.createTab(url);
  if (created === null) throw new Error("新建标签失败（面板没有就绪或标签数已达上限）。");

  // 新 webContents 的 target 要等第一个文档 commit 才出现在 tab 列表里；createTab
  // 已经等过 loadURL，这里再解析一次即可。
  const targetId = await targetIdOf(created.contents);
  if (targetId === undefined) {
    throw new Error("新标签还没准备好（拿不到它的调试目标），稍等一下再试。");
  }
  // bind 一次：--pin-tab 的会话绑定跟着切到新标签，后续命令才落在它上面。
  const bound = await run(["tab", targetId]);
  if (!bound.ok) throw new Error(`绑定新标签失败：${bound.error ?? "未知错误"}`);

  return {
    lock: { ...lock, tabId: created.id, targetId, allowed: new Set([...lock.allowed, targetId]) },
    tabId: created.id,
    targetId,
  };
}

/**
 * Agent 关闭标签：只能关我们自己的标签，且不能关掉锁定的那个（那会让任务失去
 * 落点）。关掉之后把它从 allowed 里剔除。
 */
export function closeLockedTab(
  panel: PanelDescriptor,
  lock: TargetLock,
  tabId: string,
): TargetLock {
  if (tabId === lock.tabId) throw new Error("不能关掉当前正在操作的标签；先切到别的标签再关。");
  const target = panel.tabs().find((tab) => tab.id === tabId);
  if (target === undefined) throw new Error(`标签不存在：${tabId}`);
  panel.closeTab(tabId);
  return lock;
}
