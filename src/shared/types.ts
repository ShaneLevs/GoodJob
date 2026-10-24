/**
 * Types shared by the main process, the preload bridge and the renderer.
 * Keep this file dependency-free so it can be compiled into every process.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * 滚动会话的 key：一个模块一条会话，没有用户可见的"会话列表"。
 * 「对话」通用页已移除（产品决策：独立聊天不在规划内），目前只有简历一个入口；
 * 新增模块页时在这里登记，main 的工具注册表按它分发。
 */
export type ConversationKey = "resume";

/**
 * 会话消息的线上形态 —— 与 AI SDK 的 UIMessage 结构兼容。
 * shared 保持零依赖，所以 parts 用 unknown 承载，渲染层再断言回 UIMessage。
 */
export interface WireMessage {
  id: string;
  role: "system" | "user" | "assistant";
  parts: unknown[];
}

export interface ConversationState {
  key: ConversationKey;
  messages: WireMessage[];
  updatedAt: string | null;
}

/** 渲染层 → main 的一次 agent run：messages 是含新用户消息的完整 UI 历史。 */
export interface ChatSendPayload {
  key: ConversationKey;
  runId: string;
  messages: WireMessage[];
}

/** main → 渲染层的流事件：chunk 是 UIMessageChunk（可序列化线协议）；done 表示 run 结束。 */
export type ChatStreamEvent =
  | { key: ConversationKey; runId: string; type: "chunk"; chunk: unknown }
  | { key: ConversationKey; runId: string; type: "done" };

/** 一份主简历 = resumes/ 下一个文件夹；这里是索引里的元数据。 */
export interface ResumeMeta {
  id: string;
  name: string;
  createdAt: string;
}

export interface ResumeListState {
  items: ResumeMeta[];
  currentId: string | null;
}

/** 编辑器当前打开的文件：主简历正文，或某份岗位定制稿。 */
export type ResumeDocTarget =
  | { kind: "main" }
  | { kind: "tailored"; name: string };

export interface ResumeDoc {
  resumeId: string;
  /** 简历名称（索引里的人类可读名字）。 */
  name: string;
  target: ResumeDocTarget;
  content: string;
}

export interface TailoredDoc {
  /** 文件名（不含扩展名，slug）。 */
  name: string;
  updatedAt: string | null;
}

/** 上传旧简历后抽出的纯文本，交给简历会话里的 Agent 整理成 resume.md。 */
export interface ImportedResume {
  fileName: string;
  text: string;
}

/** 用户或 Agent 写入简历文件后广播；编辑器据此热更新，或（有未保存修改时）提示冲突。 */
export interface ResumeFileEvent {
  resumeId: string;
  /** "main" 或定制稿文件名（不含扩展名）。 */
  file: string;
}

/**
 * Wire protocol of a provider. Each one maps to a different AI SDK adapter
 * factory, which is why it is stored per provider instead of per model.
 */
export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ModelEntry {
  /** Value sent as `model` in the request. */
  id: string;
  /** Display name; falls back to `id` when empty. */
  name: string;
  enabled: boolean;
  /** Context window in tokens — only used for the UI badge. */
  contextWindow?: number;
  vision?: boolean;
  reasoning?: boolean;
}

/** One model provider as stored in `<workspace>/models.json`. */
export interface ProviderConfig {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  models: ModelEntry[];
}

/**
 * 对话要调用的模型。设置页不再提供这个选择（那里只管"有哪些模型可用"），
 * 将来由对话侧的模型选择器写入。
 */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** Provider as seen by the renderer: the API key itself never crosses the bridge. */
export interface PublicProvider extends ProviderConfig {
  hasApiKey: boolean;
}

/** The model the chat will actually call, plus whether it is usable yet. */
export interface ActiveModel {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  /** False when the provider needs an API key that has not been stored. */
  ready: boolean;
}

export interface ModelsConfig {
  version: number;
  defaultModel: ModelSelection | null;
  providers: PublicProvider[];
  activeModel: ActiveModel | null;
  /** False when the OS keychain is unavailable, so keys cannot be encrypted. */
  canStoreKey: boolean;
}

export interface ProviderDraft extends ProviderConfig {
  /** `undefined` keeps the stored key, `null` clears it, a string replaces it. */
  apiKey?: string | null;
}

export interface ModelsDraft {
  /**
   * 省略表示"保持原值"。设置页只维护供应商与模型清单，对话用哪个模型由对话侧自己决定，
   * 所以这里不再由设置页写入。
   */
  defaultModel?: ModelSelection | null;
  providers: ProviderDraft[];
}

/**
 * 一个工作区 = 配置文件夹下的一个子文件夹，目录名用 `id`，`name` 只存在索引里。
 * 切换工作区会连带换掉模型配置和后续所有数据。
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  createdAt: string;
}

export interface WorkspacesState {
  items: WorkspaceInfo[];
  /** 始终有值：首次启动会自动创建默认工作区。 */
  currentId: string;
}

