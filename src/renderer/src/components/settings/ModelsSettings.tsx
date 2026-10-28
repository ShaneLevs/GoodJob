import { useCallback, useEffect, useRef, useState } from "react";

import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";

import type {
  ModelEntry,
  ModelProbeResult,
  ModelsConfig,
  ProviderConfig,
  ProviderDraft,
  PublicProvider,
  RemoteModelInfo,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatContext } from "@/lib/format";
import { cn, ipcErrorMessage } from "@/lib/utils";

import { PROTOCOL_OPTIONS, PROVIDER_PRESETS, type PresetModel } from "./presets";
import { useAutoSave } from "./use-autosave";

interface ModelsSettingsProps {
  models: ModelsConfig;
  onSaved: (models: ModelsConfig) => void;
}

/** 一次改动把整份供应商列表排进自动保存队列（旧快照自动作废）。 */
interface ModelsSnapshot {
  providers: ProviderDraft[];
}

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
  /** 列表内的校验提示（模型 ID 重复），与保存失败分开显示。 */
  const [error, setError] = useState<string | null>(null);

  const provider = providers.find((item) => item.id === selectedId) ?? null;

  /*
   * 自动保存：本地 draft 先落 state（输入才不卡），停手后由 `useAutoSave` 落盘。
   * 落盘结果只回填"主进程才知道"的字段（hasApiKey、已存 Key 的结算），
   * 不回写整份 providers，否则用户正在输入的框会被打断。
   *
   * 注意：这里**不做**“配置不完整就不保存”的校验。新增供应商时 Base URL 和模型
   * 往往还空着，拦下来只会让用户以为“设置根本不保存”——退出设置就丢了。
   * 半成品照常落盘，能不能用交给左侧状态点提示。
   */
  const providersRef = useRef(providers);
  providersRef.current = providers;

  const save = useCallback(
    async (snapshot: ModelsSnapshot): Promise<void> => {
      const next = await window.goodjob.models.save({ providers: snapshot.providers });
      onSaved(next);

      /*
       * 只把主进程才知道的字段（hasApiKey）贴回去，并按「哪一项确实被这份快照
       * 存过」结算 API Key 输入框：存过的新 Key 清空、不再回显；用户在落盘期间
       * 又敲进去的字符不能被抹掉，留着等下一轮保存。
       */
      const current = providersRef.current;
      const settled = current.map((item) => {
        const saved = next.providers.find((entry) => entry.id === item.id);
        if (saved === undefined) return item;
        const queued = snapshot.providers.find((entry) => entry.id === item.id);
        const sameKey = queued !== undefined && (queued.apiKey ?? null) === (item.apiKey ?? null);
        // 存过的新 Key 清空输入框；刚点过「清除」的也回到「保持已存」的初始态。
        const keySettled =
          sameKey &&
          item.apiKey !== undefined &&
          (item.apiKey === null || item.apiKey.trim() !== "");
        return {
          ...item,
          hasApiKey: saved.hasApiKey,
          apiKey: keySettled ? undefined : item.apiKey,
        };
      });
      providersRef.current = settled;
      setProviders(settled);
    },
    [onSaved],
  );

  const autosave = useAutoSave(save);

  /** 把当前整份供应商列表排进自动保存队列（旧快照自动作废）。 */
  const scheduleSave = (next: ProviderEdit[]): void => {
    providersRef.current = next;
    setProviders(next);
    autosave.schedule({ providers: next.map(toDraft) });
  };

  const patchProvider = (id: string, patch: Partial<ProviderEdit>): void => {
    scheduleSave(providersRef.current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  /*
   * 两个「试一下」都只用**已落盘的**配置（Key 只在 main 解密，渲染层不参与）。
   * 所以先 flush 一次自动保存：用户刚敲完 Base URL / Key 就点按钮时，
   * 那 400ms 防抖里的改动也必须在盘上，否则会拿旧配置去请求。
   */
  const flush = autosave.flush;
  const probeModels = useCallback(
    async (providerId: string): Promise<RemoteModelInfo[]> => {
      await flush();
      return window.goodjob.models.probeList(providerId);
    },
    [flush],
  );

  const probeModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelProbeResult> => {
      await flush();
      return window.goodjob.models.probeModel(providerId, modelId);
    },
    [flush],
  );

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
    scheduleSave([...providersRef.current, added]);
    setSelectedId(added.id);
  };

  const removeProvider = (id: string): void => {
    const next = providersRef.current.filter((item) => item.id !== id);
    setSelectedId((current) => (current === id ? (next[0]?.id ?? null) : current));
    scheduleSave(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h1 className="text-lg font-semibold tracking-tight">模型设置</h1>
      </div>

      {autosave.error !== null && (
        <div className="mx-6 mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{autosave.error}</span>
        </div>
      )}

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
              onTestModel={(modelId) => probeModel(provider.id, modelId)}
            />
          )}
        </div>
      </div>

      <ModelEditor
        open={editingModel !== null}
        model={editingModel?.model ?? null}
        onCancel={() => setEditingModel(null)}
        onFetchModels={
          editingModel === null ? undefined : () => probeModels(editingModel.providerId)
        }
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
  /** 对一个已添加的模型发一次最小请求，验证端点 / Key / 模型 id 通不通。 */
  onTestModel: (modelId: string) => Promise<ModelProbeResult>;
}

