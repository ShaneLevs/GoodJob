import { useMemo, useRef, useState } from "react";

import { ArrowUp, ChevronDown, Plus, Settings2, Square } from "lucide-react";

import { DEFAULT_REASONING_EFFORT, isImageUploadName } from "@shared/types";
import type {
  ContextUsage,
  ConversationKey,
  ModelSelection,
  ModelsConfig,
  ReasoningEffort,
  UploadedFileMeta,
} from "@shared/types";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/ai-elements/input-group";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { formatContext, formatTokens } from "@/lib/format";

import { UploadAttachment } from "./UploadAttachment";
import { useContextUsage } from "./use-context-usage";

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

interface ComposerProps {
  models: ModelsConfig | null;
  busy: boolean;
  allowUpload: boolean;
  conversationKey?: ConversationKey;
  placeholder: string;
  onSend: (text: string, uploads: UploadedFileMeta[], effort: ReasoningEffort) => void;
  onStop: () => void;
  onSelectModel: (selection: ModelSelection) => void;
  onOpenModelSettings: () => void;
  onOverlayChange: (open: boolean) => void;
  /** 一次手动压缩成功落盘后通知外层，好在消息流里插入系统提示。 */
  onCompacted: () => void;
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

function optionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function Composer({
  models,
  busy,
  allowUpload,
  conversationKey,
  placeholder,
  onSend,
  onStop,
  onSelectModel,
  onOpenModelSettings,
  onOverlayChange,
  onCompacted,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [pendingUploads, setPendingUploads] = useState<UploadedFileMeta[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // 压缩在 main 里同步执行：期间只锁发送，输入框继续可编辑。
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = models?.activeModel ?? null;
  const activeKey = active === null ? null : optionKey(active.providerId, active.modelId);
  const hasImagePending = pendingUploads.some((file) => isImageUploadName(file.fileName));
  // 没勾「视觉输入」的模型仍可收图（保存成文件），只是看不到画面，提前说明。
  const visionOff = active !== null && !active.vision;

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
  // 上下文用量：只在 main 算（与自动压缩阈值同一套），这里只管展示与手动压缩。
  const { usage, compact } = useContextUsage(conversationKey ?? null, busy);
  const usagePercent =
    usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
  const thresholdPercent =
    usage.limit > 0 ? Math.round((usage.threshold / usage.limit) * 100) : 0;
  const canSend = (draft.trim() !== "" || pendingUploads.length > 0) && !busy && !compacting;

  const submit = (): void => {
    if (!canSend) return;
    const imageOnly =
      pendingUploads.length > 0 &&
      pendingUploads.every((file) => isImageUploadName(file.fileName));
    const text =
      draft.trim() !== ""
        ? draft.trim()
        : `${imageOnly ? "我上传了图片" : "我上传了文件"} ${pendingUploads
            .map((file) => `「${file.fileName}」`)
            .join("、")}，请查看。`;
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

  // 手动压缩：main 的摘要调用是同步 IPC，压缩期间锁发送、按钮显示「压缩中」。
  const handleCompact = async (): Promise<void> => {
    if (compacting || busy || usage.used === 0) return;
    setCompacting(true);
    setCompactError(null);
    try {
      await compact();
      onCompacted();
    } catch (cause: unknown) {
      setCompactError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCompacting(false);
    }
  };

  return (
    <form
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {uploadError !== null && (
        <p className="px-1 pb-1.5 text-xs text-destructive">{uploadError}</p>
      )}
      {visionOff && hasImagePending && (
        <p className="px-1 pb-1.5 text-xs text-muted-foreground">
          当前模型没有勾选「视觉输入」：图片会保存到上传目录，但模型看不到画面。可在设置 →
          模型里勾选。
        </p>
      )}
      <InputGroup>
        {pendingUploads.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap">
            {pendingUploads.map((file) => (
              <UploadAttachment
                key={file.fileName}
                file={file}
                conversationKey={conversationKey}
                onRemove={() =>
                  setPendingUploads((prev) =>
                    prev.filter((item) => item.fileName !== file.fileName),
                  )
                }
              />
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
              aria-label="上传参考文件或图片（PDF / Word / Markdown / 文本 / 图片）"
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
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || compacting || usage.used === 0}
                    onClick={() => void handleCompact()}
                  >
                    {compacting ? "压缩中" : "压缩"}
                  </Button>
                </div>
                {compactError !== null && (
                  <p className="text-xs text-destructive">{compactError}</p>
                )}
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
}
