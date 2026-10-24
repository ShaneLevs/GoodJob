import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ResumeDoc,
  ResumeDocTarget,
  ResumeFileEvent,
  ResumeListState,
  ResumeMeta,
  TailoredDoc,
} from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "./paths";

/** history/ 里最多保留的快照份数，超出删最旧的。 */
const HISTORY_LIMIT = 50;

const STARTER_TEMPLATE = `# 姓名

## 基本信息

- 城市：
- 电话：
- 邮箱：
- 工作年限：

## 求职意向

目标岗位：

## 工作经历

## 项目经历

## 教育背景

## 技能
`;

interface ResumeIndex {
  items: ResumeMeta[];
  currentId: string | null;
}

/**
 * 简历模块的持久化：`<workspace>/resumes/` 下一份主简历一个文件夹。
 *
 * ```
 * resumes/
 *   index.json                 名字等元数据（目录名一律 ID，改名不动磁盘）
 *   <resumeId>/
 *     resume.md                主简历正文（唯一源，人与 Agent 共编）
 *     history/                 每次覆盖写入前的快照
 *     tailored/<name>.md       岗位定制稿
 * ```
 *
 * 文件写入会通过 watcher + 直接回调两条路径广播 `ResumeFileEvent`，
 * 编辑器据此热更新；两条路径可能重复触发，渲染层按内容幂等处理。
 */
export class ResumeStore {
  private workspace: WorkspacePaths;
  private doc: ResumeIndex;
  private watcher: fs.FSWatcher | null = null;
  private readonly pendingEvents = new Map<string, NodeJS.Timeout>();
  private readonly onFileChanged: (event: ResumeFileEvent) => void;

  constructor(workspace: WorkspacePaths, onFileChanged: (event: ResumeFileEvent) => void) {
    this.workspace = workspace;
    this.onFileChanged = onFileChanged;
    this.doc = this.readIndex();
    this.ensureDefault();
    this.startWatch();
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.stopWatch();
    this.workspace = workspace;
    this.doc = this.readIndex();
    this.ensureDefault();
    this.startWatch();
  }

  list(): ResumeListState {
    return { items: this.doc.items, currentId: this.doc.currentId };
  }

