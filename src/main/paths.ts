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
 *       resumes/              0700  主简历们：一份一个文件夹（resume.md/history/tailored）
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
  /** 主简历们：一份一个文件夹（resume.md / history / tailored）。 */
  resumes: string;
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
