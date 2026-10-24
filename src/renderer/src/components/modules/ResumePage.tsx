import { useCallback } from "react";

import type { UIMessage } from "ai";

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
 * 上传旧简历（输入框左下角「+」）解析后注入会话，由 Agent 整理写入。
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

  const importOldResume = useCallback(async (): Promise<string | null> => {
    const imported = await window.goodjob.resume.importFile();
    if (imported === null) return null;
    return (
      `我上传了旧简历「${imported.fileName}」，下面是抽出的文本。` +
      `请把它整理成一份完整的简历写入 resume.md（信息缺失处留空并提醒我补齐，不要编造）：\n\n` +
      `【简历原文开始】\n${imported.text}\n【简历原文结束】`
    );
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
            emptyDescription="用左下角「+」上传旧简历让它整理，或直接让它按模板补全；你在右边改的内容它下次读得到。"
            placeholder="例如：帮我润色项目经历的描述，突出量化结果"
            {...props}
            onSend={chat.send}
            onStop={chat.stop}
            onImportFile={importOldResume}
          />
        </div>
      </ResizablePanel>
      {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={EDITOR_MIN_WIDTH} defaultSize="55%">
        <ResumeEditorCard />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
