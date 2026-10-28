import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { Check, CircleAlert, Copy, MessageCircleDashed } from "lucide-react";

import type { ChatStatus, UIMessage } from "ai";
import type {
  ConversationKey,
  ModelSelection,
  ModelsConfig,
  ReasoningEffort,
  UploadedFileMeta,
} from "@shared/types";

import { Bubble, BubbleContent } from "@/components/ui/ai-elements/bubble";
import { Message, MessageContent, MessageFooter } from "@/components/ui/ai-elements/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/ai-elements/message-scroller";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatDuration } from "@/lib/format";

import { AssistantMarkdown } from "./AssistantMarkdown";
import { ApprovalCard, isBrowserWriteTool } from "./ApprovalCard";
import { Composer } from "./Composer";
import { groupTraceParts, WorkBlock, type ToolPartView } from "./ToolTrace";
import { UploadAttachment } from "./UploadAttachment";

interface ChatPanelProps {
  messages: UIMessage[];
  status: ChatStatus;
  errorText: string | null;
  models: ModelsConfig | null;
  onSend: (text: string, uploads: UploadedFileMeta[], effort: ReasoningEffort) => void;
  onStop: () => void;
  onSelectModel: (selection: ModelSelection) => void;
  /** 模型下拉里的「模型设置」跳转。 */
  onOpenModelSettings: () => void;
  /** 下拉浮层打开时，原生浏览器视图要让位。 */
  onOverlayChange: (open: boolean) => void;
  /** 各模块的空状态文案。 */
  emptyTitle?: string;
  emptyDescription?: string;
  placeholder?: string;
  /**
   * 是否显示「+」上传：默认显示（文件落这个会话所属模块的 upload/，Agent 用
   * upload_list / upload_read 读）。模拟面试不发这些工具，那边传 false。
   */
  allowUpload?: boolean;
  /**
   * 工具审批（P3 M3）：「等待批准」的工具在上面的卡片上给批准 / 拒绝按钮，回填后自动续跑。
   * 不传时等待态只显示状态、不给按钮。
   */
  onApprovalResponse?: (approvalId: string, approved: boolean) => void;
  /** 批准浏览器写动作时把浏览器面板打开，让用户看得见 Agent 在点什么。 */
  onOpenBrowser?: () => void;
  /** 会话 key：用来查上下文用量（用量只在 main 算，界面只展示 / 触发压缩）。 */
  conversationKey?: ConversationKey;
}

/** `data-upload` part 的宽松视图（UploadedFileMeta 的线上形态）。 */
interface UploadPartView {
  type: "data-upload";
  data: UploadedFileMeta;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function uploadParts(message: UIMessage): UploadedFileMeta[] {
  return message.parts
    .filter((part) => (part as { type?: string } | undefined)?.type === "data-upload")
    .map((part) => (part as unknown as UploadPartView).data);
}

/** run 结束时由 useModuleChat 写进 metadata 的本轮耗时；旧消息没有就是 null。 */
function durationOf(message: UIMessage): number | null {
  const metadata = message.metadata as { durationMs?: unknown } | undefined;
  return typeof metadata?.durationMs === "number" ? metadata.durationMs : null;
}

/** 消息流里的系统事件行（居中细分隔线），与用户 / 助手消息区分开。 */
function CompactNoticeRow() {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 py-0.5 text-xs text-muted-foreground"
    >
      <span className="h-px w-10 bg-border" />
      <span>上下文已压缩</span>
      <span className="h-px w-10 bg-border" />
    </div>
  );
}

