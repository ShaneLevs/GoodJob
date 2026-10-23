import { useMemo, useRef, useState } from "react";

import {
  ArrowUp,
  ChevronDown,
  LoaderCircle,
  MessageCircleDashed,
  Settings2,
  Square,
} from "lucide-react";

import type { ModelSelection, ModelsConfig } from "@shared/types";

import { Markdown } from "./markdown";import { Bubble, BubbleContent } from "./ui/bubble";
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
import type { UiMessage } from "../types";

interface ChatPanelProps {
  messages: UiMessage[];
  streaming: boolean;
  models: ModelsConfig | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onSelectModel: (selection: ModelSelection) => void;
  /** 模型下拉里的「模型设置」跳转。 */
  onOpenModelSettings: () => void;
  /** 下拉浮层打开时，原生浏览器视图要让位。 */
  onOverlayChange: (open: boolean) => void;
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

/** 上下文窗口只用来做个徽标，取整到 K/M。 */
function formatContext(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function ChatPanel({
  messages,
  streaming,
  models,
  onSend,
  onStop,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
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
  const canSend = draft.trim() !== "" && !streaming;

  const submit = (): void => {
    const text = draft.trim();
    if (text === "" || streaming) return;
    setDraft("");
    onSend(text);
    inputRef.current?.focus();
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
          placeholder="说说你想找什么岗位，或者直接问我"
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

          {streaming ? (
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
                <EmptyTitle>今天想找什么样的工作？</EmptyTitle>
                <EmptyDescription>
                  说说你的目标岗位、城市和年限，我会一边查一边把结果放进右栏。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-5 py-5">
                {messages.map((message) => {
                  const isUser = message.role === "user";

                  if (isUser) {
                    return (
                      <MessageScrollerItem key={message.id} scrollAnchor>
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end" variant="muted">
                              <BubbleContent className="whitespace-pre-wrap">
                                {message.content}
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
                          {message.failed === true ? (
                            <p className="text-sm whitespace-pre-wrap text-destructive">
                              {message.content}
                            </p>
                          ) : message.content === "" && message.streaming === true ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <LoaderCircle className="size-4 animate-spin" />
                              思考中…
                            </div>
                          ) : (
                            <Markdown streaming={message.streaming === true}>
                              {message.content}
                            </Markdown>
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  );
                })}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        )}
      </MessageScrollerProvider>

      <div className="px-4 pb-4">
        <div className="mx-auto w-full max-w-3xl">{promptInput}</div>
      </div>
    </div>
  );
}
