import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDir, writeJsonFile, type WorkspacePaths } from "../workspace/paths";


/** 实体集合目录（路径先在 paths.ts 的 WorkspacePaths 登记过；interviews 由 stores/domain/interviews 复用）。 */
type CollectionDir = "companies" | "jobs" | "applications" | "interviews";

/**
 * 集合写入监听：装配时由 main/app/context 注册一次，广播给渲染层。
 * 放在模块级而不是构造参数里，是因为 interviews 等 store 自己 new 底层集合，
 * 逐个改构造签名只会让调用方到处传回调。
 */
let collectionChangeListener: ((dir: CollectionDir) => void) | null = null;

export function onCollectionChanged(listener: ((dir: CollectionDir) => void) | null): void {
  collectionChangeListener = listener;
}

function notifyChanged(dir: CollectionDir): void {
  try {
    collectionChangeListener?.(dir);
  } catch {
    // 通知失败不影响这次写入本身。
  }
}

/** ID 惯例：前缀 + 12 位 hex（对齐 resume 的 `rs_` / workspace 的 `ws_`）。 */
export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * JSON 集合通用底座：子类（三个薄 store）负责字段校验与默认值，
 * 这里只管「一个 id 一个文件」的读写、内存缓存与工作区切换。
 * 导出给 stores/domain/interviews（P3）复用——同样是一个实体一个 JSON 文件的集合。
 */
export class JsonCollectionStore<T extends { id: string; createdAt: string }> {
  private workspace: WorkspacePaths;
  private readonly items = new Map<string, T>();

  constructor(
    workspace: WorkspacePaths,
    private readonly dir: CollectionDir,
    private readonly idPrefix: string,
    private readonly revive: (raw: unknown, file: string) => T | null,
  ) {
    this.workspace = workspace;
    this.reload();
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
    this.reload();
  }

  /** 创建时间稳定排序（渲染层要怎么排自己再排，这里只给一个确定性的顺序）。 */
  list(): T[] {
    return [...this.items.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  get(id: string): T | null {
    return this.items.get(id) ?? null;
  }

  /** 写入（或覆盖）一个实体：内存 + 磁盘（0600）。 */
  put(entity: T): void {
    this.items.set(entity.id, entity);
    writeJsonFile(this.fileFor(entity.id), entity);
    notifyChanged(this.dir);
  }

  remove(id: string): boolean {
    if (!this.items.delete(id)) return false;
    try {
      fs.rmSync(this.fileFor(id), { force: true });
    } catch {
      // 文件已被手动删掉之类：内存才是事实，忽略磁盘错误。
    }
    notifyChanged(this.dir);
    return true;
  }

  private fileFor(id: string): string {
    return path.join(this.workspace[this.dir], `${id}.json`);
  }

  /** 只认本集合 id 惯例的文件：applications/ 里的 pipeline.json 等同名文件不会被误读。 */
  private reload(): void {
    this.items.clear();
    const dir = this.workspace[this.dir];
    ensureDir(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pattern = new RegExp(`^${this.idPrefix}[0-9a-f]{12}\\.json$`);
    for (const entry of entries) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        const entity = this.revive(raw, entry.name);
        if (entity !== null) this.items.set(entity.id, entity);
      } catch {
        // 单个坏文件不拖垮整个集合：跳过它，其余实体照常可用。
      }
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