/** busy 期间逐秒走的计数器：等首字节的空窗里给用户一个「还在动」的凭据。 */
function useBusySeconds(busy: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!busy) {
      setSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setSeconds(Math.round((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [busy]);
  return seconds;
}

export function ChatPanel({
  messages,
  status,
  errorText,
  models,
  onSend,
  onStop,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  emptyTitle = "今天想找什么样的工作？",
  emptyDescription = "说说你的目标岗位、城市和年限，我来帮你梳理。",
  placeholder = "说说你想找什么岗位，或者直接问我",
  allowUpload = true,
  onApprovalResponse,
  onOpenBrowser,
  conversationKey,
}: ChatPanelProps) {
  const busy = status === "submitted" || status === "streaming";

  // 手动压缩成功后，在消息流里留一条界面级系统提示（不进会话、不进模型上下文）。
  // at 记录压缩时的消息条数，后续新消息会排在提示之后。
  const [compactNotices, setCompactNotices] = useState<Array<{ id: string; at: number }>>([]);
  const compactNoticeSeq = useRef(0);
  const handleCompacted = useCallback(() => {
    compactNoticeSeq.current += 1;
    setCompactNotices((prev) => [
      ...prev,
      { id: `compact-${Date.now()}-${compactNoticeSeq.current}`, at: messages.length },
    ]);
  }, [messages.length]);
  const renderNotices = (at: number) =>
    compactNotices
      .filter((notice) => notice.at === at)
      .map((notice) => <CompactNoticeRow key={notice.id} />);

  // 发出后到首段文本出现前的空窗：流光占位，否则用户不知道 Agent 是否在动。
  const lastMessage = messages.at(-1);
  const lastHasText =
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.parts.some((part) => part.type === "text" && part.text.trim() !== "");
  // 只有「既没正文、也没思考内容」才是真的空窗：思考型模型在思考时已经有区块可看。
  const lastHasReasoning =
    lastMessage !== undefined &&
    lastMessage.role === "assistant" &&
    lastMessage.parts.some((part) => part.type === "reasoning" && part.text.trim() !== "");
  const waiting = busy && !lastHasText && !lastHasReasoning;
  const busySeconds = useBusySeconds(busy);

  const empty = messages.length === 0;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-card">
      {/*
        autoScroll 是必须的，不是可选装饰：消息行带 content-visibility:auto，
        markdown / 代码块 / 图片是挂载后才撑高的，打开会话那一刻算出来的
        scrollHeight 偏小，默认的「滚到底」落地后内容继续变高，就会停在离底部
        差一截的位置（真实会话实测差 173px，之后再也不动）。开着 autoScroll
        时，只有读者停在底部才跟着长，往上翻就自动退出跟随——不会抢滚动。
      */}
      <MessageScrollerProvider autoScroll>
        {empty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
            <Empty className="max-w-md">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashed />
                </EmptyMedia>
                <EmptyTitle>{emptyTitle}</EmptyTitle>
                <EmptyDescription>{emptyDescription}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-5 py-5">
                {renderNotices(0)}
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;

                  if (message.role === "user") {
                    const uploads = uploadParts(message);
                    const text = messageText(message);
                    return (
                      <Fragment key={message.id}>
                        <MessageScrollerItem scrollAnchor>
                          <Message align="end">
                            <MessageContent>
                              {text !== "" && (
                                <Bubble align="end" variant="muted">
                                  <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
                                </Bubble>
                              )}
                              {uploads.map((file, partIndex) => (
                                <UploadAttachment
                                  key={`${file.fileName}-${partIndex}`}
                                  file={file}
                                  conversationKey={conversationKey}
                                />
                              ))}
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                        {renderNotices(index + 1)}
                      </Fragment>
                    );
                  }

                  const duration = durationOf(message);
                  const fullText = messageText(message);
                  const streaming = isLast && busy;
                  // 只把「消息里最后一个 part」当作还在流：它前面出现正文 / 工具调用，
                  // 就说明那段思考已经结束，不能再跟着整轮 busy 一直显示「思考中」。
                  const tailPart = message.parts[message.parts.length - 1];
                  const groups = groupTraceParts(message.parts);
                  // 等待批准的工具不进思维链：它们是「等你回答的问题」，不是活动。
                  const pendingParts = message.parts.filter((part) => {
                    const view = part as unknown as ToolPartView;
                    return (
                      view.type.startsWith("tool-") &&
                      view.state === "approval-requested" &&
                      view.approval !== undefined &&
                      view.approval.isAutomatic !== true
                    );
                  }) as unknown as ToolPartView[];
                  // 最后一块正文是这轮的答复（留在外面），它前面的思考 / 工具 / 中间正文
                  // 全部打包进「工作过程」。
                  const last = groups[groups.length - 1];
                  const answer = last !== undefined && last.kind === "text" ? last : null;
                  const work = answer === null ? groups : groups.slice(0, -1);
                  // 等批准的这轮不算「完成」：不显示耗时 / 复制页脚，免得读成已经收尾。
                  const showFooter =
                    !(isLast && busy) &&
                    pendingParts.length === 0 &&
                    (duration !== null || fullText !== "");

                  return (
                    <Fragment key={message.id}>
                      <MessageScrollerItem>
                        <Message>
                          <MessageContent className="gap-3">
                            {work.length > 0 && (
                              <WorkBlock
                                groups={work}
                                streaming={streaming}
                                pending={pendingParts.length > 0}
                                tailPart={tailPart}
                                elapsedMs={streaming ? busySeconds * 1000 : duration}
                              />
                            )}

                            {pendingParts.map((part) => {
                              const name = part.type.slice("tool-".length);
                              const approval = part.approval!;
                              return (
                                <ApprovalCard
                                  key={approval.id}
                                  toolName={name}
                                  input={part.input}
                                  requestReason={approval.requestReason}
                                  onRespond={(approved) => {
                                    // 先开面板再回填：用户才能看见接下来那一下点在哪。
                                    if (approved && isBrowserWriteTool(name)) onOpenBrowser?.();
                                    onApprovalResponse?.(approval.id, approved);
                                  }}
                                />
                              );
                            })}

                            {answer !== null && (
                              <AssistantMarkdown streaming={isLast && status === "streaming"}>
                                {answer.part.text}
                              </AssistantMarkdown>
                            )}

                            {showFooter && (
                              <MessageFooter className="gap-1 px-0">
                                {duration !== null && work.length === 0 && (
                                  <span className="tabular-nums">耗时 {formatDuration(duration)}</span>
                                )}
                                <CopyButton text={fullText} />
                              </MessageFooter>
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                      {renderNotices(index + 1)}
                    </Fragment>
                  );
                })}

                {waiting && (
                  <div className="flex items-baseline gap-2 text-sm text-muted-foreground">
                    <span className="shimmer">正在思考…</span>
                    {busySeconds >= 3 && (
                      <span className="text-xs tabular-nums text-muted-foreground/70">
                        {busySeconds}s
                        {busySeconds >= 30 ? "（网关迟迟不回数据，90 秒没动静会自动中断）" : ""}
                      </span>
                    )}
                  </div>
                )}

                {status === "error" && errorText !== null && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    <span className="whitespace-pre-wrap">{errorText}</span>
                  </div>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        )}
      </MessageScrollerProvider>

      <div className="px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">
          <Composer
            models={models}
            busy={busy}
            allowUpload={allowUpload}
            conversationKey={conversationKey}
            placeholder={placeholder}
            onSend={onSend}
            onStop={onStop}
            onSelectModel={onSelectModel}
            onOpenModelSettings={onOpenModelSettings}
            onOverlayChange={onOverlayChange}
            onCompacted={handleCompacted}
          />
        </div>
      </div>
    </div>
  );
}

/** 复制整条回复的 Markdown 原文，成功后图标换成对勾两秒。 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      aria-label={copied ? "已复制" : "复制"}
      onClick={() => {
        const clipboard = navigator.clipboard;
        if (clipboard === undefined) return;
        void clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