/** 某一行模型的探测状态：跑着的时候显示转圈，结束后一直留到最后一次结果面板。 */
interface ModelProbeState {
  running: boolean;
  result?: ModelProbeResult;
}

/** 行内按钮的颜色：测过才染色（通过绿 / 失败红），没测过保持默认。 */
function probeTone(result: ModelProbeResult | undefined): string {
  if (result === undefined) return "";
  return result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive";
}

function ProviderForm({
  provider,
  canStoreKey,
  onChange,
  onRemove,
  onAddModel,
  onEditModel,
  onTestModel,
}: ProviderFormProps) {
  const pendingKey = provider.apiKey;
  const [probes, setProbes] = useState<Record<string, ModelProbeState>>({});
  /** 最后一条测试结果：模型多的时候行内放不下完整错误，单独一行展示。 */
  const [lastProbe, setLastProbe] = useState<{ modelId: string; result: ModelProbeResult } | null>(
    null,
  );

  const runTest = async (modelId: string): Promise<void> => {
    setProbes((current) => ({ ...current, [modelId]: { running: true } }));
    let result: ModelProbeResult;
    try {
      result = await onTestModel(modelId);
    } catch (caught) {
      result = { ok: false, message: ipcErrorMessage(caught) };
    }
    setProbes((current) => ({ ...current, [modelId]: { running: false, result } }));
    setLastProbe({ modelId, result });
  };

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
            {/* 触发器只显示格式名：默认会把两行选项文字整块搬进来，溢出 32px 的行高。 */}
            <SelectValue>
              {PROTOCOL_OPTIONS.find((option) => option.value === provider.protocol)?.label ??
                "选择 API 格式"}
            </SelectValue>
          </SelectTrigger>
          {/*
           * 选项是两行（格式 + 一句话说明），所以：
           * - popper 定位：item-aligned 会把选中项顶到触发器上，列表整体上移顶到框外；
           * - 每项 py-2：36px 的行高放不下两行文字 + 上下间距。
           */}
          <SelectContent position="popper" align="start">
            {PROTOCOL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="py-2">
                <span className="flex flex-col items-start gap-0.5">
                  <span className="text-sm">{option.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{option.hint}</span>
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
                  {formatContext(model.contextWindow) ?? "0"}
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
                aria-label={`测试连接 ${model.id}`}
                title="测试连接"
                disabled={probes[model.id]?.running === true}
                onClick={() => void runTest(model.id)}
              >
                {probes[model.id]?.running === true ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <PlugZap className={probeTone(probes[model.id]?.result)} />
                )}
              </Button>
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

      {lastProbe !== null && <ProbeResultLine modelId={lastProbe.modelId} result={lastProbe.result} />}
    </div>
  );
}

