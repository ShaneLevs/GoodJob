import { useCallback } from "react";

import type { UIMessage } from "ai";
import type { UploadedFileMeta } from "@shared/types";

import { useConversationInitial, useModuleChat } from "@/components/chat/use-module-chat";
import { ChatPanel } from "@/components/ChatPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { ModuleLoadingCard, type ModulePageProps } from "./module-page";
import { ResumeEditorCard } from "./ResumeEditorCard";

const CHAT_MIN_WIDTH = 380;
const EDITOR_MIN_WIDTH = 380;

/**
 * 「简历」模块页：左边是带简历上下文的会话（Agent 有文件工具），
 * 右边是即时渲染编辑器——两者共编同一份 resume.md。
 * 上传（输入框左下角「+」）只是把文件存进当前简历文件夹的 upload/，
 * 内容由 Agent 自己用工具读取整理，不往消息里塞全文。
 */
export function ResumePage(props: ModulePageProps) {
  const initial = useConversationInitial("resume");
  if (initial === null) return <ModuleLoadingCard />;
  return <ResumePageLoaded initialMessages={initial} {...props} />;
}

function ResumePageLoaded({
  initialMessages,
  ...props
}: ModulePageProps & { initialMessages: UIMessage[] }) {
  const chat = useModuleChat("resume", initialMessages);

  const uploadReferenceFile = useCallback(async (): Promise<UploadedFileMeta[] | null> => {
    // main 侧完成选择框 + 落盘到 resumes/<当前>/upload/；取消返回 null。
    return window.goodjob.resume.upload();
  }, []);

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="45%">
        <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
          <ChatPanel
            messages={chat.messages}
            status={chat.status}
            errorText={chat.errorText}
            emptyTitle="和 Agent 一起打磨你的简历"
            emptyDescription="用左下角「+」上传旧简历或参考文件，Agent 会自己读取整理；你在右边改的内容它下次读得到。"
            placeholder="例如：帮我润色项目经历的描述，突出量化结果"
            {...props}
            onSend={chat.send}
            onStop={chat.stop}
            onApprovalResponse={chat.respondApproval}
            onUploadFile={uploadReferenceFile}
          />
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={EDITOR_MIN_WIDTH} defaultSize="55%">
        <ResumeEditorCard
          target={{ kind: "main" }}
          emptyText="简历还是空的：在左边对话里上传旧简历、或直接描述你的经历，Agent 整理写入后就能在这里看到排版效果。"
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
