import { useCallback, useEffect, useRef, useState } from "react";

import {
  CircleAlert,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";

import type {
  ModelEntry,
  ModelsConfig,
  ProviderConfig,
  ProviderDraft,
  PublicProvider,
} from "@shared/types";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from "@shared/types";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { PROTOCOL_OPTIONS, PROVIDER_PRESETS, type PresetModel } from "./presets";

interface ModelsSettingsProps {
  models: ModelsConfig;
  onSaved: (models: ModelsConfig) => void;
}

/** 输入停下来这么久就落盘，避免每敲一个字都写一次文件。 */
const AUTOSAVE_MS = 400;

/** Provider state while editing: stored key presence plus a pending key change. */
interface ProviderEdit extends ProviderConfig {
  hasApiKey: boolean;
  /** `undefined` keeps the stored key, `null` clears it, a string replaces it. */
  apiKey?: string | null;
}

export function ModelsSettings({ models, onSaved }: ModelsSettingsProps) {
  const [providers, setProviders] = useState<ProviderEdit[]>(() => models.providers.map(toEdit));
  const [selectedId, setSelectedId] = useState<string | null>(
    () => models.providers[0]?.id ?? null,
  );
  const [editingModel, setEditingModel] = useState<{
    providerId: string;
    model: ModelEntry | null;
  } | null>(null);
  /** 自动保存的状态：改动是边改边存的，用户得看得见。 */
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const provider = providers.find((item) => item.id === selectedId) ?? null;

  /*
   * 实时保存：本地 draft 先落 state（输入才不卡），停手 AUTOSAVE_MS 后落盘。
   * 落盘结果只回填"主进程才知道"的字段（hasApiKey、已存 Key 的结算），
   * 不回写整份 providers，否则用户正在输入的框会被打断。
   *
   * 注意：这里**不做**“配置不完整就不保存”的校验。新增供应商时 Base URL 和模型
   * 往往还空着，拦下来只会让用户以为“设置根本不保存”——退出设置就丢了。
   * 半成品照常落盘，能不能用交给左侧状态点提示。
   */
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const persist = useCallback(async (): Promise<void> => {
    if (mountedRef.current) setSaveState("saving");
    try {
      const next = await window.goodjob.models.save({
        providers: providersRef.current.map(toDraft),
      });
      if (!mountedRef.current) return;
      setSaveState("saved");
      setError(null);
      setProviders((prev) =>
        prev.map((item) => {
          const saved = next.providers.find((entry) => entry.id === item.id);
          if (saved === undefined) return item;
          const keySettled = typeof item.apiKey === "string" && item.apiKey.trim() !== "";
          return { ...item, hasApiKey: saved.hasApiKey, apiKey: keySettled ? undefined : item.apiKey };
        }),
      );
      onSaved(next);
    } catch (caught) {
      if (mountedRef.current) {
        setSaveState("idle");
        setError(caught instanceof Error ? caught.message : "保存失败");
      }
    }
  }, [onSaved]);

  const scheduleSave = useCallback((): void => {
    setSaveState("saving");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void persist();
    }, AUTOSAVE_MS);
  }, [persist]);

  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // 关窗/卸载时把还压在防抖里的改动补写一次，免得最后几个字丢掉。
  // 依赖留空：只在真正卸载时执行，不能因为父组件重渲染就误触发一次保存。
  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current === null) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      void window.goodjob.models
        .save({ providers: providersRef.current.map(toDraft) })
        .then((next) => onSavedRef.current(next));
    },
    [],
  );

  const patchProvider = (id: string, patch: Partial<ProviderEdit>): void => {
    setProviders((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    scheduleSave();
  };

  const addProvider = (presetKey: string): void => {
    const preset = PROVIDER_PRESETS.find((item) => item.key === presetKey);
    if (preset === undefined) return;

    const added: ProviderEdit = {
      id: crypto.randomUUID(),
      name: preset.name,
      protocol: preset.protocol,
      baseURL: preset.baseURL,
      enabled: true,
      hasApiKey: false,
      apiKey: undefined,
      models: preset.models.map(fromPresetModel),
    };
    setProviders((prev) => [...prev, added]);
    setSelectedId(added.id);
    scheduleSave();
  };

  const removeProvider = (id: string): void => {
    setProviders((prev) => {
      const next = prev.filter((item) => item.id !== id);
      setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
      return next;
    });
    scheduleSave();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 pt-6 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">模型设置</h1>
        <span className="text-xs text-muted-foreground">
          {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "改动自动保存"}
        </span>
      </div>

      {error !== null && (
        <div className="mx-6 mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 border-t">
        <div className="flex w-52 shrink-0 flex-col border-r bg-muted/30">
          <div className="flex h-10 items-center justify-between pr-2 pl-4">
            <span className="text-xs text-muted-foreground">供应商</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="添加供应商">
                  <Plus />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {PROVIDER_PRESETS.map((preset) => (
                  <DropdownMenuItem key={preset.key} onSelect={() => addProvider(preset.key)}>
                    {preset.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {providers.map((item) => {
              const status = providerStatus(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                    item.id === selectedId
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <span className="truncate">{item.name || "未命名供应商"}</span>
                  <span
                    className={cn(
                      "ml-auto size-1.5 shrink-0 rounded-full",
                      status.tone === "on" && "bg-emerald-500",
                      status.tone === "warn" && "bg-amber-500",
                      status.tone === "off" && "bg-muted-foreground/40",
                    )}
                    title={status.label}
                  />
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {providers.length === 0 ? (
            <Empty className="pt-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Settings2 />
                </EmptyMedia>
                <EmptyTitle>还没有供应商</EmptyTitle>
                <EmptyDescription>
                  模型请求要发给某个供应商。先添加一个，再填它的 Base URL 和模型。
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm">
                      <Plus />
                      添加供应商
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {PROVIDER_PRESETS.map((preset) => (
                      <DropdownMenuItem key={preset.key} onSelect={() => addProvider(preset.key)}>
                        {preset.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </EmptyContent>
            </Empty>
          ) : provider === null ? (
            <p className="pt-10 text-center text-sm text-muted-foreground">选择一个供应商</p>
          ) : (
            <ProviderForm
              key={provider.id}
              provider={provider}
              canStoreKey={models.canStoreKey}
              onChange={(patch) => patchProvider(provider.id, patch)}
              onRemove={() => removeProvider(provider.id)}
              onAddModel={() => setEditingModel({ providerId: provider.id, model: null })}
              onEditModel={(model) => setEditingModel({ providerId: provider.id, model })}
            />
          )}
        </div>
      </div>

      <ModelEditor
        open={editingModel !== null}
        model={editingModel?.model ?? null}
        onCancel={() => setEditingModel(null)}
        onSubmit={(entry) => {
          if (editingModel === null) return;
          const target = providers.find((item) => item.id === editingModel.providerId);
          if (target === undefined) return;
          const duplicate = target.models.some(
            (item) => item.id === entry.id && item.id !== editingModel.model?.id,
          );
          if (duplicate) {
            setError("这个供应商里已经有同 ID 的模型了。");
            return;
          }
          const next =
            editingModel.model === null
              ? [...target.models, entry]
              : target.models.map((item) =>
                  item.id === editingModel.model?.id ? entry : item,
                );
          patchProvider(editingModel.providerId, { models: next });
          setEditingModel(null);
        }}
      />
    </div>
  );
}

interface ProviderFormProps {
  provider: ProviderEdit;
  canStoreKey: boolean;
  onChange: (patch: Partial<ProviderEdit>) => void;
  onRemove: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelEntry) => void;
}

function ProviderForm({
  provider,
  canStoreKey,
  onChange,
  onRemove,
  onAddModel,
  onEditModel,
}: ProviderFormProps) {
  const pendingKey = provider.apiKey;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Input
          value={provider.name}
          placeholder="供应商名称"
          className="h-8 flex-1 border-transparent px-1 text-base font-semibold shadow-none focus-visible:border-input"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Switch
          checked={provider.enabled}
          aria-label="启用这个供应商"
          onCheckedChange={(checked) => onChange({ enabled: checked })}
        />
        <DeleteButton
          label="删除供应商"
          title="删除这个供应商？"
          description="它的模型和已保存的 API Key 会一起删除。"
          onConfirm={onRemove}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-base-url" className="text-xs text-muted-foreground">
          Base URL
        </Label>
        <Input
          id="provider-base-url"
          spellCheck={false}
          value={provider.baseURL}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => onChange({ baseURL: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">API 格式</Label>
        <Select
          value={provider.protocol}
          onValueChange={(value) => onChange({ protocol: value as ProviderConfig["protocol"] })}
        >
          <SelectTrigger className="w-full" aria-label="API 格式">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROTOCOL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <span className="flex flex-col items-start">
                  <span className="text-sm">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="provider-key" className="text-xs text-muted-foreground">
          API Key
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="provider-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={!canStoreKey}
            value={pendingKey ?? ""}
            placeholder={
              pendingKey === null
                ? "保存后清除已存 Key"
                : provider.hasApiKey
                  ? "•••••••• 已保存，留空则不修改"
                  : "sk-..."
            }
            onChange={(event) => onChange({ apiKey: event.target.value })}
          />
          {provider.hasApiKey && (
            <Button variant="outline" size="sm" onClick={() => onChange({ apiKey: null })}>
              清除
            </Button>
          )}
        </div>
        <p className={cn("text-xs", canStoreKey ? "text-muted-foreground" : "text-amber-600")}>
          {canStoreKey
            ? "钥匙串加密后存在当前工作区，渲染层拿不到明文。使用本地模型时可以留空。"
            : "当前系统无法保存 API Key，使用本地模型时可以直接留空。"}
        </p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">模型列表</span>
        <Button variant="outline" size="sm" onClick={onAddModel}>
          <Plus />
          添加模型
        </Button>
      </div>

      {provider.models.length === 0 ? (
        <div className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          还没有模型，先添加一个
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {provider.models.map((model) => (
            <div key={model.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={model.id}>
                {model.name || model.id}
              </span>
              {model.contextWindow !== undefined && (
                <Badge variant="secondary" className="text-[10px]">
                  {formatContext(model.contextWindow)}
                </Badge>
              )}
              {model.vision === true && (
                <Badge variant="secondary" className="text-[10px]">
                  视觉
                </Badge>
              )}
              {model.reasoning === true && (
                <Badge variant="secondary" className="text-[10px]">
                  推理
                </Badge>
              )}
              <Switch
                size="sm"
                checked={model.enabled}
                aria-label={`启用 ${model.id}`}
                onCheckedChange={(checked) =>
                  onChange({
                    models: provider.models.map((item) =>
                      item.id === model.id ? { ...item, enabled: checked } : item,
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="编辑模型"
                onClick={() => onEditModel(model)}
              >
                <Pencil />
              </Button>
              <DeleteButton
                label="删除模型"
                title="删除这个模型？"
                description="只从当前供应商里移除，不影响其他配置。"
                onConfirm={() =>
                  onChange({ models: provider.models.filter((item) => item.id !== model.id) })
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteButton({
  label,
  title,
  description,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={label}>
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={onConfirm}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ModelEditorProps {
  open: boolean;
  model: ModelEntry | null;
  onCancel: () => void;
  onSubmit: (model: ModelEntry) => void;
}

function ModelEditor({ open, model, onCancel, onSubmit }: ModelEditorProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [vision, setVision] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [enabled, setEnabled] = useState(true);

  // 每次打开都用当前模型重置表单。
  useEffect(() => {
    if (!open) return;
    setId(model?.id ?? "");
    setName(model?.name ?? "");
    setContextWindow(model?.contextWindow === undefined ? "" : String(model.contextWindow));
    setMaxOutputTokens(
      model?.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
    );
    setVision(model?.vision === true);
    setReasoning(model?.reasoning === true);
    setEnabled(model?.enabled !== false);
  }, [open, model]);

  const submit = (): void => {
    const trimmedId = id.trim();
    if (trimmedId === "") return;
    const tokens = Number(contextWindow);
    const maxTokens = Number(maxOutputTokens);
    onSubmit({
      id: trimmedId,
      name: name.trim() === "" ? trimmedId : name.trim(),
      enabled,
      contextWindow:
        Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens:
        Number.isFinite(maxTokens) && maxTokens > 0
          ? Math.round(maxTokens)
          : DEFAULT_MAX_OUTPUT_TOKENS,
      vision,
      reasoning,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{model === null ? "添加模型" : "编辑模型"}</DialogTitle>
          <DialogDescription>模型 ID 会作为请求里的 `model` 字段发给供应商。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-id" className="text-xs text-muted-foreground">
              模型 ID
            </Label>
            <Input
              id="model-id"
              spellCheck={false}
              value={id}
              placeholder="例如 gpt-4o、claude-sonnet-4-5"
              onChange={(event) => setId(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-name" className="text-xs text-muted-foreground">
              显示名称（可选）
            </Label>
            <Input
              id="model-name"
              spellCheck={false}
              value={name}
              placeholder="留空则与模型 ID 相同"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-context" className="text-xs text-muted-foreground">
              上下文窗口（token）
            </Label>
            <Input
              id="model-context"
              inputMode="numeric"
              value={contextWindow}
              placeholder={`默认 ${DEFAULT_CONTEXT_WINDOW}`}
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="model-max-output" className="text-xs text-muted-foreground">
              最大输出（token）
            </Label>
            <Input
              id="model-max-output"
              inputMode="numeric"
              value={maxOutputTokens}
              placeholder={`默认 ${DEFAULT_MAX_OUTPUT_TOKENS}`}
              onChange={(event) => setMaxOutputTokens(event.target.value)}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              单次回复的上限，同时会从上下文窗口里预留这么多空间。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={vision} onCheckedChange={setVision} />
              视觉输入
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={reasoning} onCheckedChange={setReasoning} />
              推理模型
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch size="sm" checked={enabled} onCheckedChange={setEnabled} />
              启用
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button disabled={id.trim() === ""} onClick={submit}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toEdit(provider: PublicProvider): ProviderEdit {
  const { hasApiKey, ...rest } = provider;
  return { ...rest, hasApiKey, apiKey: undefined };
}

function toDraft(provider: ProviderEdit): ProviderDraft {
  const { hasApiKey: _hasApiKey, ...rest } = provider;
  return rest;
}

function fromPresetModel(preset: PresetModel): ModelEntry {
  return {
    id: preset.id,
    name: preset.name ?? preset.id,
    enabled: true,
    contextWindow: preset.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: preset.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    vision: preset.vision,
    reasoning: preset.reasoning,
  };
}

function formatContext(tokens: number): string {
  if (tokens >= 1000000) {
    const millions = tokens / 1000000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** 官方端点一定会校验 Key；其他地址按自建/中转处理。 */
const OFFICIAL_HOSTS =
  /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|deepseek\.com|openrouter\.ai)$/i;

function providerStatus(provider: ProviderEdit): { tone: "on" | "warn" | "off"; label: string } {
  if (!provider.enabled) return { tone: "off", label: "已停用" };
  if (provider.models.every((model) => !model.enabled)) {
    return { tone: "warn", label: "没有启用的模型" };
  }
  if (provider.baseURL.trim() === "") return { tone: "warn", label: "还没填 Base URL" };
  const needsKey = OFFICIAL_HOSTS.test(safeHost(provider.baseURL));
  const hasKey =
    provider.hasApiKey ||
    (typeof provider.apiKey === "string" && provider.apiKey.trim() !== "");
  if (needsKey && !hasKey) return { tone: "warn", label: "还没有填写 API Key" };
  return { tone: "on", label: "就绪" };
}

function safeHost(baseURL: string): string {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return "";
  }
}
