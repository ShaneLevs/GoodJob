import { ChatPanel } from "@/components/chat/ChatPanel";
import {
  ConversationPane,
  type ConversationControl,
} from "@/components/chat/conversation-pane";
import type { ModuleChat } from "@/components/chat/use-module-chat";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import type { ModulePageProps } from "../shared/module-page";
import { WorkflowPanel } from "./WorkflowPanel";
import { useWorkflow } from "./use-workflow";

const CHAT_MIN_WIDTH = 420;
const WORKFLOW_MIN_WIDTH = 320;

/**
 * 「GoodJob」模块：初始只有对话。它判断任务量，单角色直接派一个子 agent，
 * 多角色 / 有依赖时创建 workflow——这时右侧才出现工作流侧栏（数量、状态、流程图）。
 */
export function OrchestratorPage(props: ModulePageProps) {
  return (
    <ConversationPane scope="orchestrator" onOverlayChange={props.onOverlayChange}>
      {(chat, conversation) => (
        <OrchestratorSession chat={chat} conversation={conversation} {...props} />
      )}
    </ConversationPane>
  );
}

function OrchestratorSession({
  chat,
  conversation,
  ...props
}: ModulePageProps & {
  chat: ModuleChat;
  conversation: ConversationControl;
}) {
  const workflow = useWorkflow(conversation.activeKey);

  const chatPane = (
    <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
      <ChatPanel
        messages={chat.messages}
        status={chat.status}
        errorText={chat.errorText}
        models={props.models}
        emptyTitle="把目标交给 GoodJob"
        emptyDescription="我会先判断这件事该由谁做：一个子 agent 能处理就直接派；需要多人协作或有先后依赖时，拆成工作流并在右侧展示进度。"
        placeholder="例如：把现有岗位按匹配度排个优先级，给前三个岗位各生成一份定制简历"
        onSelectModel={props.onSelectModel}
        onOpenModelSettings={props.onOpenModelSettings}
        onOverlayChange={props.onOverlayChange}
        onOpenBrowser={props.onOpenBrowser}
        onSend={chat.send}
        onStop={chat.stop}
        onApprovalResponse={chat.respondApproval}
        conversationKey={conversation.activeKey}
        conversation={conversation}
      />
    </div>
  );

  if (workflow === null) return chatPane;

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="62%">
        {chatPane}
      </ResizablePanel>
      <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
      <ResizablePanel minSize={WORKFLOW_MIN_WIDTH} defaultSize="38%">
        <WorkflowPanel workflow={workflow} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
