import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

/**
 * 一个工作区 = 一个文件夹，配置和该工作区的全部数据都放在里面。
 * 同一个软件因此可以并存多份工作区（不同的人、或同一个人不同时期的简历）。
 *
 * ```
 * ~/.goodjob/                 0700
 *   workspaces.json           0600  工作区索引：id / name / createdAt / currentId
 *   preferences.json          0600  机器级偏好：主题、界面字号
 *   workspaces/               0700
 *     <workspaceId>/          0700  目录名一律用 ID，人类可读的名字只在索引里
 *       models.json           0600  模型供应商 + 模型（含 safeStorage 密文）
 *       conversations/        0700  滚动会话（一个模块一个 <key>.json）
 *       resumes/              0700  主简历们：一份一个文件夹（resume.md/history/tailored/
 *                                   scripts 话术/reports 评分报告/upload 上传的参考文件）
 *       companies/            0700  公司档案：一个公司一个 <id>.json + upload/ 上传落点
 *       jobs/                 0700  岗位档案：一个岗位一个 <id>.json + upload/<jobId>/
 *       applications/         0700  投递档案：一个投递一个 <id>.json +
 *                                   pipeline.json 状态流水线定义（工作区级）+ upload/
 *       interviews/           0700  模拟面试：一场面试一个 <id>.json（逐轮问答
 *                                   本体在 conversations/ 的 interview:<id> 会话里）
 *                                   + upload/<interviewId>/
 *       notifications.json    0600  通知配置（P3）：SMTP / IMAP 账户 + 日报 / 周报调度，
 *                                   密码是 safeStorage 密文（跟随工作区，可对不同邮箱）
 *       agent-browser.json    0600  浏览器自动化设置（P4）：启用开关 + 提交限速参数
 *                                   + 单站提交记账（每日上限按本地日历日重置）
 *       browser-playbooks.md  0600  投递平台适配指令模板（P4，用户可编辑），Agent
 *                                   投递前会读进指令
 *       memory.md             0600  工作区级长期记忆，Agent 会话自动加载
 *       cache/                0700  可再生数据
 *       logs/                 0700  诊断日志
 * ```
 *
 * 明文密钥永远不会落盘：`models.json` 只存 `safeStorage` 生成的密文。
 */
export interface RootPaths {
  root: string;
  workspaces: string;
  index: string;
  /** 机器级偏好（外观等），不跟工作区走。 */
  preferences: string;
}

export interface WorkspacePaths {
  id: string;
  dir: string;
  models: string;
  conversations: string;
  /** 主简历们：一份一个文件夹（resume.md / history / tailored / scripts / reports / upload）。 */
  resumes: string;
  /** 公司档案集合：一个公司一个 `<id>.json`（domain-store）。 */
  companies: string;
  /** 岗位档案集合：一个岗位一个 `<id>.json`（domain-store）。 */
  jobs: string;
  /** 投递档案集合：一个投递一个 `<id>.json` + 工作区级 `pipeline.json`（domain-store）。 */
  applications: string;
  /** 模拟面试记录集合：一场面试一个 `<id>.json`（interviews-store）。 */
  interviews: string;
  /**
   * 各模块会话的上传落点（`uploads.ts` 按会话 key 选目录）：
   * companies/upload、jobs/upload（`job:<id>` 再下一层）、applications/upload、
   * interviews/upload（`interview:<id>` 再下一层）；简历会话用 resumes/<id>/upload。
   */
  companiesUpload: string;
  jobsUpload: string;
  applicationsUpload: string;
  interviewsUpload: string;
  /** 通知配置（notify-store）：SMTP / IMAP 账户 + 日报 / 周报调度，密码 safeStorage 密文。 */
  notifications: string;
  /** 浏览器自动化设置（P4，agent/ 下的 settings-store）：开关 + 限速参数 + 提交记账。 */
  agentBrowser: string;
  /** 投递平台适配指令模板（P4）：用户可编辑，Agent 投递前读进指令。 */
  browserPlaybooks: string;
  /** 工作区级长期记忆，Agent 每次会话自动加载。 */
  memory: string;
  cache: string;
  logs: string;
}

export function createRootPaths(): RootPaths {
  // GOODJOB_DATA_DIR lets a test instance keep its data out of the real ~/.goodjob.
  const override = process.env.GOODJOB_DATA_DIR;
  const root =
    override !== undefined && override.trim() !== ""
      ? path.resolve(override)
      : path.join(app.getPath("home"), ".goodjob");

  ensureDir(root);
  const paths: RootPaths = {
    root,
    workspaces: path.join(root, "workspaces"),
    index: path.join(root, "workspaces.json"),
    preferences: path.join(root, "preferences.json"),
  };
  ensureDir(paths.workspaces);
  return paths;
}

export function workspacePaths(root: string, id: string): WorkspacePaths {
  const dir = path.join(root, "workspaces", id);
  return {
    id,
    dir,
    models: path.join(dir, "models.json"),
    conversations: path.join(dir, "conversations"),
    resumes: path.join(dir, "resumes"),
    companies: path.join(dir, "companies"),
    jobs: path.join(dir, "jobs"),
    applications: path.join(dir, "applications"),
    interviews: path.join(dir, "interviews"),
    companiesUpload: path.join(dir, "companies", "upload"),
    jobsUpload: path.join(dir, "jobs", "upload"),
    applicationsUpload: path.join(dir, "applications", "upload"),
    interviewsUpload: path.join(dir, "interviews", "upload"),
    notifications: path.join(dir, "notifications.json"),
    agentBrowser: path.join(dir, "agent-browser.json"),
    browserPlaybooks: path.join(dir, "browser-playbooks.md"),
    memory: path.join(dir, "memory.md"),
    cache: path.join(dir, "cache"),
    logs: path.join(dir, "logs"),
  };
}

/** 建好工作区骨架目录（已存在则什么也不做）。 */
export function ensureWorkspaceDirs(paths: WorkspacePaths): void {
  ensureDir(paths.dir);
  ensureDir(paths.conversations);
  ensureDir(paths.resumes);
  ensureDir(paths.companies);
  ensureDir(paths.jobs);
  ensureDir(paths.applications);
  ensureDir(paths.interviews);
  ensureDir(paths.companiesUpload);
  ensureDir(paths.jobsUpload);
  ensureDir(paths.applicationsUpload);
  ensureDir(paths.interviewsUpload);
  ensureDir(paths.cache);
  ensureDir(paths.logs);
}

/** Creates a directory that only the current user can read or write. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Writes JSON with owner-only permissions (never world-readable). */
export function writeJsonFile(file: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, serialized, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
