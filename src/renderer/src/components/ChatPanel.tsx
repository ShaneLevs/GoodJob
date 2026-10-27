import { useEffect, useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FileText,
  MessageCircleDashed,
  Plus,
  Settings2,
  Square,
  X,
} from "lucide-react";

import type { ChatStatus, UIMessage } from "ai";
import { DEFAULT_REASONING_EFFORT } from "@shared/types";
import type {
  ContextUsage,
  ConversationKey,
  ModelSelection,
  ModelsConfig,
  ReasoningEffort,
  UploadedFileMeta,
} from "@shared/types";

import { useContextUsage } from "./chat/use-context-usage";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Bubble, BubbleContent } from "./ui/bubble";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "./ui/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "./ui/trace";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "./ui/attachment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { Progress } from "./ui/progress";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./ui/input-group";
import { Message, MessageContent, MessageFooter } from "./ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";

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
   * 工具审批（P3 M3）：「等待批准」的工具条上给批准 / 拒绝按钮，回填后自动续跑。
   * 不传时等待态只显示状态、不给按钮。
   */
  onApprovalResponse?: (approvalId: string, approved: boolean) => void;
  /** 会话 key：用来查上下文用量（用量只在 main 算，界面只展示 / 触发压缩）。 */
  conversationKey?: ConversationKey;
}

interface ModelOption {
  key: string;
  label: string;
  context: string | null;
  selection: ModelSelection;
}

interface ModelGroup {
  name: string;
  options: ModelOption[];
}

/** 工具 part 的宽松视图：工具名/状态/输入输出都从这取。 */
interface ToolPartView {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /** 「等待批准」态才有：approval.id 是批准 / 拒绝要回填的凭据。 */
  approval?: {
    id: string;
    requestReason?: string;
    isAutomatic?: boolean;
  };
}

/** `data-upload` part 的宽松视图（UploadedFileMeta 的线上形态）。 */
interface UploadPartView {
  type: "data-upload";
  data: UploadedFileMeta;
}

