/**
 * 浏览器面板里的一个标签页（多标签）。id 由 main 生成、进程内唯一且不复用，
 * 是渲染层与 main 之间唯一的标签句柄；agent 侧另用 CDP targetId 对账（见
 * main/browser/automation/target.ts 的 resolveTargetId）。
 */
export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  /** agent 正在这个标签上干活（工具条据此在标签上显示一个点）。 */
  agentBusy: boolean;
}

/**
 * 浏览器面板状态：活动标签的 URL / 导航能力 + 全部标签。
 * 地址栏与后退/前进只作用于活动标签，所以那几项留在顶层。
 */
export interface BrowserState {
  /** 活动标签；一个标签都没有时为 null（面板显示空白新建页）。 */
  activeId: string | null;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  tabs: BrowserTab[];
}

/*
 * —— 浏览器自动化（P4）——
 *
 * main 侧的 src/main/browser/automation/（agent-browser 四件套）驱动内嵌浏览器；每一步 CLI
 * 都是一条受控动作（actions.ts 白名单），审计 = 工作区 logs/agent.log（不含页面正文）。
 * 渲染层只消费 AgentStep / 状态事件，拼不了命令。
 */

/** 一步浏览器动作的审计记录（agent:step 事件与 logs/agent.log 共用形状）。 */
export interface AgentStep {
  id: string;
  /** 发起会话（ConversationKey）；系统动作（tab 锁定 / 中止）为 null。 */
  key: string | null;
  /** 动作名：browser_read.open / browser_act.click / agent.lock-target / agent.abort。 */
  action: string;
  /** 实际执行的完整 argv（含 --session / --cdp 全局旗标），审计可复查。 */
  command: string[];
  ok: boolean;
  /** 结果摘要（不含页面正文）。 */
  summary: string;
  error: string | null;
  durationMs: number;
  at: string;
}

/** agent:step 的载荷：step 是新的一步；status 表示「是否有浏览器任务在跑」。 */
export type AgentStepEvent =
  | { type: "step"; step: AgentStep }
  | { type: "status"; running: boolean; key: string | null };

/** 浏览器自动化设置（<workspace>/agent-browser.json 的公开投影）。 */
export interface BrowserAgentSettings {
  /** 总开关：关闭时 companies / jobs / applications 会话不注册浏览器工具。 */
  enabled: boolean;
  submit: {
    /** 单站每日提交上限（默认 10）。 */
    dailyLimitPerSite: number;
    /** 两次提交之间的最小间隔秒数（默认 90，实际再加随机抖动）。 */
    minIntervalSeconds: number;
  };
  /** 平台适配模板（browser-playbooks.md）的落盘路径，只读展示；用户直接编辑文件。 */
  playbooksPath: string;
}

/** 保存浏览器自动化设置：只传要改的部分，数值由 main 夹紧。 */
export interface BrowserAgentSettingsDraft {
  enabled?: boolean;
  submit?: {
    dailyLimitPerSite?: number;
    minIntervalSeconds?: number;
  };
}

/**
 * agent:pane-open 的载荷：main 侧（浏览器任务开场等）请求渲染层把浏览器铺满内容区。
 * 右栏工作台已删除，这是该通道唯一剩下的用途。
 */
export type AgentPaneOpenEvent = { pane: "browser" };
