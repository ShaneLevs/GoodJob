import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { nativeImage } from "electron";

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
} from "@shared/types";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "./paths";
import { RESUME_STARTER } from "./resume-format";

/** history/ 里最多保留的快照份数，超出删最旧的。 */
const HISTORY_LIMIT = 50;
/** 证件照原图上限；超过就不往渲染层送，避免一次 IPC 塞进几十 MB。 */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
/** 预览 / 导出用的人像宽度：320px 足够 96px 的排版尺寸，PDF 也不会糊。 */
const PHOTO_RENDER_WIDTH = 320;

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
    this.writeMainFile(dir, RESUME_STARTER);

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

  /**
   * `photo:` 指令指向的证件照 → data URL（预览与 PDF 导出共用）。
   * 只接受当前简历 `upload/` 下的 png / jpg / jpeg：realpath 校验防越界，
   * main 侧缩到 320px，渲染层只拿到小图，不需要为它开自定义协议。
   */
  readPhotoDataUrl(relPath: string): string | null {
    const current = this.current();
    if (current === null) return null;

    const normalized = relPath.trim().replace(/\\/g, "/");
    if (!normalized.startsWith("upload/")) return null;

    const uploadDir = this.uploadDir(current.id);
    const resolved = path.resolve(this.resumeDir(current.id), normalized);
    if (!resolved.startsWith(`${uploadDir}${path.sep}`)) return null;

    let realResumeDir: string;
    let realUpload: string;
    let realFile: string;
    try {
      realResumeDir = fs.realpathSync(this.resumeDir(current.id));
      realUpload = fs.realpathSync(uploadDir);
      realFile = fs.realpathSync(resolved);
    } catch {
      return null;
    }
    if (!realUpload.startsWith(`${realResumeDir}${path.sep}`)) return null;
    if (!realFile.startsWith(`${realUpload}${path.sep}`)) return null;

    const ext = path.extname(realFile).toLowerCase();
    if (ext !== ".png" && ext !== ".jpg" && ext !== ".jpeg") return null;

    try {
      const stat = fs.statSync(realFile);
      if (!stat.isFile() || stat.size > MAX_PHOTO_BYTES) return null;
    } catch {
      return null;
    }

    const image = nativeImage.createFromPath(realFile);
    if (image.isEmpty()) return null;
    const scaled =
      image.getSize().width > PHOTO_RENDER_WIDTH
        ? image.resize({ width: PHOTO_RENDER_WIDTH, quality: "good" })
        : image;
    const isPng = ext === ".png";
    const bytes = isPng ? scaled.toPNG() : scaled.toJPEG(85);
    return `data:image/${isPng ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
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

  private current(): ResumeMeta | null {
    return this.doc.items.find((item) => item.id === this.doc.currentId) ?? null;
  }

  private resumeDir(id: string): string {
    return path.join(this.workspace.resumes, id);
  }

  private uploadDir(id: string): string {
    return path.join(this.resumeDir(id), "upload");
  }

  /** 简历会话的上传落点（`uploads.ts` 的 `uploadDirFor("resume")` 也走这里）。 */
  currentUploadDir(): string | null {
    const current = this.current();
    return current === null ? null : this.uploadDir(current.id);
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
      this.writeMainFile(dir, RESUME_STARTER);
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

