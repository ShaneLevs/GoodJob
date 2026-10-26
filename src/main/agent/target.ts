import type { WebContents } from "electron";

import type { CliResult } from "./agent-browser";

/**
 * tab 锁定（BROWSER-AGENT §3 M2）：CDP 端口把「全部 webContents」都暴露了，
 * UI 窗口也在 tab 列表里。所以每次任务先 `tab list` 列目标，先按应用自身窗口
 * 的 URL / title 排除集滤掉 UI target，再按面板的 URL（回退 title）精确匹配出
 * 面板 target id，显式 `tab <targetId>` 切过去；会话全局旗标 --pin-tab 保证绑定
 * tab 被关后直接报 tab_gone，绝不回退到别的 tab。排除集兜住两个边角：dev 态
 * UI 跑在 http://127.0.0.1:1420、与面板允许的 http(s) 空间重叠（生产态 UI 是
 * file://，面板只放行 http(s)，天然撞不上）；CDP 列表顺序无保证，同 URL 的
 * 两个 target 取第一个可能取到 UI 窗口。UI 窗口的 target 永远不在匹配范围里，
 * 也就永远不会被操作。
 */

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

/** 面板描述：BrowserPanel 暴露 contents getter，这里只读 URL / title。 */
export interface PanelDescriptor {
  getContents(): WebContents | null;
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
 * 应用自身窗口（主 UI / 导出窗）的 URL 与 title 排除集。由 index.ts 用
 * BrowserWindow.getAllWindows() 计算（面板是 WebContentsView 不是 BrowserWindow，
 * 它的 URL / title 不会进来）；target.ts 保持不依赖 electron 运行时。
 */
export interface OwnWindowSignatures {
  urls: Set<string>;
  titles: Set<string>;
}

/**
 * 从 tab 列表里挑出面板 target：先滤掉应用自身窗口的 URL / title，再按面板的
 * URL（回退 title）精确匹配。只匹配 type=page 的目标（调用方已滤），排除
 * devtools / iframe 之类；找不到就返回 undefined，由调用方报错——宁可不跑，
 * 也不落到「当前默认 tab」（那可能是 UI 窗口）。
 */
export function pickPanelTarget(
  tabs: TabInfo[],
  panel: { url: string; title: string },
  own: OwnWindowSignatures,
): TabInfo | undefined {
  const candidates = tabs.filter((tab) => !own.urls.has(tab.url) && !own.titles.has(tab.title));
  return (
    (panel.url !== "" ? candidates.find((tab) => tab.url === panel.url) : undefined) ??
    (panel.title !== "" ? candidates.find((tab) => tab.title === panel.title) : undefined)
  );
}

/**
 * 锁定面板 target：先列 tab，再用 pickPanelTarget 按 URL（回退 title）精确匹配
 * 面板 webContents；own 是应用自身窗口的排除集（runner 的 deps 注入）。找不到
 * 就报错——宁可不跑，也不落到「当前默认 tab」（那可能是 UI 窗口）。
 */
export async function lockPanelTarget(
  run: (args: string[]) => Promise<CliResult>,
  panel: PanelDescriptor,
  own: OwnWindowSignatures,
): Promise<{ targetId: string; url: string }> {
  const contents = panel.getContents();
  if (contents === null || contents.isDestroyed()) {
    throw new Error("内嵌浏览器面板还没有就绪，先打开浏览器（顶栏地球图标）再试。");
  }
  const panelUrl = contents.getURL();
  const panelTitle = contents.getTitle();

  const result = await run(["tab", "list"]);
  if (!result.ok) throw new Error(`列出浏览器标签失败：${result.error ?? "未知错误"}`);
  const tabs = parseTabList(result.data).filter((tab) => tab.type === "page");

  const match = pickPanelTarget(tabs, { url: panelUrl, title: panelTitle }, own);
  if (match === undefined) {
    throw new Error(
      `没有在浏览器面板里找到当前页面（${panelUrl || "空白页"}）。请先在内嵌浏览器里打开目标页面再让 Agent 操作。`,
    );
  }

  const switched = await run(["tab", match.targetId]);
  if (!switched.ok) throw new Error(`锁定浏览器面板标签失败：${switched.error ?? "未知错误"}`);
  return { targetId: match.targetId, url: match.url };
}