/** 上下文窗口只用来做个徽标，取整到 K/M。 */
function formatContext(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** 上下文气泡里的数字：0 也要显示成一个 0，不能像模型标签那样省略。 */
function formatTokens(tokens: number): string {
  return tokens <= 0 ? "0" : (formatContext(tokens) ?? "0");
}

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

function effortLabel(effort: ReasoningEffort): string {
  return EFFORT_OPTIONS.find((option) => option.value === effort)?.label ?? "中";
}

/** 用量拆行：和 main 侧 measureMessages 的分类一一对应。 */
function usageRows(usage: ContextUsage): Array<{ label: string; value: number }> {
  return [
    { label: "指令", value: usage.instructions },
    { label: "输入", value: usage.input },
    { label: "输出", value: usage.output },
    { label: "思考", value: usage.reasoning },
  ];
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
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

/**
 * 一次 run 的工作时长，形如「1 分 55 秒」。
 */
function formatWorkDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/**
 * 把一条消息的 parts 切成两种块：正文块，和「思考 + 工具调用」块。
 *
 * reasoning / tool-* 连续出现就合并成一个 Trace（AI Elements 的 chain-of-thought 结构：
 * 一串可展开的步骤行），中间夹着正文时切开——保持流式的真实顺序。
 * 其他 part（step-start / file / data-*）不进渲染。
 */
type TraceGroup =
  | { kind: "text"; key: string; part: { type: "text"; text: string } }
  | { kind: "trace"; key: string; parts: UIMessage["parts"] };

function groupTraceParts(parts: UIMessage["parts"]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let buffer: UIMessage["parts"] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    groups.push({ kind: "trace", key: `trace-${groups.length}`, parts: buffer });
    buffer = [];
  };

  for (const part of parts) {
    if (part.type === "text") {
      flush();
      groups.push({ kind: "text", key: `text-${groups.length}`, part });
      continue;
    }
    if (part.type === "reasoning" || part.type.startsWith("tool-")) {
      buffer.push(part);
    }
  }
  flush();

  return groups;
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
  conversationKey,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [pendingUploads, setPendingUploads] = useState<UploadedFileMeta[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = models?.activeModel ?? null;
  const activeKey = active === null ? null : optionKey(active.providerId, active.modelId);

  /*
   * 只列出「启用的供应商 × 启用的模型」，和 main 里 resolveActive 的可用范围保持一致，
   * 否则下拉里会出现选了也发不出去的模型。
   */
  const groups = useMemo<ModelGroup[]>(() => {
    const result: ModelGroup[] = [];
    for (const provider of models?.providers ?? []) {
      if (!provider.enabled) continue;
      const options = provider.models
        .filter((model) => model.enabled)
        .map((model) => ({
          key: optionKey(provider.id, model.id),
          label: model.name,
          context: formatContext(model.contextWindow),
          selection: { providerId: provider.id, modelId: model.id },
        }));
      if (options.length > 0) result.push({ name: provider.name, options });
    }
    return result;
  }, [models]);

  const hasOptions = groups.length > 0;
  const modelLabel = active === null ? "选择模型" : `${active.providerName}/${active.name}`;
  const busy = status === "submitted" || status === "streaming";
  // 上下文用量：只在 main 算（与自动压缩阈值同一套），这里只管展示与手动压缩。
  const { usage, compact } = useContextUsage(conversationKey ?? null, busy);
  const usagePercent =
    usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const thresholdPercent =
    usage.limit > 0 ? Math.round((usage.threshold / usage.limit) * 100) : 0;
  const canSend = (draft.trim() !== "" || pendingUploads.length > 0) && !busy;

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

  const submit = (): void => {
    if (!canSend) return;
    const text =
      draft.trim() !== ""
        ? draft.trim()
        : `我上传了文件 ${pendingUploads.map((file) => `「${file.fileName}」`).join("、")}，请查看。`;
    onSend(text, pendingUploads, effort);
    setDraft("");
    setPendingUploads([]);
    inputRef.current?.focus();
  };

  // 「+」上传：文件选择与落盘都在 main 侧完成（落这个会话所属模块的 upload/），
  // 这里只把回执挂成待发附件。文件存到哪由 main 的 uploadDirFor 按 key 决定。
  const uploadFiles = (): void => {
    if (!allowUpload || conversationKey === undefined || busy) return;
    setUploadError(null);
    window.goodjob.chat
      .upload(conversationKey)
      .then((uploaded) => {
        if (uploaded !== null) setPendingUploads((prev) => [...prev, ...uploaded]);
      })
      .catch((cause: unknown) => {
        setUploadError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  const empty = messages.length === 0;

  const promptInput = (
    <form
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <InputGroup>
        {pendingUploads.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {pendingUploads.map((file) => (
              <Attachment key={file.fileName} size="sm" className="max-w-60">
                <AttachmentMedia>
                  <FileText />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.fileName}</AttachmentTitle>
                  <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={`移除 ${file.fileName}`}
                    onClick={() =>
                      setPendingUploads((prev) =>
                        prev.filter((item) => item.fileName !== file.fileName),
                      )
                    }
                  >
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          ref={inputRef}
          value={draft}
          placeholder={placeholder}
          className="max-h-48 min-h-16 p-3"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="gap-1.5">
          {allowUpload && conversationKey !== undefined && (
            <InputGroupButton
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label="上传参考文件（PDF / Word / Markdown / 文本）"
              disabled={busy}
              onClick={uploadFiles}
            >
              <Plus />
            </InputGroupButton>
          )}

          {conversationKey !== undefined && usage.limit > 0 && (
            <HoverCard openDelay={10} closeDelay={100} onOpenChange={onOverlayChange}>
              <HoverCardTrigger asChild>
                <InputGroupButton
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-xs text-muted-foreground"
                  aria-label="上下文用量"
                >
                  {usagePercent}%
                </InputGroupButton>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="flex w-64 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">上下文</span>
                  <span className="text-muted-foreground">
                    {formatTokens(usage.used)} / {formatTokens(usage.limit)}
                  </span>
                </div>
                <Progress value={usagePercent} aria-label="上下文用量" />
                <div className="flex flex-col gap-1">
                  {usageRows(usage).map((row) => (
                    <div key={row.label} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span>{formatTokens(row.value)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2">
                  <span className="text-xs text-muted-foreground">
                    到 {thresholdPercent}% 自动压缩
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || usage.used === 0}
                    onClick={() => void compact()}
                  >
                    压缩
                  </Button>
                </div>
              </HoverCardContent>
            </HoverCard>
          )}

          {/* 右侧一组：模型 / 思考等级，统一 `ml-auto` 推到最右。 */}
          <div className="ml-auto flex items-center gap-1">
            <DropdownMenu onOpenChange={onOverlayChange}>
              <DropdownMenuTrigger asChild>
                <InputGroupButton
                  size="sm"
                  variant="ghost"
                  className="max-w-56 text-xs text-muted-foreground"
                  aria-label={`模型：${modelLabel}`}
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {hasOptions ? (
                  <DropdownMenuRadioGroup
                    value={activeKey ?? undefined}
                    onValueChange={(key) => {
                      const option = groups
                        .flatMap((group) => group.options)
                        .find((item) => item.key === key);
                      if (option !== undefined) onSelectModel(option.selection);
                    }}
                  >
                    {groups.map((group, index) => (
                      <div key={group.name}>
                        {index > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="text-xs text-muted-foreground">
                          {group.name}
                        </DropdownMenuLabel>
                        {group.options.map((option) => (
                          <DropdownMenuRadioItem key={option.key} value={option.key}>
                            <span className="truncate">{option.label}</span>
                            {option.context !== null && (
                              <span className="ml-auto pl-2 text-[11px] text-muted-foreground">
                                {option.context}
                              </span>
                            )}
                          </DropdownMenuRadioItem>
                        ))}
                      </div>
                    ))}
                  </DropdownMenuRadioGroup>
                ) : (
                  <div className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
                    还没有可用的模型。
                    <br />
                    先在设置里添加一个供应商，并为它启用至少一个模型。
                  </div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenModelSettings}>
                  <Settings2 />
                  模型设置
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 思考等级：只对勾了「推理」的模型有意义（普通模型传 reasoning_effort 会被中转 400）。 */}
            {active?.reasoning === true && (
              <DropdownMenu onOpenChange={onOverlayChange}>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs text-muted-foreground"
                    aria-label={`思考等级：${effortLabel(effort)}`}
                  >
                    <span>思考 {effortLabel(effort)}</span>
                    <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuRadioGroup
                    value={effort}
                    onValueChange={(value) => setEffort(value as ReasoningEffort)}
                  >
                    {EFFORT_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {busy ? (
            <InputGroupButton
              size="icon-sm"
              variant="secondary"
              aria-label="停止生成"
              onClick={onStop}
            >
              <Square className="size-3.5 fill-current" />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="rounded-full"
              aria-label="发送"
              disabled={!canSend}
            >
              <ArrowUp />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );

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
                {messages.map((message, index) => {
                  const isLast = index === messages.length - 1;

                  if (message.role === "user") {
                    const uploads = uploadParts(message);
                    const text = messageText(message);
                    return (
                      <MessageScrollerItem key={message.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            {text !== "" && (
                              <Bubble align="end" variant="muted">
                                <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
                              </Bubble>
                            )}
                            {uploads.map((file, partIndex) => (
                              <Attachment
                                key={`${file.fileName}-${partIndex}`}
                                size="sm"
                                className="max-w-60"
                              >
                                <AttachmentMedia>
                                  <FileText />
                                </AttachmentMedia>
                                <AttachmentContent>
                                  <AttachmentTitle>{file.fileName}</AttachmentTitle>
                                  <AttachmentDescription>
                                    {formatBytes(file.size)}
                                  </AttachmentDescription>
                                </AttachmentContent>
                              </Attachment>
                            ))}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    );
                  }

                  const duration = durationOf(message);
                  const fullText = messageText(message);
                  const streaming = isLast && busy;
                  // 只把「消息里最后一个 part」当作还在流：它前面出现正文 / 工具调用，
                  // 就说明那段思考已经结束，不能再跟着整轮 busy 一直显示「思考中」。
                  const tailPart = message.parts[message.parts.length - 1];
                  const groups = groupTraceParts(message.parts);
                  // 最后一块正文是这轮的答复（留在外面），它前面的思考 / 工具 / 中间正文
                  // 全部打包进「工作过程」。
                  const last = groups[groups.length - 1];
                  const answer = last !== undefined && last.kind === "text" ? last : null;
                  const work = answer === null ? groups : groups.slice(0, -1);
                  const showFooter = !(isLast && busy) && (duration !== null || fullText !== "");

                  return (
                    <MessageScrollerItem key={message.id}>
                      <Message>
                        <MessageContent className="gap-3">
                          {work.length > 0 && (
                            <WorkBlock
                              groups={work}
                              streaming={streaming}
                              tailPart={tailPart}
                              elapsedMs={
                                streaming
                                  ? busySeconds * 1000
                                  : duration
                              }
                              onRespond={onApprovalResponse}
                            />
                          )}

                          {answer !== null && (
                            <Markdown streaming={isLast && status === "streaming"}>
                              {answer.part.text}
                            </Markdown>
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
          {uploadError !== null && (
            <p className="px-1 pb-1.5 text-xs text-destructive">{uploadError}</p>
          )}
          {promptInput}
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

/**
 * 工具名 → 中文标签。工具是 `<名词>_<动作>` 的 snake_case，这里拆开查两张小表，
 * 新增工具不用改这里；查不到就原样显示。
 */
const TOOL_NOUNS: Record<string, string> = {
  browser: "页面",
  memory: "记忆",
  resume: "简历",
  resume_tailored: "定制稿",
  resume_job: "岗位匹配",
  script: "话术",
  job: "岗位",
  company: "公司",
  application: "投递",
  pipeline: "流水线",
};

const TOOL_VERBS: Record<string, string> = {
  read: "读取",
  list: "查看",
  get: "查看",
  write: "写入",
  create: "新建",
  update: "更新",
  delete: "删除",
  act: "操作",
  submit: "提交",
  evaluate: "评估",
  check: "检查",
  finalize: "定稿",
  advance: "推进",
  info: "查看",
};

/** 名字不按 `<名词>_<动作>` 来的少数几个，单独给标签。 */
const TOOL_SPECIAL: Record<string, string> = {
  upload_list: "查看上传文件",
  upload_read: "读取上传文件",
  notify: "发送通知",
  request_confirmation: "请求确认",
  memory_read: "读取记忆",
  memory_write: "更新记忆",
  browser_read: "读取页面",
  browser_act: "操作页面",
  browser_submit: "提交表单",
};

function toolLabel(name: string): string {
  const special = TOOL_SPECIAL[name];
  if (special !== undefined) return special;
  const segments = name.split("_");
  const verb = segments[segments.length - 1] ?? name;
  const noun = TOOL_NOUNS[segments.slice(0, -1).join("_")];
  const action = TOOL_VERBS[verb];
  return noun !== undefined && action !== undefined ? `${action}${noun}` : name;
}

/** JSON / 字符串统一成一段可复制的文本。 */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * 一轮 run 的「工作过程」：思考 + 工具调用 + 中间正文整段折成一行「已工作 X 分 Y 秒」。
 * 跑的时候默认展开（看得见在动），这轮结束后默认收起；点标题随时展开。
 */
function WorkBlock({
  groups,
  streaming,
  tailPart,
  elapsedMs,
  onRespond,
}: {
  groups: TraceGroup[];
  streaming: boolean;
  tailPart: UIMessage["parts"][number] | undefined;
  elapsedMs: number | null;
  onRespond?: (approvalId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState<boolean>();

  return (
    <TraceCollapsible open={open ?? streaming} onOpenChange={setOpen}>
      <div className="border-b border-border/60 pb-2">
        <TraceCollapsibleTrigger>
          <TraceLine status={streaming ? "running" : undefined}>
            <TraceTitle>
              {elapsedMs === null ? "工作过程" : `已工作 ${formatWorkDuration(elapsedMs)}`}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
      </div>
      <TraceCollapsibleContent>
        <Trace>
          {groups.map((group) =>
            group.kind === "text" ? (
              <Markdown key={group.key} streaming={streaming && group.part === tailPart}>
                {group.part.text}
              </Markdown>
            ) : (
              group.parts.map((part, index) =>
                part.type === "reasoning" ? (
                  <ReasoningRow
                    key={`${group.key}-${index}`}
                    text={part.text}
                    streaming={
                      streaming && part === tailPart && part.state !== "done"
                    }
                  />
                ) : (
                  <ToolRow
                    key={`${group.key}-${index}`}
                    part={part as unknown as ToolPartView}
                    onRespond={onRespond}
                  />
                ),
              )
            ),
          )}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** 思考内容：标题写状态，展开是模型的原始推理文本；无图标，完成后默认收起。 */
function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState<boolean>();

  const line = (
    <TraceLine status={streaming ? "running" : undefined}>
      <TraceTitle>{streaming ? "思考中" : "思考完成"}</TraceTitle>
    </TraceLine>
  );

  if (text.length === 0) return line;

  return (
    <TraceCollapsible open={open ?? streaming} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">
        {text}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** 一条工具调用：标题是「运行 + 中文工具名」，无图标；输入 / 输出 / 错误折在行内。
 *  执行中展开，完成后默认收起。 */
function ToolRow({
  part,
  onRespond,
}: {
  part: ToolPartView;
  onRespond?: (approvalId: string, approved: boolean) => void;
}) {
  const [open, setOpen] = useState<boolean>();
  const name = part.type.slice("tool-".length);
  const label = toolLabel(name);

  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "approval-responded";
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const waiting =
    part.state === "approval-requested" && part.approval !== undefined && !part.approval.isAutomatic;

  const status = failed
    ? ("error" as const)
    : waiting
      ? ("pending" as const)
      : running
        ? ("running" as const)
        : undefined;

  const title = failed
    ? `运行 ${label} 失败`
    : denied
      ? `已拒绝：${label}`
      : waiting
        ? `等待批准：${label}`
        : `运行 ${label}`;

  const errorText = failed ? part.errorText : undefined;
  const hasDetail =
    (part.input !== undefined && part.input !== null) ||
    (part.output !== undefined && part.output !== null) ||
    (errorText !== undefined && errorText !== "");

  const line = (
    <TraceLine status={status}>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {hasDetail ? (
        <TraceCollapsible open={open ?? (running || waiting)} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-xs">
            <ToolDetail
              input={part.input}
              output={part.output}
              errorText={errorText}
            />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}

      {/* 审批动作不收进折叠区：等待批准要一眼可见、一次点按完成。 */}
      {waiting && onRespond !== undefined && part.approval !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 ps-6">
          <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            {part.approval.requestReason ?? "这个动作在等你批准后才会执行。"}
          </span>
          <div className="flex shrink-0 gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onRespond(part.approval!.id, false)}
            >
              拒绝
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onRespond(part.approval!.id, true)}
            >
              批准
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 工具入参 / 输出。长 JSON 用 CodeBlock 折在 Trace 里，带复制按钮。 */
function ToolDetail({
  input,
  output,
  errorText,
}: {
  input: unknown;
  output: unknown;
  errorText: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      {input !== undefined && input !== null && (
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>调用参数</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={valueText(input)} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {valueText(input)}
          </CodeBlockContent>
        </CodeBlock>
      )}
      {errorText !== undefined && errorText !== "" && (
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockHeader>
            <CodeBlockTitle>错误</CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {errorText}
          </CodeBlockContent>
        </CodeBlock>
      )}
      {output !== undefined && output !== null && (
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>结果</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={valueText(output)} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {valueText(output)}
          </CodeBlockContent>
        </CodeBlock>
      )}
    </div>
  );
}
