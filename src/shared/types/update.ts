/**
 * 自动更新（GitHub Releases）：main 侧用 electron-updater 检查 / 下载 / 安装，
 * 渲染层只订阅状态。版本来自打包产物里的 app-update.yml，开发模式下不可用。
 */

export const APP_REPOSITORY_URL = "https://github.com/ShaneLevs/GoodJob";
export const APP_RELEASES_URL = `${APP_REPOSITORY_URL}/releases`;

/** 自动检查更新是机器级偏好，跟外观设置一起放在 preferences.json。 */
export interface UpdatePreferences {
  /** 启动后自动检查 GitHub Releases；默认开。 */
  autoCheck: boolean;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  /** GitHub Release 正文（纯文本，已去掉 HTML 标签）。 */
  releaseNotes: string | null;
  releaseUrl: string | null;
  /** 下载进度 0–100；没在下载时为 null。 */
  progress: number | null;
  error: string | null;
  checkedAt: string | null;
  autoCheck: boolean;
  /** 只有打包产物支持检查与安装；dev 下为 false。 */
  supported: boolean;
}
