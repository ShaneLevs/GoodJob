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
 *   preferences.json          0600  基础设置：界面主题、字号、简历主题、自动检查更新
 *   models.json               0600  Agent 设置：模型供应商 + 模型（含 safeStorage 密文）
 *   voice.json                0600  Agent 设置：语音模型 TTS / ASR（阿里云百炼，含密文）
 *   notifications.json        0600  Agent 设置：通知 SMTP / IMAP 账户 + 日报 / 周报调度
 *   agent-browser.json        0600  Agent 设置：浏览器自动化开关 + 提交限速参数
 *   browser-playbooks.md      0600  Agent 设置：投递平台适配指令模板（用户可编辑）
 *   workspaces/               0700
 *     <workspaceId>/          0700  目录名一律用 ID，人类可读的名字只在索引里
 *       conversations/        0700  滚动会话（一条对话一个 <key>.json + threads.json 索引）
 *       resumes/              0700  主简历们：一份一个文件夹（resume.md/history/tailored/
 *                                   scripts 话术/reports 评分报告/upload 上传的参考文件）
 *       companies/            0700  公司档案：一个公司一个 <id>.json + upload/ 上传落点
 *       jobs/                 0700  岗位档案：一个岗位一个 <id>.json（含投递状态时间线 /
 *                                   Offer / 备注）+ upload/<jobId>/
 *       pipeline.json         0600  投递状态流水线定义（工作区级：有序阶段 + 终态）
 *       interviews/           0700  模拟面试：一场面试一个 <id>.json（逐轮问答
 *                                   本体在 conversations/ 的 interview:<id> 会话里）
 *                                   + upload/<interviewId>/
 *       workflows/            0700  GoodJob 工作流快照：一个 GoodJob 对话一个
 *                                   <encodeURIComponent(key)>.json
 *       uploads/              0700  GoodJob 会话里上传的参考文件与图片
 *       memory.md             0600  工作区级长期记忆，Agent 会话自动加载
 *       cache/                0700  可再生数据
 *       logs/                 0700  诊断日志
 * ```
 *
 * 明文密钥永远不会落盘：`models.json` / `voice.json` 只存 `safeStorage` 生成的密文。
 *
 * 设置全在根目录、所有工作区共用一份：基础设置（外观 / 简历主题）与 Agent 设置
 * （模型 / 语音 / 通知 / 浏览器）都不跟着工作区走，切工作区只换数据。
 */
export interface RootPaths {
  root: string;
  workspaces: string;
  index: string;
  /** 基础设置（外观 / 简历主题 / 自动检查更新），不跟工作区走。 */
  preferences: string;
  /** Agent 设置：模型供应商 + 模型（含 safeStorage 密文）。 */
  models: string;
  /** Agent 设置：语音模型 TTS / ASR（阿里云百炼，含 safeStorage 密文）。 */
  voice: string;
  /** Agent 设置：通知账户 + 日报 / 周报调度（密码 safeStorage 密文）。 */
  notifications: string;
  /** Agent 设置：浏览器自动化开关 + 限速参数 + 单站提交记账。 */
  agentBrowser: string;
  /** Agent 设置：投递平台适配指令模板（用户可编辑，Agent 投递前读进指令）。 */
  browserPlaybooks: string;
}

export interface WorkspacePaths {
  id: string;
  dir: string;
  conversations: string;
  /** 主简历们：一份一个文件夹（resume.md / history / tailored / scripts / reports / upload）。 */
  resumes: string;
  /** 公司档案集合：一个公司一个 `<id>.json`（stores/domain）。 */
  companies: string;
  /** 岗位档案集合：一个岗位一个 `<id>.json`（stores/domain）。 */
  jobs: string;
  /** 投递状态流水线（工作区级，stores/domain/pipeline）。 */
  pipeline: string;
  /** 模拟面试记录集合：一场面试一个 `<id>.json`（stores/domain/interviews）。 */
  interviews: string;
  /** GoodJob 工作流快照：一个 GoodJob 对话一个 `<encodeURIComponent(key)>.json`（agent/workflow）。 */
  workflows: string;
  /** GoodJob 会话的上传落点：工作区级 `uploads/`，不跟具体对话走。 */
  orchestratorUpload: string;
  /**
   * 各模块会话的上传落点（`uploads.ts` 按会话 key 选目录）：
   * companies/upload、jobs/upload（`job:<id>` 再下一层）、
   * interviews/upload（`interview:<id>` 再下一层）；简历会话用 resumes/<id>/upload。
   */
  companiesUpload: string;
  jobsUpload: string;
  interviewsUpload: string;
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
  const paths = rootPaths(root);
  ensureDir(paths.workspaces);
  return paths;
}

/** 根目录里的路径表（不碰 Electron app / 不做 mkdir）：冒烟脚本可直指明临时目录。 */
export function rootPaths(root: string): RootPaths {
  return {
    root,
    workspaces: path.join(root, "workspaces"),
    index: path.join(root, "workspaces.json"),
    preferences: path.join(root, "preferences.json"),
    models: path.join(root, "models.json"),
    voice: path.join(root, "voice.json"),
    notifications: path.join(root, "notifications.json"),
    agentBrowser: path.join(root, "agent-browser.json"),
    browserPlaybooks: path.join(root, "browser-playbooks.md"),
  };
}

export function workspacePaths(root: string, id: string): WorkspacePaths {
  const dir = path.join(root, "workspaces", id);
  return {
    id,
    dir,
    conversations: path.join(dir, "conversations"),
    resumes: path.join(dir, "resumes"),
    companies: path.join(dir, "companies"),
    jobs: path.join(dir, "jobs"),
    pipeline: path.join(dir, "pipeline.json"),
    interviews: path.join(dir, "interviews"),
    workflows: path.join(dir, "workflows"),
    orchestratorUpload: path.join(dir, "uploads"),
    companiesUpload: path.join(dir, "companies", "upload"),
    jobsUpload: path.join(dir, "jobs", "upload"),
    interviewsUpload: path.join(dir, "interviews", "upload"),
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
  ensureDir(paths.interviews);
  ensureDir(paths.workflows);
  ensureDir(paths.orchestratorUpload);
  ensureDir(paths.companiesUpload);
  ensureDir(paths.jobsUpload);
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
