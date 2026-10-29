import { useCallback, useEffect, useState } from "react";

import { ArrowLeft } from "lucide-react";

import type { Company, Job } from "@shared/types";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { ConversationPane } from "@/components/chat/conversation-pane";
import type { ModuleChat } from "@/components/chat/use-module-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import type { ModulePageProps } from "../shared/module-page";
import { useDomainChange } from "../shared/use-domain-change";
import { ResumeEditorCard } from "../shared/ResumeEditorCard";

const CHAT_MIN_WIDTH = 380;
const EDITOR_MIN_WIDTH = 380;

export interface JobWorkbenchPageProps extends ModulePageProps {
  jobId: string;
  /** 进入时自动发给岗位 Agent 的起草指令（生成简历 / 生成话术）；发过即焚。 */
  autoPrompt: string | null;
  onAutoPromptSent: () => void;
  /** 进入时预填进输入框、但不自动发送的提示词（已有简历时点「生成简历」）。 */
  prefillPrompt: string | null;
  onPrefillConsumed: () => void;
  /** 顶部返回岗位表。 */
  onBack: () => void;
}

/**
 * 岗位二级工作台（定制简历）：参数化复用简历页的「Chat | 编辑器」结构。
 * 左边是 `job:<jobId>` 独立会话（上下文 = JD + 锁定该岗位的定制稿/话术工具），
 * 右边编辑器加载 tailored/<jobId>.md（与主简历同一份编辑器卡，含 PDF 导出）。
 * 顶部一条返回栏：岗位标题 / 公司 / 薪资带都来自岗位档案，不重复维护。
 */
export function JobWorkbenchPage({
  jobId,
  autoPrompt,
  onAutoPromptSent,
  prefillPrompt,
  onPrefillConsumed,
  onBack,
  ...props
}: JobWorkbenchPageProps) {
  const [job, setJob] = useState<Job | null>(null);
  const [companyName, setCompanyName] = useState<string | null>(null);

  const reload = useCallback((): void => {
    void window.goodjob.jobs.list().then((jobs) => {
      const found = jobs.find((item) => item.id === jobId) ?? null;
      setJob(found);
      if (found?.companyId == null) {
        setCompanyName(null);
        return;
      }
      void window.goodjob.companies.list().then((companies: Company[]) => {
        setCompanyName(companies.find((item) => item.id === found.companyId)?.name ?? null);
      });
    });
  }, [jobId]);

  useEffect(() => reload(), [reload]);
  // Agent 补关联公司 / 改岗位信息后，标题栏跟着变（这里不做卸载保护：
  // setState 落在已卸载组件上在 React 18+ 是无害的 no-op，reload 的 promise 链更短更好读）。
  useDomainChange(["jobs", "companies"], reload);

  return (
    <div className="flex h-full min-w-0 flex-col gap-2">
      {/* 返回栏铺在窗口底色上（与顶栏同语言），下面才是两块白色卡片。 */}
      <div className="flex h-8 shrink-0 items-center gap-2 px-1">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onBack}>
          <ArrowLeft />
          返回岗位表
        </Button>
        <span className="min-w-0 truncate text-sm font-medium">
          {job?.title ?? "…"}
        </span>
        {companyName !== null && (
          <span className="truncate text-xs text-muted-foreground">{companyName}</span>
        )}
        {job !== null && job.salaryBand !== "" && (
          <Badge variant="secondary">{job.salaryBand}</Badge>
        )}
        {job === null && <span className="text-xs text-warning">岗位可能已被删除（悬空引用）</span>}
      </div>

      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel minSize={CHAT_MIN_WIDTH} defaultSize="45%">
            <div className="h-full overflow-hidden rounded-2xl bg-card shadow-sm">
              <ConversationPane
                scope={`job:${jobId}`}
                onOverlayChange={props.onOverlayChange}
              >
                {(chat, conversation) => (
                  <>
                    <AutoPromptSender
                      chat={chat}
                      prompt={autoPrompt}
                      onSent={onAutoPromptSent}
                    />
                    <ChatPanel
                      messages={chat.messages}
                      status={chat.status}
                      errorText={chat.errorText}
                      models={props.models}
                      emptyTitle="为这个岗位定制简历"
                      emptyDescription="Agent 能看到 JD 和主简历：让它起草、改写、取舍，右边编辑器与它共编同一份定制稿。"
                      placeholder="例如：把项目经历按这个 JD 的要求重新排一下优先级"
                      onSelectModel={props.onSelectModel}
                      onOpenModelSettings={props.onOpenModelSettings}
                      onOverlayChange={props.onOverlayChange}
                      onOpenBrowser={props.onOpenBrowser}
                      onSend={chat.send}
                      onStop={chat.stop}
                      onApprovalResponse={chat.respondApproval}
                      initialDraft={prefillPrompt}
                      onInitialDraftConsumed={onPrefillConsumed}
                      conversationKey={conversation.activeKey}
                      conversation={conversation}
                    />
                  </>
                )}
              </ConversationPane>
            </div>
          </ResizablePanel>
          {/* 8px 间隙里的一条可拖拽细线：既是分隔提示，也是拖拽热区。 */}
          <ResizableHandle className="mx-1 w-1 justify-self-center rounded-full bg-border/60 transition-colors after:hidden hover:bg-border data-[separator]:bg-border/60" />
          <ResizablePanel minSize={EDITOR_MIN_WIDTH} defaultSize="55%">
            <ResumeEditorCard
              target={{ kind: "tailored", name: jobId }}
              emptyText="还没有定制稿：在左边对话里让 Agent 基于 JD 和主简历起草一份，就能在这里看到。"
              exportFileName={job === null ? undefined : `${job.title}-定制简历`}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

/** 进入岗位工作台时的一次性起草指令：发完由父级清掉，切对话不会重复发。 */
function AutoPromptSender({
  chat,
  prompt,
  onSent,
}: {
  chat: ModuleChat;
  prompt: string | null;
  onSent: () => void;
}) {
  const send = chat.send;
  /*
   * 推迟到本轮 effect 之后发：StrictMode 会在挂载 effect 跑完后模拟一次卸载，
   * 那里 useChat 的清理会 stop() 掉刚发出的请求。直接在 effect 里发，起草指令
   * 一定被中止（界面表现为「进了工作台但对话没动静」）。
   * 清理函数同时消掉 StrictMode 重放带来的第二次发送。
   */
  useEffect(() => {
    if (prompt === null) return;
    const timer = window.setTimeout(() => {
      send(prompt, []);
      onSent();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进入时发一次。
  }, [prompt]);
  return null;
}
