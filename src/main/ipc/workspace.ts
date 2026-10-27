import { ipcMain } from "electron";

import { IPC } from "@shared/types";

import type { IpcDeps, SendToUi } from "./deps";

export function registerWorkspaceIpc(deps: IpcDeps, sendToUi: SendToUi): void {
  const {
    runtime,
    browser,
    tasks,
    notify,
    workspaces,
    models,
    conversations,
    resumes,
    memory,
    companies,
    jobs,
    applications,
    pipeline,
    interviews,
    notifyStore,
    browserSettings,
  } = deps;

  ipcMain.handle(IPC.workspaceGet, () => workspaces.state());
  ipcMain.handle(IPC.workspaceSwitch, (_event, id: string) => {
    runtime.abortAll();
    // 浏览器任务跟着停：tab 锁与审计缓冲都随工作区清掉（日志文件留在原工作区）。
    browser.onWorkspaceSwitch();
    // 后台任务也停掉：注册表只在内存里，结果都在各工作区的实体文件里。
    tasks.stopAll();
    // 通知服务跟着换工作区：停掉调度与 IMAP 长连接（等待中的确认门按取消处理），
    // stores/notify 换文件重读——服务持引用，自动看到新工作区的配置。
    notify.stopAll();
    const state = workspaces.switchTo(id);
    // 一切数据跟着工作区走：切完换文件重读，并广播给渲染层刷新。
    const paths = workspaces.currentPaths;
    models.useWorkspace(paths);
    conversations.useWorkspace(paths);
    resumes.useWorkspace(paths);
    memory.useWorkspace(paths);
    companies.useWorkspace(paths);
    jobs.useWorkspace(paths);
    applications.useWorkspace(paths);
    pipeline.useWorkspace(paths);
    interviews.useWorkspace(paths);
    notifyStore.useWorkspace(paths);
    browserSettings.useWorkspace(paths);
    // 通知调度随新工作区继续跑（stopAll 清掉了 ticker）。
    notify.start();
    sendToUi(IPC.workspaceChanged, state);
    return state;
  });
}