/**
 * 界面主题：跟随系统 / 强制浅色 / 强制深色。
 * 外观设置属于"这台机器上的这个人"，不属于工作区，所以存在配置根目录而不是工作区里。
 */
export type ThemeMode = "system" | "light" | "dark";

export interface AppearanceSettings {
  themeMode: ThemeMode;
  /** 界面字号（px），10–18。 */
  fontSize: number;
}

export interface AppInfo {
  platform: string;
  version: string;
  /** 配置根目录，例如 ~/.goodjob */
  dataDir: string;
  /** 当前工作区目录，配置与数据都在里面 */
  workspaceDir: string;
}

/** IPC channel names — a single source of truth for both sides. */
export const IPC = {
  appInfo: "app:info",
  browserSetBounds: "browser:set-bounds",
  browserSetVisible: "browser:set-visible",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserStop: "browser:stop",
  browserToggleDevTools: "browser:toggle-devtools",
  browserState: "browser:state",
  chatSend: "chat:send",
  chatAbort: "chat:abort",
  chatChunk: "chat:chunk",
  conversationsGet: "conversations:get",
  conversationsSync: "conversations:sync",
  resumeList: "resume:list",
  resumeCreate: "resume:create",
  resumeRename: "resume:rename",
  resumeDelete: "resume:delete",
  resumeSelect: "resume:select",
  resumeRead: "resume:read",
  resumeSave: "resume:save",
  resumeTailoredList: "resume:tailored-list",
  resumeImport: "resume:import",
  resumeFileChanged: "resume:file-changed",
  modelsGet: "models:get",
  modelsSave: "models:save",
  modelsSelect: "models:select",
  appearanceGet: "appearance:get",
  appearanceSave: "appearance:save",
  workspaceGet: "workspace:get",
  workspaceSwitch: "workspace:switch",
  workspaceChanged: "workspace:changed",
} as const;

/** Shape exposed on `window.goodjob` by the preload script. */
export interface GoodjobApi {
  app: {
    info: () => Promise<AppInfo>;
  };
  browser: {
    setBounds: (rect: Rect | null) => void;
    setVisible: (visible: boolean) => void;
    navigate: (url: string) => Promise<void>;
    back: () => void;
    forward: () => void;
    reload: () => void;
    stop: () => void;
    toggleDevTools: () => void;
    onState: (listener: (state: BrowserState) => void) => () => void;
  };
  chat: {
    /** 发起一次 agent run；chunk 流从 onChunk 订阅（按 key + runId 过滤）。 */
    send: (payload: ChatSendPayload) => Promise<void>;
    abort: (key: ConversationKey) => void;
    onChunk: (listener: (event: ChatStreamEvent) => void) => () => void;
  };
  conversations: {
    /** 模块滚动会话：挂载时取初始消息，run 结束后用 sync 落盘装配结果。 */
    get: (key: ConversationKey) => Promise<ConversationState>;
    sync: (key: ConversationKey, messages: WireMessage[]) => Promise<void>;
  };
  resume: {
    list: () => Promise<ResumeListState>;
    create: (name: string) => Promise<ResumeListState>;
    rename: (id: string, name: string) => Promise<ResumeListState>;
    remove: (id: string) => Promise<ResumeListState>;
    select: (id: string) => Promise<ResumeListState>;
    /** 读取当前简历的正文或定制稿；还没有简历时返回 null。 */
    read: (target: ResumeDocTarget) => Promise<ResumeDoc | null>;
    save: (target: ResumeDocTarget, content: string) => Promise<ResumeDoc | null>;
    listTailored: () => Promise<TailoredDoc[]>;
    /** 打开系统选择框抽取旧简历文本（PDF/DOCX/MD/TXT）；取消返回 null。 */
    importFile: () => Promise<ImportedResume | null>;
    onFileChanged: (listener: (event: ResumeFileEvent) => void) => () => void;
  };
  models: {
    get: () => Promise<ModelsConfig>;
    save: (draft: ModelsDraft) => Promise<ModelsConfig>;
    /** 对话侧模型选择器：只改这个工作区的默认模型，不动供应商与 Key。 */
    selectDefault: (selection: ModelSelection | null) => Promise<ModelsConfig>;
  };
  appearance: {
    get: () => Promise<AppearanceSettings>;
    save: (patch: Partial<AppearanceSettings>) => Promise<AppearanceSettings>;
  };
  workspace: {
    get: () => Promise<WorkspacesState>;
    switchTo: (id: string) => Promise<WorkspacesState>;
    /** 切换成功后 main 会广播，渲染层据此重读 models。 */
    onChanged: (listener: (state: WorkspacesState) => void) => () => void;
  };
}
