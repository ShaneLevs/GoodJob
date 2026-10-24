import { useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  LoaderCircle,
  MessageCircleDashed,
  Plus,
  Settings2,
  Square,
  Wrench,
} from "lucide-react";

import type { ChatStatus, UIMessage } from "ai";
import type { ModelSelection, ModelsConfig } from "@shared/types";

import { Markdown } from "./markdown";
import { Bubble, BubbleContent } from "./ui/bubble";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "./ui/input-group";
import { Message, MessageContent } from "./ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";
import { cn } from "@/lib/utils";

interface ChatPanelProps {
  messages: UIMessage[];
  status: ChatStatus;
  errorText: string | null;
  models: ModelsConfig | null;
  onSend: (text: string) => void;
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
   * 输入框左下角「+」的上传动作：打开文件选择并返回要发送的完整消息文本，
   * 用户取消返回 null。不传则不显示 + 按钮。
   */
  onImportFile?: () => Promise<string | null>;
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
}

/** 上下文窗口只用来做个徽标，取整到 K/M。 */
function formatContext(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function userText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
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
  onImportFile,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
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
  const canSend = draft.trim() !== "" && !busy;

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || busy) return;
    setDraft("");
    onSend(text);
    inputRef.current?.focus();
  };

  // 「+」上传：文件选择在 main 侧完成，这里只发整理后的消息。
  const importFile = (): void => {
    if (onImportFile === undefined || busy) return;
    setImportError(null);
    onImportFile()
      .then((text) => {
        if (text !== null) onSend(text);
      })
      .catch((cause: unknown) => {
        setImportError(cause instanceof Error ? cause.message : String(cause));
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
          {onImportFile !== undefined && (
            <InputGroupButton
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label="上传旧简历（PDF / Word / Markdown）"
              disabled={busy}
              onClick={importFile}
            >
              <Plus />
            </InputGroupButton>
          )}
          <InputGroupText className="text-xs">
            Enter 发送 · Shift + Enter 换行
          </InputGroupText>

          <DropdownMenu onOpenChange={onOverlayChange}>
            <DropdownMenuTrigger asChild>
              <InputGroupButton
                size="sm"
                variant="ghost"
                className="ml-auto max-w-56 text-xs text-muted-foreground"
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
      <MessageScrollerProvider>
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
                    return (
                      <MessageScrollerItem key={message.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">
                                {userText(message)}
                              </BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    );
                  }

                  return (
                    <MessageScrollerItem key={message.id}>
                      <Message>
                        <MessageContent className="gap-3">
                          {message.parts.map((part, partIndex) => {
                            if (part.type === "text") {
                              return (
                                <Markdown
                                  key={partIndex}
                                  streaming={isLast && status === "streaming"}
                                >
                                  {part.text}
                                </Markdown>
                              );
                            }
                            if (part.type.startsWith("tool-")) {
                              return (
                                <ToolChip
                                  key={partIndex}
                                  part={part as unknown as ToolPartView}
                                />
                              );
                            }
                            // step-start / file / data-* 等 P1 不展示。
                            return null;
                          })}

                          {isLast && status === "submitted" && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <LoaderCircle className="size-4 animate-spin" />
                              思考中…
                            </div>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  );
                })}

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
          {importError !== null && (
            <p className="px-1 pb-1.5 text-xs text-destructive">{importError}</p>
          )}
          {promptInput}
        </div>
      </div>
    </div>
  );
}

function ToolChip({ part }: { part: ToolPartView }) {
  const [open, setOpen] = useState(false);

  const name = part.type.slice("tool-".length);
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const waiting = part.state === "approval-requested";

  const statusLabel = failed
    ? "失败"
    : waiting
      ? "等待批准"
      : running
        ? "运行中"
        : "完成";

  return (
    <div className="w-full overflow-hidden rounded-lg border border-border/60 bg-muted/30 text-xs">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {failed ? (
          <CircleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : waiting ? (
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        ) : running ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">{statusLabel}</span>
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
          {part.input !== undefined && part.input !== null && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">输入</p>
              <JsonBlock value={part.input} />
            </div>
          )}
          {part.state === "output-error" && part.errorText !== undefined && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">错误</p>
              <JsonBlock value={part.errorText} />
            </div>
          )}
          {part.output !== undefined && part.output !== null && (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">输出</p>
              <JsonBlock value={part.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
  return (
    <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  );
}