  create(name: string): ResumeListState {
    const trimmed = name.trim() === "" ? "未命名简历" : name.trim();
    const id = `rs_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const dir = this.resumeDir(id);
    ensureDir(dir);
    ensureDir(path.join(dir, "history"));
    ensureDir(path.join(dir, "tailored"));
    this.writeMainFile(dir, STARTER_TEMPLATE);

    this.doc.items.push({ id, name: trimmed, createdAt: new Date().toISOString() });
    if (this.doc.currentId === null) this.doc.currentId = id;
    this.persistIndex();
    this.restartWatchIfCurrent(id);
    return this.list();
  }

  rename(id: string, name: string): ResumeListState {
    const item = this.doc.items.find((entry) => entry.id === id);
    const trimmed = name.trim();
    if (item !== undefined && trimmed !== "") item.name = trimmed;
    this.persistIndex();
    return this.list();
  }

  remove(id: string): ResumeListState {
    if (this.doc.items.length <= 1 && this.doc.items.some((item) => item.id === id)) {
      throw new Error("至少保留一份简历");
    }
    this.doc.items = this.doc.items.filter((item) => item.id !== id);
    if (this.doc.currentId === id) this.doc.currentId = this.doc.items[0]?.id ?? null;

    try {
      fs.rmSync(this.resumeDir(id), { recursive: true, force: true });
    } catch {
      // 目录已被手动删掉之类的情况：索引才是事实，忽略磁盘错误。
    }
    this.persistIndex();
    this.startWatch();
    return this.list();
  }

  select(id: string): ResumeListState {
    if (this.doc.items.some((item) => item.id === id)) {
      this.doc.currentId = id;
      this.persistIndex();
      this.startWatch();
    }
    return this.list();
  }

  read(target: ResumeDocTarget): ResumeDoc | null {
    const current = this.current();
    if (current === null) return null;
    const file = this.targetFile(current.id, target);
    if (!fs.existsSync(file)) return null;
    return {
      resumeId: current.id,
      name: current.name,
      target,
      content: fs.readFileSync(file, "utf8"),
    };
  }

  save(target: ResumeDocTarget, content: string): ResumeDoc | null {
    const current = this.current();
    if (current === null) return null;
    const file = this.targetFile(current.id, target);
    if (target.kind === "main") {
      this.snapshotMain(this.resumeDir(current.id));
      this.writeMainFile(this.resumeDir(current.id), content);
    } else {
      fs.writeFileSync(file, content, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    this.emitFileChanged({ resumeId: current.id, file: targetFileLabel(target) });
    return this.read(target);
  }

  listTailored(): TailoredDoc[] {
    const current = this.current();
    if (current === null) return [];
    const dir = path.join(this.resumeDir(current.id), "tailored");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        let updatedAt: string | null = null;
        try {
          updatedAt = fs.statSync(path.join(dir, entry.name)).mtime.toISOString();
        } catch {
          // 文件刚好被删掉：保底给个 null
        }
        return { name: entry.name.slice(0, -3), updatedAt };
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /** Agent 的定制稿工具入口：校验文件名后写入当前简历文件夹。 */
  writeTailored(name: string, content: string): { name: string } {
    const safe = normalizeTailoredName(name);
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const dir = path.join(this.resumeDir(current.id), "tailored");
    ensureDir(dir);
    const file = path.join(dir, `${safe}.md`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    this.emitFileChanged({ resumeId: current.id, file: safe });
    return { name: safe };
  }

  readTailored(name: string): string | null {
    const current = this.current();
    if (current === null) return null;
    const file = path.join(this.resumeDir(current.id), "tailored", `${normalizeTailoredName(name)}.md`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  listTailoredNames(): string[] {
    return this.listTailored().map((doc) => doc.name);
  }

  private current(): ResumeMeta | null {
    return this.doc.items.find((item) => item.id === this.doc.currentId) ?? null;
  }

  private resumeDir(id: string): string {
    return path.join(this.workspace.resumes, id);
  }

  private targetFile(id: string, target: ResumeDocTarget): string {
    return target.kind === "main"
      ? path.join(this.resumeDir(id), "resume.md")
      : path.join(this.resumeDir(id), "tailored", `${normalizeTailoredName(target.name)}.md`);
  }

  private writeMainFile(dir: string, content: string): void {
    const file = path.join(dir, "resume.md");
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  /** 覆盖主简历前把旧内容快照进 history/，保底保留最近 HISTORY_LIMIT 份。 */
  private snapshotMain(dir: string): void {
    const file = path.join(dir, "resume.md");
    if (!fs.existsSync(file)) return;

    const historyDir = path.join(dir, "history");
    ensureDir(historyDir);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    fs.copyFileSync(file, path.join(historyDir, `${stamp}-${randomUUID().slice(0, 4)}.md`));

    const snapshots = fs
      .readdirSync(historyDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
    while (snapshots.length > HISTORY_LIMIT) {
      fs.rmSync(path.join(historyDir, snapshots.shift() as string), { force: true });
    }
  }

  private emitFileChanged(event: ResumeFileEvent): void {
    this.onFileChanged(event);
  }

  /** watcher 事件防抖：编辑器只需要"这个文件变了"这一个事实。 */
  private scheduleEvent(event: ResumeFileEvent): void {
    const key = `${event.resumeId}/${event.file}`;
    const existing = this.pendingEvents.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.pendingEvents.set(
      key,
      setTimeout(() => {
        this.pendingEvents.delete(key);
        this.emitFileChanged(event);
      }, 200),
    );
  }

  private restartWatchIfCurrent(id: string): void {
    if (this.doc.currentId === id) this.startWatch();
  }

  private startWatch(): void {
    this.stopWatch();
    const current = this.current();
    if (current === null) return;
    try {
      this.watcher = fs.watch(this.resumeDir(current.id), { recursive: true }, (_type, filename) => {
        const rel = filename?.toString() ?? "";
        if (!rel.endsWith(".md")) return;
        if (rel === "resume.md") {
          this.scheduleEvent({ resumeId: current.id, file: "main" });
          return;
        }
        if (rel.startsWith("tailored/") && !rel.slice("tailored/".length).includes("/")) {
          this.scheduleEvent({
            resumeId: current.id,
            file: rel.slice("tailored/".length, -".md".length),
          });
        }
      });
      this.watcher.on("error", () => this.stopWatch());
    } catch {
      this.watcher = null;
    }
  }

  private stopWatch(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.pendingEvents.values()) clearTimeout(timer);
    this.pendingEvents.clear();
  }

  private ensureDefault(): void {
    if (this.doc.items.length === 0) {
      const id = `rs_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const dir = this.resumeDir(id);
      ensureDir(dir);
      ensureDir(path.join(dir, "history"));
      ensureDir(path.join(dir, "tailored"));
      this.writeMainFile(dir, STARTER_TEMPLATE);
      this.doc = {
        items: [{ id, name: "我的简历", createdAt: new Date().toISOString() }],
        currentId: id,
      };
      this.persistIndex();
      return;
    }
    if (this.doc.currentId === null || !this.doc.items.some((item) => item.id === this.doc.currentId)) {
      this.doc.currentId = this.doc.items[0]?.id ?? null;
      this.persistIndex();
    }
  }

  private persistIndex(): void {
    writeJsonFile(path.join(this.workspace.resumes, "index.json"), this.doc);
  }

  private readIndex(): ResumeIndex {
    try {
      const raw = fs.readFileSync(path.join(this.workspace.resumes, "index.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("bad index");

      const record = parsed as Record<string, unknown>;
      const items: ResumeMeta[] = [];
      if (Array.isArray(record.items)) {
        for (const entry of record.items) {
          if (typeof entry !== "object" || entry === null) continue;
          const meta = entry as Record<string, unknown>;
          const id = typeof meta.id === "string" ? meta.id.trim() : "";
          if (id === "" || items.some((item) => item.id === id)) continue;
          items.push({
            id,
            name: typeof meta.name === "string" && meta.name.trim() !== "" ? meta.name : id,
            createdAt:
              typeof meta.createdAt === "string" ? meta.createdAt : new Date().toISOString(),
          });
        }
      }
      return {
        items,
        currentId: typeof record.currentId === "string" ? record.currentId : null,
      };
    } catch {
      return { items: [], currentId: null };
    }
  }
}

function targetFileLabel(target: ResumeDocTarget): string {
  return target.kind === "main" ? "main" : normalizeTailoredName(target.name);
}

/**
 * 定制稿文件名：允许中文/字母/数字/连字符/下划线，禁止路径分隔符和 `..`。
 * 返回裁剪后的安全名；不合法时抛错（工具调用会把错误带回给模型）。
 */
function normalizeTailoredName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed.length > 64 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /[<>:"|?*\u0000-\u001f]/.test(trimmed)
  ) {
    throw new Error(`不合法的文件名：${name}`);
  }
  return trimmed;
}

/** 上传旧简历 → 抽纯文本。PDF 用 unpdf，DOCX 用 mammoth，其余按 UTF-8 文本读。 */
export async function extractResumeText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === ".docx") {
    // mammoth 是 CJS：命名导出经 cjs-module-lexer 不一定可见，兜底走 default。
    const module = await import("mammoth");
    const mammoth = module.default ?? module;
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  return fs.readFileSync(filePath, "utf8");
}