function ProbeResultLine({
  modelId,
  result,
}: {
  modelId: string;
  result: ModelProbeResult;
}) {
  return (
    <div
      data-slot="probe-result"
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-xs",
        result.ok
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      {result.ok ? (
        <CircleCheck className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">
        <span className="font-mono">{modelId}</span>
        <span className="mx-1.5 opacity-50">·</span>
        {result.message}
      </span>
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
  /** 从这个供应商的接口读候选模型；拿不到时仍可手填模型 ID。 */
  onFetchModels?: () => Promise<RemoteModelInfo[]>;
}

function ModelEditor({ open, model, onCancel, onSubmit, onFetchModels }: ModelEditorProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [vision, setVision] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [enabled, setEnabled] = useState(true);

  // 模型 ID 的可选项：从供应商接口读一次，选完不重复读（要重读有刷新按钮）。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [remote, setRemote] = useState<RemoteModelInfo[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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
    setPickerOpen(false);
    setRemote(null);
    setFetchError(null);
    setFetching(false);
    setQuery("");
  }, [open, model]);

  const loadModels = async (): Promise<void> => {
    if (onFetchModels === undefined || fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      setRemote(await onFetchModels());
    } catch (caught) {
      setRemote([]);
      setFetchError(ipcErrorMessage(caught));
    } finally {
      setFetching(false);
    }
  };

  /** 选中一个候选：填 ID，顺手把空的展示名 / 上下文窗口补上。 */
  const pick = (item: RemoteModelInfo): void => {
    setId(item.id);
    if (name.trim() === "" && item.name !== item.id) setName(item.name);
    if (contextWindow.trim() === "" && item.contextWindow !== undefined) {
      setContextWindow(String(item.contextWindow));
    }
    setPickerOpen(false);
  };

  const keyword = query.trim().toLowerCase();
  const candidates =
    remote === null
      ? []
      : keyword === ""
        ? remote
        : remote.filter(
            (item) =>
              item.id.toLowerCase().includes(keyword) ||
              item.name.toLowerCase().includes(keyword),
          );

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
            {/* 输入框 + 下拉：可以直接手填，也可以从供应商的 /models 里选一个。 */}
            <div className="flex items-center gap-1.5">
              <Input
                id="model-id"
                spellCheck={false}
                className="flex-1"
                value={id}
                placeholder="例如 gpt-4o、claude-sonnet-4-5"
                onChange={(event) => setId(event.target.value)}
              />
              <Popover
                open={pickerOpen}
                onOpenChange={(next) => {
                  setPickerOpen(next);
                  if (next && remote === null) void loadModels();
                }}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="从接口选择模型"
                    title="从接口读取模型列表"
                    disabled={onFetchModels === undefined}
                  >
                    <ChevronDown />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" side="bottom" className="w-80 gap-2 p-2">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <span className="text-xs text-muted-foreground">
                      {fetchError !== null
                        ? "读取失败"
                        : remote === null
                          ? "从接口读取模型"
                          : keyword === ""
                            ? `共 ${remote.length} 个模型`
                            : `${candidates.length} / ${remote.length}`}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="重新获取模型列表"
                      title="重新获取"
                      disabled={fetching}
                      onClick={() => void loadModels()}
                    >
                      <RefreshCw className={cn(fetching && "animate-spin")} />
                    </Button>
                  </div>

                  <Input
                    autoFocus
                    spellCheck={false}
                    className="h-7"
                    value={query}
                    placeholder="筛选模型…"
                    onChange={(event) => setQuery(event.target.value)}
                  />

                  {fetchError !== null && (
                    <p className="px-1 text-xs leading-relaxed break-words text-destructive">
                      {fetchError}
                    </p>
                  )}

                  {fetching && remote === null ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                      <LoaderCircle className="size-3.5 animate-spin" />
                      正在读取…
                    </div>
                  ) : candidates.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                      {fetchError !== null
                        ? "可以直接手填模型 ID。"
                        : keyword === ""
                          ? "没有可选的模型，可以直接手填模型 ID。"
                          : "没有匹配的模型。"}
                    </p>
                  ) : (
                    <div className="max-h-64 overflow-y-auto">
                      {candidates.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => pick(item)}
                          className={cn(
                            "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent",
                            item.id === id.trim() && "bg-accent",
                          )}
                        >
                          <span className="flex w-full items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {item.name}
                            </span>
                            {item.contextWindow !== undefined && (
                              <span className="shrink-0 text-[10px] text-muted-foreground">
                                {formatContext(item.contextWindow)}
                              </span>
                            )}
                          </span>
                          {/* 展示名和 ID 一样时不重复写两行。 */}
                          {item.name !== item.id && (
                            <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                              {item.id}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              可以从接口读取列表里选，也可以直接手填任意模型 ID。
            </p>
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
            确定
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
