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
