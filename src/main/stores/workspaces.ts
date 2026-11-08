import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { WorkspaceInfo, WorkspacesState } from "@shared/types";

import {
  createRootPaths,
  ensureDir,
  ensureWorkspaceDirs,
  workspacePaths,
  writeJsonFile,
  type RootPaths,
  type WorkspacePaths,
} from "../workspace/paths";

const VERSION = 1;
const DEFAULT_NAME = "默认工作区";

interface WorkspacesDoc {
  version: number;
  /** 当前工作区 id；索引里至少有一项，所以读出来不为空。 */
  currentId: string | null;
  items: WorkspaceInfo[];
}

/**
 * 工作区索引（`~/.goodjob/workspaces.json`）。目录名永远用 ID，人类可读的名字只存在索引里，
 * 这样改名不需要动磁盘。
 */
export class WorkspacesStore {
  readonly root: RootPaths;
  private doc: WorkspacesDoc;

  constructor() {
    this.root = createRootPaths();
    this.doc = this.read();
    this.bootstrap();
  }

  get current(): WorkspaceInfo {
    const current = this.doc.items.find((item) => item.id === this.doc.currentId);
    // bootstrap() 保证有且只有一个可用项，这里是防御性的兜底。
    return current ?? this.doc.items[0] ?? this.createWorkspace(DEFAULT_NAME);
  }

  /** 当前工作区的目录布局（conversations / resumes / cache / logs）。 */
  get currentPaths(): WorkspacePaths {
    return workspacePaths(this.root.root, this.current.id);
  }

  state(): WorkspacesState {
    return { items: this.doc.items, currentId: this.current.id };
  }

  switchTo(id: string): WorkspacesState {
    const target = this.doc.items.find((item) => item.id === id);
    if (target === undefined) throw new Error(`工作区不存在：${id}`);

    // 索引可能存在、目录却被手动删掉了：切过去先补回骨架。
    ensureWorkspaceDirs(workspacePaths(this.root.root, target.id));

    this.doc.currentId = target.id;
    this.persist();
    return this.state();
  }

  /**
   * 首次启动（或索引丢失）时补一个默认工作区；顺手把旧版本直接放在根目录的数据搬进来，
   * 免得升级后用户看到"配置全空了"。
   */
  private bootstrap(): void {
    const usable = this.doc.items.filter((item) => item.id.trim() !== "");
    if (usable.length === 0) {
      const created = this.createWorkspace(DEFAULT_NAME);
      this.doc = { version: VERSION, currentId: created.id, items: [created] };
      const paths = workspacePaths(this.root.root, created.id);
      ensureWorkspaceDirs(paths);
      this.migrateLegacyRoot(paths);
      this.migrateGlobalSettings(paths);
      this.persist();
      return;
    }

    this.doc.items = usable;
    const currentId = this.doc.currentId;
    if (currentId === null || !usable.some((item) => item.id === currentId)) {
      this.doc.currentId = usable[0]?.id ?? null;
    }
    for (const item of usable) {
      ensureWorkspaceDirs(workspacePaths(this.root.root, item.id));
    }
    // 设置改存根目录后：把当前工作区里的旧副本搬到根目录（见 migrateGlobalSettings）。
    this.migrateGlobalSettings(this.currentPaths);
    this.persist();
  }

  /** 旧版本把 conversations / cache / logs 直接放在 ~/.goodjob 下，迁移进默认工作区。 */
  private migrateLegacyRoot(target: WorkspacePaths): void {
    for (const name of ["conversations", "cache", "logs"] as const) {
      const legacyDir = path.join(this.root.root, name);
      if (!fs.existsSync(legacyDir)) continue;
      for (const entry of fs.readdirSync(legacyDir)) {
        const from = path.join(legacyDir, entry);
        const to = path.join(target[name], entry);
        if (fs.existsSync(to)) continue;
        fs.renameSync(from, to);
      }
      // 只删空目录，防止误删用户仍主动放在那里的东西。
      if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
    }
  }

  /**
   * 设置全部改为机器级：模型 / 通知 / 浏览器曾经存在 `<workspace>/` 里，
   * 升级后把它们搬到根目录（根目录没有、工作区里有才搬，不覆盖已有设置）。
   */
  private migrateGlobalSettings(from: WorkspacePaths): void {
    const pairs: { legacy: string; target: string }[] = [
      { legacy: "models.json", target: this.root.models },
      { legacy: "notifications.json", target: this.root.notifications },
      { legacy: "agent-browser.json", target: this.root.agentBrowser },
      { legacy: "browser-playbooks.md", target: this.root.browserPlaybooks },
    ];
    for (const { legacy, target } of pairs) {
      const source = path.join(from.dir, legacy);
      if (!fs.existsSync(source) || fs.existsSync(target)) continue;
      fs.renameSync(source, target);
    }
  }

  private createWorkspace(name: string): WorkspaceInfo {
    // 目录名只用 ID：名字可以改，ID 不会变。
    const id = `ws_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    ensureDir(path.join(this.root.workspaces, id));
    return { id, name, createdAt: new Date().toISOString() };
  }

  private persist(): void {
    writeJsonFile(this.root.index, this.doc);
  }

  private read(): WorkspacesDoc {
    try {
      const raw = fs.readFileSync(this.root.index, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const record = isRecord(parsed) ? parsed : {};

      const items: WorkspaceInfo[] = [];
      if (Array.isArray(record.items)) {
        for (const entry of record.items) {
          if (!isRecord(entry)) continue;
          const id = typeof entry.id === "string" ? entry.id.trim() : "";
          if (id === "" || items.some((item) => item.id === id)) continue;
          items.push({
            id,
            name: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name : id,
            createdAt:
              typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
          });
        }
      }

      return {
        version: VERSION,
        currentId: typeof record.currentId === "string" ? record.currentId : null,
        items,
      };
    } catch {
      return { version: VERSION, currentId: null, items: [] };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
