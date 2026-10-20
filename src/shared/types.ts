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

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ChatErrorCode = "llm_not_configured" | "aborted" | "provider_error";

export type ChatEvent =
  | { id: string; type: "delta"; text: string }
  | { id: string; type: "done" }
  | { id: string; type: "error"; code: ChatErrorCode; message: string };

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
  chatEvent: "chat:event",
  modelsGet: "models:get",
  modelsSave: "models:save",
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
    send: (id: string, messages: ChatMessage[]) => Promise<void>;
    abort: (id: string) => void;
    onEvent: (listener: (event: ChatEvent) => void) => () => void;
  };
  models: {
    get: () => Promise<ModelsConfig>;
    save: (draft: ModelsDraft) => Promise<ModelsConfig>;
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
