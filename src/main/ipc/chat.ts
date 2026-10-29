import { dialog, ipcMain } from "electron";

import {
  IPC,
  conversationScope,
  isConversationScope,
  type ChatSendPayload,
  type ConversationKey,
  type ConversationScope,
  type WireMessage,
} from "@shared/types";

import { readUploadImageDataUrl, saveUploadFile, uploadDirFor } from "../workspace/uploads";
import type { IpcDeps, SendToUi } from "./deps";

/** 对话里的图片缩略图宽度：气泡内只显示 32px，320px 在高分屏上也不糊。 */
const UPLOAD_PREVIEW_WIDTH = 320;

export function registerChatIpc(deps: IpcDeps, sendToUi: SendToUi): void {
  const { getWindow, runtime, conversations, resumes, workspaces } = deps;

  ipcMain.handle(IPC.chatSend, async (_event, payload: ChatSendPayload) => {
    // Fire and forget：chunk 流走 IPC.chatChunk，UI 保持响应。
    void runtime.send(payload, (event) => sendToUi(IPC.chatChunk, event));
  });
  ipcMain.on(IPC.chatAbort, (_event, key: ConversationKey, runId?: string) =>
    runtime.abort(key, runId),
  );
  ipcMain.handle(IPC.chatContext, (_event, key: ConversationKey) => runtime.context(key));
  ipcMain.handle(IPC.chatCompact, (_event, key: ConversationKey) => runtime.compact(key));

  ipcMain.handle(IPC.conversationsGet, (_event, key: ConversationKey) => {
    const doc = conversations.get(key);
    return {
      key,
      messages: doc.messages,
      title: doc.title,
      updatedAt: doc.updatedAt,
      workspaceId: workspaces.currentPaths.id,
    };
  });
  ipcMain.handle(IPC.conversationsList, (_event, scope: ConversationScope) => {
    if (!isConversationScope(scope)) return [];
    return conversations.list(scope);
  });
  ipcMain.handle(IPC.conversationsCreate, (_event, scope: ConversationScope) => {
    if (!isConversationScope(scope)) throw new Error(`未知的会话场景：${String(scope)}`);
    return conversations.create(scope);
  });
  ipcMain.handle(IPC.conversationsRemove, (_event, key: ConversationKey) => {
    if (!isConversationScope(conversationScope(key))) return;
    // 先停掉正在跑的 run，避免删除后还有 chunk / 收尾写入把文件补回来。
    runtime.abort(key);
    conversations.remove(key);
  });
  // 写入带工作区校验：页面卸载时的收尾写入可能晚于「切换工作区」发生，那时绝不能
  // 把上一个工作区的消息写进新工作区。id 对不上就静默丢弃。
  ipcMain.handle(
    IPC.conversationsSync,
    (_event, key: ConversationKey, messages: WireMessage[], workspaceId?: string) => {
      if (workspaceId !== undefined && workspaceId !== workspaces.currentPaths.id) return;
      conversations.updateMessages(key, messages);
    },
  );

  // 上传 = 原样落盘到当前会话所属模块的 upload/（公司 / 岗位 / 投递 / 面试各自己的，
  // 简历落当前简历文件夹），不做任何解析；内容由 Agent 用 upload_list / upload_read
  // 工具按需读取。
  ipcMain.handle(IPC.chatUpload, async (_event, key: ConversationKey) => {
    const win = getWindow();
    const options = {
      title: "上传参考文件或图片",
      filters: [
        {
          name: "文档与图片",
          extensions: ["pdf", "docx", "md", "markdown", "txt", "csv", "png", "jpg", "jpeg"],
        },
        { name: "图片", extensions: ["png", "jpg", "jpeg"] },
        { name: "文档", extensions: ["pdf", "docx", "md", "markdown", "txt", "csv"] },
      ],
      properties: ["openFile" as const, "multiSelections" as const],
    };
    const picked =
      win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const dir = uploadDirFor(workspaces.currentPaths, key, resumes.currentUploadDir());
    return picked.filePaths.map((filePath) => saveUploadFile(dir, filePath));
  });

  // 对话里已发出的图片缩略图：只读当前会话 upload/ 内的 png / jpg / jpeg，
  // main 缩到 320px 再给 data URL，渲染层不需要文件系统权限。
  ipcMain.handle(IPC.chatUploadPreview, (_event, key: ConversationKey, fileName: string) => {
    const dir = uploadDirFor(workspaces.currentPaths, key, resumes.currentUploadDir());
    return readUploadImageDataUrl(dir, fileName, UPLOAD_PREVIEW_WIDTH);
  });
}
