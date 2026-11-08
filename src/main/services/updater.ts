import { app } from "electron";

// electron-updater 是 CommonJS 包，ESM 产物里拿不到具名导出，走 default。
import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";

import {
  APP_RELEASES_URL,
  type UpdatePhase,
  type UpdateState,
} from "@shared/types";

import type { PreferencesStore } from "../stores/preferences";

const { autoUpdater } = electronUpdater;

/** 启动后先缓一会儿再查，别和首屏加载、模型探测抢带宽。 */
const AUTO_CHECK_DELAY_MS = 15_000;
/** 应用长时间开着时，每 6 小时再查一次。 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 单次检查的上限：GitHub 偶尔会挂住连接，不能让「检查中」永远转下去。 */
const CHECK_TIMEOUT_MS = 30_000;

interface UpdateServiceOptions {
  preferences: PreferencesStore;
  /** 状态变化推给渲染层；窗口未就绪时由调用方的 getState 补齐。 */
  send: (state: UpdateState) => void;
}

/**
 * 自动更新（GitHub Releases）。
 *
 * - 检查 / 下载 / 安装全交给 electron-updater；发布元数据由 electron-builder
 *   打进产物的 `app-update.yml`（仓库见 electron-builder.yml 的 publish）。
 * - 检查到新版本后默认自动下载，退出应用时自动安装（autoInstallOnAppQuit）；
 *   「关于」页也提供立即重启安装的入口。
 * - 开发模式（`app.isPackaged === false`）没有 app-update.yml，状态固定 unsupported。
 */
export class UpdateService {
  private readonly preferences: PreferencesStore;
  private readonly send: (state: UpdateState) => void;

  private state: UpdateState;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor({ preferences, send }: UpdateServiceOptions) {
    this.preferences = preferences;
    this.send = send;

    this.state = {
      phase: app.isPackaged ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      latestVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseUrl: null,
      progress: null,
      error: null,
      checkedAt: null,
      autoCheck: preferences.updates.autoCheck,
      supported: app.isPackaged,
    };

    if (!app.isPackaged) return;

    // 下载随检查自动开始；装有更新时退出即安装，用户也可以在「关于」页手动重启。
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;

    autoUpdater.on("checking-for-update", () => {
      this.patch({ phase: "checking", error: null, progress: null });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.applyUpdateInfo(info, autoUpdater.autoDownload ? "downloading" : "available");
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.patch({
        phase: "up-to-date",
        latestVersion: info.version,
        releaseName: null,
        releaseNotes: null,
        releaseUrl: null,
        progress: null,
        error: null,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      this.patch({
        phase: "downloading",
        progress: Math.max(0, Math.min(100, Math.round(progress.percent))),
        error: null,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.applyUpdateInfo(info, "downloaded");
      this.patch({ progress: 100, error: null });
    });
    autoUpdater.on("error", (cause: Error) => {
      this.fail(cause);
    });
  }

  /** 应用启动后调用一次：按偏好安排自动检查（只生效一次）。 */
  start(): void {
    if (!this.state.supported || this.started) return;
    this.started = true;
    this.scheduleIfEnabled(AUTO_CHECK_DELAY_MS);
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(): Promise<UpdateState> {
    if (!this.state.supported) return this.getState();
    // 正在跑 / 已经拿到更新时不再叠加请求。
    if (
      this.state.phase === "checking" ||
      this.state.phase === "downloading" ||
      this.state.phase === "downloaded"
    ) {
      return this.getState();
    }

    this.patch({ phase: "checking", error: null, progress: null });
    try {
      await withTimeout(
        autoUpdater.checkForUpdates(),
        CHECK_TIMEOUT_MS,
        "检查更新超时，请稍后重试。",
      );
    } catch (cause) {
      this.fail(cause);
    }
    return this.getState();
  }

  /** 自动下载关掉时（或事件没触发）的显式下载入口。 */
  async download(): Promise<UpdateState> {
    if (!this.state.supported || this.state.phase !== "available") return this.getState();
    this.patch({ phase: "downloading", progress: 0, error: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (cause) {
      this.fail(cause);
    }
    return this.getState();
  }

  /** 退出并安装已下载的更新（只在 update-downloaded 之后有效）。 */
  install(): void {
    if (!this.state.supported || this.state.phase !== "downloaded") return;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  setAutoCheck(enabled: boolean): UpdateState {
    this.preferences.saveUpdates({ autoCheck: enabled });
    this.patch({ autoCheck: enabled });
    this.clearTimer();
    if (enabled) this.scheduleIfEnabled(AUTO_CHECK_DELAY_MS);
    return this.getState();
  }

  private scheduleIfEnabled(delay: number): void {
    this.clearTimer();
    if (!this.state.supported || !this.state.autoCheck) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => {
        this.scheduleIfEnabled(AUTO_CHECK_INTERVAL_MS);
      });
    }, delay);
    // 定时器不该单独撑住应用退出。
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private applyUpdateInfo(info: UpdateInfo, phase: UpdatePhase): void {
    this.patch({
      phase,
      latestVersion: info.version,
      releaseName: info.releaseName?.trim() || `v${info.version}`,
      releaseNotes: releaseNotesText(info),
      releaseUrl: releaseUrlFor(info.version),
      checkedAt: new Date().toISOString(),
      error: null,
      progress: phase === "downloaded" ? 100 : phase === "downloading" ? 0 : null,
    });
  }

  private fail(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.patch({
      phase: "error",
      error: friendlyError(message),
      progress: null,
      checkedAt: new Date().toISOString(),
    });
  }

  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.send(this.getState());
  }
}

/** 给上游 Promise 套一个超时；上游请求可能仍会继续，但 UI 不会卡在 checking。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function releaseUrlFor(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${APP_RELEASES_URL}/tag/${tag}`;
}

/** electron-updater 的 releaseNotes 可能是字符串或按版本的数组；统一成纯文本。 */
function releaseNotesText(info: UpdateInfo): string | null {
  const notes = info.releaseNotes;
  if (typeof notes === "string") return cleanNotes(notes);
  if (Array.isArray(notes)) {
    const joined = notes
      .map((item) => (item.note === null || item.note === undefined ? "" : item.note))
      .filter((note) => note.trim() !== "")
      .join("\n\n");
    return cleanNotes(joined);
  }
  return null;
}

function cleanNotes(value: string): string | null {
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text === "" ? null : text;
}

/** 把 electron-updater / HTTP 的错误翻成人能看懂的一句话。 */
function friendlyError(message: string): string {
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(message)) {
    return "连接 GitHub 失败，请检查网络后重试。";
  }
  if (/超时/.test(message)) {
    return message;
  }
  if (/\b(502|503|504)\b/.test(message)) {
    return "GitHub 暂时不可用，请稍后重试。";
  }
  if (/\b404\b/.test(message)) {
    return "读取不到发布信息：仓库需要保持公开，Release 里也要有 latest-mac.yml。";
  }
  if (/code signature|code signing/i.test(message)) {
    return "当前安装包未签名，macOS 不允许自动安装。请到 GitHub Releases 手动下载安装包。";
  }
  if (/app-update\.yml|APPIMAGE env/i.test(message)) {
    return "当前运行方式不支持自动更新（开发模式或未打包产物）。";
  }
  return message;
}
