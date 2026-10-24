import fs from "node:fs";

import type { WorkspacePaths } from "./paths";

/**
 * 工作区级长期记忆（`<workspace>/memory.md`）：Agent 每次会话自动读到 instructions 里，
 * 也通过 memory 工具主动更新。内容是自由 Markdown——约定、偏好、口径，由 Agent 自己维护。
 */
export class MemoryStore {
  private workspace: WorkspacePaths;

  constructor(workspace: WorkspacePaths) {
    this.workspace = workspace;
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.workspace = workspace;
  }

  read(): string {
    try {
      return fs.readFileSync(this.workspace.memory, "utf8");
    } catch {
      return "";
    }
  }

  write(content: string): void {
    fs.writeFileSync(this.workspace.memory, content, { mode: 0o600 });
    fs.chmodSync(this.workspace.memory, 0o600);
  }
}
