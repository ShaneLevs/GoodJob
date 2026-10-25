import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type {
  IntegrityReport,
  JobMatchDimension,
  ResumeDoc,
  ResumeDocTarget,
  ResumeFileEvent,
  ResumeListState,
  ResumeMeta,
  ScriptDoc,
  TailoredDoc,
  UploadedFileMeta,
} from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "./paths";

/** history/ 里最多保留的快照份数，超出删最旧的。 */
const HISTORY_LIMIT = 50;
/** 单个上传文件的大小上限：参考文件用不着更大，挡住误选的安装包/视频。 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 工具读取上传文件时的文本上限，防止巨型文本撑爆上下文。 */
const READ_TEXT_LIMIT = 300_000;

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
 *     tailored/<jobId>.md      岗位定制简历（与岗位 1:1，key = jobId；
 *                              P1 的旧 name 版文件仍可按文件名读取）
 *     tailored/history/        定制稿覆盖写入前的快照
 *     scripts/<jobId>.md       岗位话术当前版 + <jobId>.json 定稿 sidecar
 *     scripts/history/         话术版本快照（每次覆盖前 + 每次定稿时）
 *     reports/<ts>-integrity.json   主简历完整性报告（后台任务写入，保留历史）
 *     upload/                  用户上传的参考文件（原样落盘，Agent 按需读取）
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
    this.ensureResumeSubdirs(dir);
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

  /**
   * Agent 的定制稿工具入口：按 key（现在约定是 jobId，旧 name 文件名同样可读可写）
   * 写入当前简历文件夹，覆盖前自动快照进 `tailored/history/`。
   * `migrateFrom`：P1 旧 name 版文件名——给了就在写入成功后删除旧文件，
   * 完成「旧 name 键 → jobId 键」的一次性迁移（旧内容已由调用方读取使用）。
   */
  writeTailored(key: string, content: string, migrateFrom?: string): { key: string } {
    const safe = normalizeTailoredName(key);
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const dir = path.join(this.resumeDir(current.id), "tailored");
    ensureDir(dir);
    this.snapshotTailored(dir, safe);
    const file = path.join(dir, `${safe}.md`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    if (migrateFrom !== undefined) {
      const legacy = path.join(dir, `${normalizeTailoredName(migrateFrom)}.md`);
      if (legacy !== file) {
        try {
          fs.rmSync(legacy, { force: true });
        } catch {
          // 旧文件删不掉不阻塞迁移：内容已并入新 key，残留无害。
        }
      }
    }
    this.emitFileChanged({ resumeId: current.id, file: safe });
    return { key: safe };
  }

  /** 按 key 读取定制稿（jobId 或 P1 的旧文件名，兼容读取）。 */
  readTailored(key: string): string | null {
    const current = this.current();
    if (current === null) return null;
    const file = path.join(this.resumeDir(current.id), "tailored", `${normalizeTailoredName(key)}.md`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  listTailoredNames(): string[] {
    return this.listTailored().map((doc) => doc.name);
  }

  /** 指定 id 的主简历正文（后台任务用；不存在的简历返回 null）。 */
  readMainById(id: string): string | null {
    if (!this.doc.items.some((item) => item.id === id)) return null;
    const file = path.join(this.resumeDir(id), "resume.md");
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  }

  /* ————————— 岗位话术：scripts/<jobId>.md + 定稿 sidecar ————————— */

  /** 当前简历的话术列表（含定稿状态；modifiedSinceFinal 提示「待重新定稿」）。 */
  listScripts(): ScriptDoc[] {
    const current = this.current();
    if (current === null) return [];
    const dir = this.scriptsDir(current.id);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const jobId = entry.name.slice(0, -3);
        const file = path.join(dir, entry.name);
        let updatedAt: string | null = null;
        try {
          updatedAt = fs.statSync(file).mtime.toISOString();
        } catch {
          // 文件刚好被删掉：保底给个 null
        }
        return { ...this.scriptDoc(jobId, file), updatedAt };
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  readScript(jobId: string): { jobId: string; content: string; doc: ScriptDoc } | null {
    const current = this.current();
    if (current === null) return null;
    const key = normalizeTailoredName(jobId);
    const file = path.join(this.scriptsDir(current.id), `${key}.md`);
    if (!fs.existsSync(file)) return null;
    return {
      jobId: key,
      content: fs.readFileSync(file, "utf8"),
      doc: this.scriptDoc(key, file),
    };
  }

  /** 覆盖写话术当前版（旧内容快照进 scripts/history/；定稿状态保留由指纹判断）。 */
  writeScript(jobId: string, content: string): ScriptDoc {
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const key = normalizeTailoredName(jobId);
    const dir = this.scriptsDir(current.id);
    ensureDir(dir);
    this.snapshotScript(dir, key);
    const file = path.join(dir, `${key}.md`);
    fs.writeFileSync(file, content, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return this.scriptDoc(key, file);
  }

  /**
   * 话术定稿：锁定「供引用的版本」（当前内容进 scripts/history/，sidecar 记录指纹
   * 与时间）。定稿不锁编辑——之后仍可 writeScript 继续改，改过会显示
   * modifiedSinceFinal，重新定稿即可；旧定稿永远留在 history/ 里。
   */
  finalizeScript(jobId: string): ScriptDoc {
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const key = normalizeTailoredName(jobId);
    const dir = this.scriptsDir(current.id);
    const file = path.join(dir, `${key}.md`);
    if (!fs.existsSync(file)) throw new Error(`还没有「${key}」的话术，先 script_write 生成一版。`);

    const content = fs.readFileSync(file, "utf8");
    this.snapshotScript(dir, key);
    writeJsonFile(path.join(dir, `${key}.json`), {
      final: true,
      finalizedAt: new Date().toISOString(),
      finalSha: sha256(content),
    });
    return this.scriptDoc(key, file);
  }

  /** 读 sidecar + 算指纹，拼出对外的话术状态。 */
  private scriptDoc(jobId: string, file: string): ScriptDoc {
    const sidecarFile = path.join(path.dirname(file), `${jobId}.json`);
    let final = false;
    let finalizedAt: string | null = null;
    let modifiedSinceFinal = false;
    try {
      const sidecar: unknown = JSON.parse(fs.readFileSync(sidecarFile, "utf8"));
      if (typeof sidecar === "object" && sidecar !== null) {
        const record = sidecar as Record<string, unknown>;
        final = record.final === true;
        finalizedAt = typeof record.finalizedAt === "string" ? record.finalizedAt : null;
        if (final && typeof record.finalSha === "string") {
          modifiedSinceFinal = sha256(fs.readFileSync(file, "utf8")) !== record.finalSha;
        }
      }
    } catch {
      // 没有 sidecar = 从未定稿，全部保持默认值。
    }
    return { jobId, updatedAt: null, final, finalizedAt, modifiedSinceFinal };
  }

  private scriptsDir(resumeId: string): string {
    return path.join(this.resumeDir(resumeId), "scripts");
  }

  /* ———————— 完整性报告：reports/<ts>-integrity.json（保留历史） ———————— */

  saveIntegrityReport(resumeId: string, report: {
    score: number;
    dimensions: JobMatchDimension[];
    conclusion: string;
  }): IntegrityReport {
    if (!this.doc.items.some((item) => item.id === resumeId)) throw new Error(`简历不存在：${resumeId}`);
    const dir = path.join(this.resumeDir(resumeId), "reports");
    ensureDir(dir);
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[-:]/g, "").replace(/\..+/, "");
    const file = `${stamp}-integrity.json`;
    writeJsonFile(path.join(dir, file), { ...report, createdAt });
    return { file, ...report, createdAt };
  }

  listIntegrityReports(resumeId: string): IntegrityReport[] {
    const dir = path.join(this.resumeDir(resumeId), "reports");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith("-integrity.json"))
      .map((entry) => {
        const file = entry.name;
        try {
          const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
          if (typeof raw !== "object" || raw === null) throw new Error("bad report");
          const record = raw as Record<string, unknown>;
          const dimensions = Array.isArray(record.dimensions)
            ? record.dimensions.flatMap((item): JobMatchDimension[] => {
                if (typeof item !== "object" || item === null) return [];
                const dimension = item as Record<string, unknown>;
                return [
                  {
                    name: typeof dimension.name === "string" ? dimension.name : "维度",
                    score: typeof dimension.score === "number" ? dimension.score : 0,
                    comment: typeof dimension.comment === "string" ? dimension.comment : "",
                  },
                ];
              })
            : [];
          return {
            file,
            score: typeof record.score === "number" ? record.score : 0,
            dimensions,
            conclusion: typeof record.conclusion === "string" ? record.conclusion : "",
            createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          } satisfies IntegrityReport;
        } catch {
          return null;
        }
      })
      .filter((report): report is IntegrityReport => report !== null)
      .sort((a, b) => b.file.localeCompare(a.file));
  }

  /**
   * 用户上传的落盘点：把所选文件原样复制进当前简历文件夹的 `upload/`。
   * 只负责保存，不解析——内容由 Agent 按需用 readUpload 抽取。
   */
  uploadFile(srcPath: string): UploadedFileMeta {
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const size = fs.statSync(srcPath).size;
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
    }

    const dir = this.uploadDir(current.id);
    ensureDir(dir);
    const fileName = dedupeFileName(dir, sanitizeUploadName(path.basename(srcPath)));
    const dest = path.join(dir, fileName);
    fs.copyFileSync(srcPath, dest);
    fs.chmodSync(dest, 0o600);
    return { fileName, size: fs.statSync(dest).size };
  }

  listUploads(): UploadedFileMeta[] {
    const current = this.current();
    if (current === null) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.uploadDir(current.id), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(this.uploadDir(current.id), entry.name);
        let size = 0;
        let mtime = 0;
        try {
          const stat = fs.statSync(file);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch {
          // 文件刚好被删掉：跳过也行，但保底还能展示名字。
        }
        return { fileName: entry.name, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ fileName, size }) => ({ fileName, size }));
  }

  /** Agent 的上传读取工具：PDF / DOCX 抽纯文本，Markdown / 文本文件返回原文。 */
  async readUpload(fileName: string): Promise<{ fileName: string; kind: string; text: string }> {
    const current = this.current();
    if (current === null) throw new Error("还没有简历");
    const safe = sanitizeUploadName(fileName);
    const file = path.join(this.uploadDir(current.id), safe);
    if (!fs.existsSync(file)) {
      throw new Error(`upload/ 里没有「${safe}」。可用 resume_upload_list 查看已上传的文件。`);
    }

    const ext = path.extname(safe).toLowerCase();
    const text = await extractDocumentText(file);
    const kind =
      ext === ".pdf" ? "pdf" : ext === ".docx" ? "docx" : ext === ".md" || ext === ".markdown" ? "markdown" : "text";
    return {
      fileName: safe,
      kind,
      text:
        text.length > READ_TEXT_LIMIT
          ? `${text.slice(0, READ_TEXT_LIMIT)}\n…（内容过长，已截断）`
          : text,
    };
  }

  private current(): ResumeMeta | null {
    return this.doc.items.find((item) => item.id === this.doc.currentId) ?? null;
  }

  private resumeDir(id: string): string {
    return path.join(this.workspace.resumes, id);
  }

  private uploadDir(id: string): string {
    return path.join(this.resumeDir(id), "upload");
  }

  private ensureResumeSubdirs(dir: string): void {
    ensureDir(path.join(dir, "history"));
    ensureDir(path.join(dir, "tailored"));
    ensureDir(path.join(dir, "scripts"));
    ensureDir(path.join(dir, "reports"));
    ensureDir(path.join(dir, "upload"));
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
    this.snapshotInto(path.join(dir, "history"), file, "");
  }

  /** 覆盖定制稿前把旧内容快照进 tailored/history/。 */
  private snapshotTailored(tailoredDir: string, key: string): void {
    const file = path.join(tailoredDir, `${key}.md`);
    if (!fs.existsSync(file)) return;
    this.snapshotInto(path.join(tailoredDir, "history"), file, `${key}-`);
  }

  /** 覆盖话术 / 话术定稿时把当前版快照进 scripts/history/（定稿的版本也留在这里）。 */
  private snapshotScript(scriptsDir: string, key: string): void {
    const file = path.join(scriptsDir, `${key}.md`);
    if (!fs.existsSync(file)) return;
    this.snapshotInto(path.join(scriptsDir, "history"), file, `${key}-`);
  }

  /** 通用快照：copy 进目标目录（时间戳 + 随机后缀防同刻碰撞），超出上限删最旧。 */
  private snapshotInto(historyDir: string, file: string, prefix: string): void {
    ensureDir(historyDir);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    fs.copyFileSync(file, path.join(historyDir, `${prefix}${stamp}-${randomUUID().slice(0, 4)}.md`));

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
      this.ensureResumeSubdirs(dir);
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

/** 定稿指纹：判断「定稿之后有没有又改过」。 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

/**
 * 上传文件名：保留中文/字母/数字/点/连字符/下划线/空格，禁掉路径分隔符、控制字符
 * 和过长的名字；不合法时抛错（上传和工具读取共用同一套规则）。
 */
function sanitizeUploadName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed.length > 200 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f]/.test(trimmed)
  ) {
    throw new Error(`不合法的文件名：${name}`);
  }
  return trimmed;
}

/** 同名不覆盖：目录里已有 a.pdf 时，第二次落盘变成 a-2.pdf、第三次 a-3.pdf。 */
function dedupeFileName(dir: string, fileName: string): string {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName;
  const ext = path.extname(fileName);
  const base = ext === "" ? fileName : fileName.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** 上传文件 → 抽纯文本。PDF 用 unpdf，DOCX 用 mammoth，其余按 UTF-8 文本读。 */
async function extractDocumentText(filePath: string): Promise<string> {
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
