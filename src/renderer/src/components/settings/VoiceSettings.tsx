import { useCallback, useEffect, useRef, useState } from "react";

import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  Mic,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

import type {
  VoiceKind,
  VoiceModelOption,
  VoiceSettings as VoiceSettingsState,
  VoiceSettingsDraft,
  VoiceVoiceOption,
  VoiceState,
} from "@shared/types";

import bailianLogo from "@/assets/bailian.svg";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, ipcErrorMessage } from "@/lib/utils";

import { useAutoSave } from "./use-autosave";

/** 表单快照：一次改动把整份表单排进自动保存队列（旧快照自动作废）。 */
interface VoiceForm {
  tts: {
    endpoint: string;
    model: string;
    voice: string;
    hasApiKey: boolean;
  };
  asr: {
    endpoint: string;
    model: string;
    hasApiKey: boolean;
  };
  /** 用户刚敲进去、还没保存的 Key（空串 = 保持已存值）。 */
  ttsKey: string;
  asrKey: string;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

interface ModelCatalogState {
  status: LoadStatus;
  models: VoiceModelOption[];
  error: string | null;
}

interface VoiceCatalogState {
  status: LoadStatus;
  /** 这份列表对应的模型；切模型时旧列表不再算数。 */
  model: string;
  voices: VoiceVoiceOption[];
  warning: string | null;
  error: string | null;
}

const EMPTY_MODEL_CATALOG: Record<VoiceKind, ModelCatalogState> = {
  asr: { status: "idle", models: [], error: null },
  tts: { status: "idle", models: [], error: null },
};

const EMPTY_VOICE_CATALOG: VoiceCatalogState = {
  status: "idle",
  model: "",
  voices: [],
  warning: null,
  error: null,
};

/** 「手动输入音色 ID」在下拉里的哨兵值；真实音色 ID 不会长这样。 */
const CUSTOM_VOICE = "__custom_voice__";

const PREVIEW_TEXT = "你好，我是你的模拟面试官。请先用一分钟做个自我介绍。";

const BAILIAN_CONSOLE = "https://bailian.console.aliyun.com/";
const BAILIAN_API_KEYS = "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key";

/**
 * 语音模型（Agent 设置）：上面用 tab 分「语音识别 / 语音合成」，每个 tab 里
 * 左侧是供应商（当前只有阿里云百炼），右侧是这个供应商的模型参数。
 *
 * 配置顺序按使用顺序排：接入域名 → API Key → 模型 → 音色。模型和音色都从百炼
 * 的官方接口读（模型列表 API / 官方音色列表页），下拉选择，默认不用手填。
 *
 * 和模型设置同一套纪律：没有保存按钮，改动停手 400ms 自动落盘；API Key 不回显，
 * 留空表示保持已存值，点「清除」才是删掉。所有调用都在 main（AOQ 原生引擎），
 * 渲染层只拿 `hasApiKey`、候选列表与播放状态。
 */
export function VoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettingsState | null>(null);
  const [form, setForm] = useState<VoiceForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<VoiceKind>("asr");
  const [previewing, setPreviewing] = useState(false);
  const [previewNotice, setPreviewNotice] = useState<{
    tone: "ok" | "error";
    message: string;
  } | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [asrTesting, setAsrTesting] = useState(false);
  const [asrNotice, setAsrNotice] = useState<{
    tone: "ok" | "error";
    message: string;
  } | null>(null);
  const [micBusy, setMicBusy] = useState(false);

  const [modelCatalog, setModelCatalog] =
    useState<Record<VoiceKind, ModelCatalogState>>(EMPTY_MODEL_CATALOG);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalogState>(EMPTY_VOICE_CATALOG);
  /** 用户主动选择「手动输入音色 ID」时，把下拉换成输入框。 */
  const [customVoice, setCustomVoice] = useState(false);
  /** 手动输入模型 ID（下拉读不到列表 / 还没配 Key 时也能填）。 */
  const [customModel, setCustomModel] = useState<Record<VoiceKind, boolean>>({
    asr: false,
    tts: false,
  });

  const formRef = useRef<VoiceForm | null>(null);
  formRef.current = form;
  const mountedRef = useRef(true);
  const testingRef = useRef(false);
  const modelSeq = useRef<Record<VoiceKind, number>>({ asr: 0, tts: 0 });
  const voiceSeq = useRef(0);
  /** 音色列表按模型缓存：来回切模型不重复请求官方页面。 */
  const voiceCache = useRef(new Map<string, { voices: VoiceVoiceOption[]; warning: string | null }>());

  useEffect(() => {
    let alive = true;
    void window.goodjob.voice
      .getSettings()
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setForm(fromSettings(next));
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(ipcErrorMessage(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  // 自检要看到「聆听中」的实时文本：直接订阅 main 推来的语音状态。
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = window.goodjob.voice.onState((next) => {
      if (mountedRef.current) setVoiceState(next);
    });
    void window.goodjob.voice.getState().then((snapshot) => {
      if (mountedRef.current) setVoiceState(snapshot);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      // 只在自检进行中收尾：设置弹窗可能是在一场语音面试里打开的，别误停面试。
      if (testingRef.current) {
        testingRef.current = false;
        void window.goodjob.voice.stop();
      }
    };
  }, []);

  const save = useCallback(async (snapshot: VoiceForm): Promise<void> => {
    const next = await window.goodjob.voice.saveSettings({
      tts: {
        endpoint: snapshot.tts.endpoint,
        model: snapshot.tts.model,
        voice: snapshot.tts.voice,
        // 只把用户新敲的 Key 发过去；留空表示保持已存值。
        ...(snapshot.ttsKey.trim() === "" ? {} : { apiKey: snapshot.ttsKey.trim() }),
      },
      asr: {
        endpoint: snapshot.asr.endpoint,
        model: snapshot.asr.model,
        ...(snapshot.asrKey.trim() === "" ? {} : { apiKey: snapshot.asrKey.trim() }),
      },
    });
    setSettings(next);
    // 保存成功后把输入框里的 Key 清掉：它已经进钥匙串了，不该留在界面上。
    const current = formRef.current;
    if (current !== null) {
      const settled: VoiceForm = {
        ...current,
        // 只清掉「这次保存带上去的那份 Key」：保存期间新敲的内容保留在输入框里。
        ttsKey: current.ttsKey === snapshot.ttsKey ? "" : current.ttsKey,
        asrKey: current.asrKey === snapshot.asrKey ? "" : current.asrKey,
        tts: { ...current.tts, hasApiKey: next.tts.hasApiKey },
        asr: { ...current.asr, hasApiKey: next.asr.hasApiKey },
      };
      formRef.current = settled;
      setForm(settled);
    }
  }, []);

  const autosave = useAutoSave(save);

  const update = (apply: (prev: VoiceForm) => VoiceForm): void => {
    const prev = formRef.current;
    if (prev === null) return;
    const next = apply(prev);
    formRef.current = next;
    setForm(next);
    autosave.schedule(next);
  };

  const clearKey = (kind: VoiceKind): void => {
    const draft: VoiceSettingsDraft =
      kind === "tts" ? { tts: { apiKey: null } } : { asr: { apiKey: null } };
    void window.goodjob.voice
      .saveSettings(draft)
      .then((next) => {
        setSettings(next);
        // 清掉 Key 后官方列表也不再可信：回到「先配置 Key」的状态。
        setModelCatalog((prev) => ({
          ...prev,
          [kind]: { status: "idle", models: [], error: null },
        }));
        update((prev) =>
          kind === "tts"
            ? { ...prev, tts: { ...prev.tts, hasApiKey: false }, ttsKey: "" }
            : { ...prev, asr: { ...prev.asr, hasApiKey: false }, asrKey: "" },
        );
      })
      .catch((cause: unknown) => {
        setAsrNotice({ tone: "error", message: ipcErrorMessage(cause) });
      });
  };

  /** 模型列表来自百炼官方接口；调用前先 flush，保证用的是刚填的 Key / 域名。 */
  const loadModels = async (kind: VoiceKind): Promise<void> => {
    const seq = ++modelSeq.current[kind];
    setModelCatalog((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], status: "loading", error: null },
    }));
    try {
      await autosave.flush();
      const models = await window.goodjob.voice.listModels(kind);
      if (seq !== modelSeq.current[kind] || !mountedRef.current) return;
      setModelCatalog((prev) => ({ ...prev, [kind]: { status: "ready", models, error: null } }));
    } catch (cause) {
      if (seq !== modelSeq.current[kind] || !mountedRef.current) return;
      setModelCatalog((prev) => ({
        ...prev,
        [kind]: { ...prev[kind], status: "error", error: ipcErrorMessage(cause) },
      }));
    }
  };

  /** 音色列表优先读官方页面；读不到时 main 会回落到内置快照并带 warning。 */
  const loadVoices = async (model: string, force = false): Promise<void> => {
    if (!force) {
      const cached = voiceCache.current.get(model);
      if (cached !== undefined) {
        setVoiceCatalog({
          status: "ready",
          model,
          voices: cached.voices,
          warning: cached.warning,
          error: null,
        });
        return;
      }
    }
    const seq = ++voiceSeq.current;
    setVoiceCatalog((prev) => ({
      status: "loading",
      model,
      voices: prev.model === model ? prev.voices : [],
      warning: null,
      error: null,
    }));
    try {
      const catalog = await window.goodjob.voice.listVoices(model);
      if (seq !== voiceSeq.current || !mountedRef.current) return;
      voiceCache.current.set(model, { voices: catalog.voices, warning: catalog.warning });
      setVoiceCatalog({
        status: "ready",
        model,
        voices: catalog.voices,
        warning: catalog.warning,
        error: null,
      });
      // 音色还空着时选第一个，避免「模型有音色、表单却是空的」。
      const current = formRef.current;
      const first = catalog.voices[0];
      if (current !== null && current.tts.voice.trim() === "" && first !== undefined) {
        update((prev) => ({ ...prev, tts: { ...prev.tts, voice: first.id } }));
      }
    } catch (cause) {
      if (seq !== voiceSeq.current || !mountedRef.current) return;
      setVoiceCatalog({
        status: "error",
        model,
        voices: [],
        warning: null,
        error: ipcErrorMessage(cause),
      });
    }
  };

  // 配好 Key 的 tab 第一次打开时自动读模型列表；失败后不自动重试（右边有刷新）。
  useEffect(() => {
    if (form === null) return;
    const hasKey = tab === "tts" ? form.tts.hasApiKey : form.asr.hasApiKey;
    if (!hasKey || modelCatalog[tab].status !== "idle") return;
    void loadModels(tab);
  }, [tab, form?.tts.hasApiKey, form?.asr.hasApiKey]);

  // TTS 的模型一变就读它的音色列表（有缓存就直接用）。
  useEffect(() => {
    if (tab !== "tts" || form === null) return;
    const model = form.tts.model.trim();
    if (model === "") return;
    if (voiceCatalog.model === model && voiceCatalog.status !== "idle") return;
    void loadVoices(model);
  }, [tab, form?.tts.model]);

  const requestMic = async (): Promise<void> => {
    setMicBusy(true);
    try {
      // 只更新设置快照（带最新 microphone），不动表单里正在编辑的内容。
      setSettings(await window.goodjob.voice.requestMicrophone());
    } catch (cause) {
      setAsrNotice({ tone: "error", message: ipcErrorMessage(cause) });
    } finally {
      setMicBusy(false);
    }
  };

  const testAsr = async (): Promise<void> => {
    if (asrTesting) return;
    setAsrTesting(true);
    testingRef.current = true;
    setAsrNotice(null);
    try {
      // 自检用的是已存配置：先把还压在防抖里的 Key / 域名落盘。
      await autosave.flush();
      await window.goodjob.voice.startListening();
      // 没有 VAD：给用户 4 秒说完，再主动结束这一轮。
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const result = await window.goodjob.voice.stopListening();
      if (!mountedRef.current) return;
      const text = result.text.trim();
      setAsrNotice({
        tone: text === "" ? "error" : "ok",
        message:
          text === ""
            ? "没有识别到文字：再说一次，或检查系统麦克风权限。"
            : `识别结果：${text}`,
      });
    } catch (cause) {
      if (mountedRef.current) {
        setAsrNotice({ tone: "error", message: ipcErrorMessage(cause) });
      }
    } finally {
      testingRef.current = false;
      if (mountedRef.current) setAsrTesting(false);
    }
  };

  const preview = async (): Promise<void> => {
    setPreviewing(true);
    setPreviewNotice(null);
    try {
      // 先把还在防抖里的改动落盘：「试听」用的是已存配置。
      await autosave.flush();
      await window.goodjob.voice.preview(PREVIEW_TEXT);
      setPreviewNotice({ tone: "ok", message: "试听播放完了：音色与 Key 都能用。" });
    } catch (cause) {
      setPreviewNotice({ tone: "error", message: ipcErrorMessage(cause) });
    } finally {
      setPreviewing(false);
    }
  };

  if (loadError !== null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">语音模型</h1>
        <div className="mt-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }
  if (settings === null || form === null) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-lg font-semibold tracking-tight">语音模型</h1>
        <p className="mt-1 text-sm text-muted-foreground">正在读取语音配置…</p>
      </div>
    );
  }

  const ready = settings.ready;
  const mic = settings.microphone;
  const ttsVoices = voiceCatalog.model === form.tts.model ? voiceCatalog.voices : [];
  const currentVoice = ttsVoices.find((voice) => voice.id === form.tts.voice);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as VoiceKind)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="shrink-0 px-6 pt-6 pb-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold tracking-tight">语音模型</h1>
          <Badge variant={ready.interview ? "secondary" : "outline"} className="gap-1">
            {ready.interview ? (
              <>
                <CircleCheck className="size-3.5" />
                语音面试可用
              </>
            ) : (
              "未配置完"
            )}
          </Badge>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {autosave.state === "saving" || autosave.state === "pending"
              ? "保存中…"
              : autosave.state === "error"
                ? "未保存"
                : "已自动保存"}
          </span>
        </div>

        <TabsList className="mt-4 h-9 rounded-xl p-1">
          <TabsTrigger value="asr" className="h-full rounded-lg px-3">
            <Mic />
            语音识别
          </TabsTrigger>
          <TabsTrigger value="tts" className="h-full rounded-lg px-3">
            <AudioLines />
            语音合成
          </TabsTrigger>
        </TabsList>
      </div>

      {autosave.error !== null && (
        <div className="mx-6 mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{autosave.error}</span>
        </div>
      )}

      <TabsContent value="asr" className="flex min-h-0 flex-1 flex-col">
        <ProviderPane ready={ready.asr}>
          <ProviderHeading kind="asr" ready={ready.asr} />

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SlidersHorizontal className="size-3.5" />
              参数配置
            </div>
            <div className="divide-y rounded-xl border">
              <ConfigRow
                label="接入域名"
                htmlFor="voice-asr-endpoint"
                hint="与语音合成共用同一个业务空间域名：试用填 trial.cn-beijing.maas.aliyuncs.com，正式业务空间填 {WorkspaceId}.cn-beijing.maas.aliyuncs.com。"
              >
                <Input
                  id="voice-asr-endpoint"
                  spellCheck={false}
                  value={form.asr.endpoint}
                  placeholder="trial.cn-beijing.maas.aliyuncs.com"
                  onChange={(event) =>
                    update((prev) => ({
                      ...prev,
                      asr: { ...prev.asr, endpoint: event.target.value },
                    }))
                  }
                />
              </ConfigRow>
              <ConfigRow
                label="API Key"
                htmlFor="voice-asr-key"
                hint={
                  form.asr.hasApiKey
                    ? "已加密保存；留空保持不变。模型列表用这把 Key 读取。"
                    : "在百炼控制台创建，sk- 开头；保存后自动读取官方模型列表。"
                }
              >
                <ApiKeyInput
                  id="voice-asr-key"
                  hasKey={form.asr.hasApiKey}
                  value={form.asrKey}
                  onChange={(value) => update((prev) => ({ ...prev, asrKey: value }))}
                  onClear={() => clearKey("asr")}
                />
              </ConfigRow>
              <ConfigRow
                label="模型"
                htmlFor="voice-asr-model"
                hint={
                  customModel.asr
                    ? manualModelHint("asr")
                    : modelHint("asr", modelCatalog.asr, form.asr.hasApiKey)
                }
                hintError={!customModel.asr && modelCatalog.asr.status === "error"}
                hintAction={
                  <ManualModelToggle
                    custom={customModel.asr}
                    onToggle={() =>
                      setCustomModel((prev) => ({ ...prev, asr: !prev.asr }))
                    }
                  />
                }
              >
                <ModelSelect
                  id="voice-asr-model"
                  kind="asr"
                  value={form.asr.model}
                  catalog={modelCatalog.asr}
                  hasApiKey={form.asr.hasApiKey}
                  custom={customModel.asr}
                  onChange={(value) =>
                    update((prev) => ({ ...prev, asr: { ...prev.asr, model: value } }))
                  }
                  onRefresh={() => void loadModels("asr")}
                />
              </ConfigRow>
            </div>
          </section>

          <section className="rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">麦克风</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  只在「聆听」阶段打开；第一次采集时 macOS 会请求权限。
                </p>
              </div>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-[11px]",
                  mic === "granted" ? "text-muted-foreground" : "text-warning",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    mic === "granted" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                {microphoneLabel(mic)}
              </span>
              {mic !== "granted" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={micBusy}
                  onClick={() => void requestMic()}
                >
                  {micBusy ? "请求中…" : "请求权限"}
                </Button>
              )}
            </div>
            {(mic === "denied" || mic === "restricted") && (
              <p className="mt-2 text-[11px] leading-relaxed text-destructive">
                去 系统设置 → 隐私与安全性 → 麦克风 打开 GoodJob，再回来试。
              </p>
            )}

            <div className="mt-3 flex items-start gap-3 border-t pt-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">语音自检</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  点一下，说一句话；4 秒后自动结束并显示识别文本。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!ready.asr || asrTesting}
                onClick={() => void testAsr()}
              >
                {asrTesting ? <LoaderCircle className="animate-spin" /> : <Mic />}
                {asrTesting
                  ? voiceState?.phase === "connecting"
                    ? "等待授权…"
                    : "录音中…"
                  : "测试 4 秒"}
              </Button>
            </div>
            {asrTesting && voiceState?.interim !== undefined && voiceState.interim !== "" && (
              <p className="mt-2 break-words text-[11px] leading-relaxed text-muted-foreground">
                正在识别：{voiceState.interim}
              </p>
            )}
            {asrNotice !== null && (
              <p
                className={cn(
                  "mt-2 break-words text-[11px] leading-relaxed",
                  asrNotice.tone === "ok" ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {asrNotice.message}
              </p>
            )}
          </section>

          <EngineInfo settings={settings} />
        </ProviderPane>
      </TabsContent>

      <TabsContent value="tts" className="flex min-h-0 flex-1 flex-col">
        <ProviderPane ready={ready.tts}>
          <ProviderHeading kind="tts" ready={ready.tts} />

          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SlidersHorizontal className="size-3.5" />
              参数配置
            </div>
            <div className="divide-y rounded-xl border">
              <ConfigRow
                label="接入域名"
                htmlFor="voice-tts-endpoint"
                hint="与语音识别共用同一个业务空间域名：试用填 trial.cn-beijing.maas.aliyuncs.com，正式业务空间填 {WorkspaceId}.cn-beijing.maas.aliyuncs.com。"
              >
                <Input
                  id="voice-tts-endpoint"
                  spellCheck={false}
                  value={form.tts.endpoint}
                  placeholder="trial.cn-beijing.maas.aliyuncs.com"
                  onChange={(event) =>
                    update((prev) => ({
                      ...prev,
                      tts: { ...prev.tts, endpoint: event.target.value },
                    }))
                  }
                />
              </ConfigRow>
              <ConfigRow
                label="API Key"
                htmlFor="voice-tts-key"
                hint={
                  form.tts.hasApiKey
                    ? "已加密保存；留空保持不变。模型列表用这把 Key 读取。"
                    : "在百炼控制台创建，sk- 开头；保存后自动读取官方模型列表。"
                }
              >
                <ApiKeyInput
                  id="voice-tts-key"
                  hasKey={form.tts.hasApiKey}
                  value={form.ttsKey}
                  onChange={(value) => update((prev) => ({ ...prev, ttsKey: value }))}
                  onClear={() => clearKey("tts")}
                />
              </ConfigRow>
              <ConfigRow
                label="模型"
                htmlFor="voice-tts-model"
                hint={
                  customModel.tts
                    ? manualModelHint("tts")
                    : modelHint("tts", modelCatalog.tts, form.tts.hasApiKey)
                }
                hintError={!customModel.tts && modelCatalog.tts.status === "error"}
                hintAction={
                  <ManualModelToggle
                    custom={customModel.tts}
                    onToggle={() =>
                      setCustomModel((prev) => ({ ...prev, tts: !prev.tts }))
                    }
                  />
                }
              >
                <ModelSelect
                  id="voice-tts-model"
                  kind="tts"
                  value={form.tts.model}
                  catalog={modelCatalog.tts}
                  hasApiKey={form.tts.hasApiKey}
                  custom={customModel.tts}
                  onChange={(value) =>
                    update((prev) => ({ ...prev, tts: { ...prev.tts, model: value } }))
                  }
                  onRefresh={() => void loadModels("tts")}
                />
              </ConfigRow>

              <ConfigRow
                label="音色"
                htmlFor="voice-tts-voice"
                hint={voiceHint(voiceCatalog, form.tts.voice, form.tts.model, customVoice)}
                hintError={voiceCatalog.status === "error"}
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Select
                      value={customVoice ? CUSTOM_VOICE : form.tts.voice}
                      onValueChange={(value) => {
                        if (value === CUSTOM_VOICE) {
                          setCustomVoice(true);
                          return;
                        }
                        setCustomVoice(false);
                        update((prev) => ({ ...prev, tts: { ...prev.tts, voice: value } }));
                      }}
                    >
                      <SelectTrigger
                        id="voice-tts-voice"
                        className="min-w-0 flex-1"
                        aria-label="音色"
                      >
                        <SelectValue>
                          {customVoice
                            ? "手动输入音色 ID"
                            : currentVoice !== undefined
                              ? `${currentVoice.name} · ${currentVoice.id}`
                              : form.tts.voice === ""
                                ? "选择音色"
                                : form.tts.voice}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" align="start" className="max-h-80">
                        {voiceCatalog.status === "loading" && ttsVoices.length === 0 && (
                          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                            <LoaderCircle className="size-3.5 animate-spin" />
                            正在读取官方音色列表…
                          </div>
                        )}
                        {ttsVoices.map((voice) => (
                          <SelectItem key={voice.id} value={voice.id} className="py-2">
                            <span className="flex w-full min-w-0 max-w-[16rem] flex-col items-start gap-0.5">
                              <span className="w-full truncate text-sm">{voice.name}</span>
                              <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                                {voice.id}
                                {voice.description === "" ? "" : ` · ${voice.description}`}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                        {form.tts.voice !== "" &&
                          !customVoice &&
                          !ttsVoices.some((voice) => voice.id === form.tts.voice) && (
                            <SelectItem value={form.tts.voice} className="py-2">
                              <span className="flex w-full min-w-0 max-w-[16rem] flex-col items-start gap-0.5">
                                <span className="text-sm">当前音色</span>
                                <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                                  {form.tts.voice}
                                </span>
                              </span>
                            </SelectItem>
                          )}
                        <SelectItem value={CUSTOM_VOICE}>手动输入音色 ID…</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label="刷新音色列表"
                      title="从官方音色列表重新读取"
                      disabled={form.tts.model.trim() === "" || voiceCatalog.status === "loading"}
                      onClick={() => void loadVoices(form.tts.model.trim(), true)}
                    >
                      <RefreshCw
                        className={cn(voiceCatalog.status === "loading" && "animate-spin")}
                      />
                    </Button>
                  </div>
                  {customVoice && (
                    <Input
                      id="voice-tts-voice"
                      spellCheck={false}
                      value={form.tts.voice}
                      placeholder="例如声音复刻得到的音色 ID"
                      onChange={(event) =>
                        update((prev) => ({
                          ...prev,
                          tts: { ...prev.tts, voice: event.target.value },
                        }))
                      }
                    />
                  )}
                </div>
              </ConfigRow>
            </div>
          </section>

          <section className="rounded-xl border p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">语音自检</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  用已存配置朗读一句；只有真的收到音频帧才算成功。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!ready.tts || previewing}
                onClick={() => void preview()}
              >
                {previewing ? <LoaderCircle className="animate-spin" /> : <Play />}
                {previewing ? "合成中…" : "试听一句"}
              </Button>
            </div>
            {previewNotice !== null && (
              <p
                className={cn(
                  "mt-2 break-words text-[11px] leading-relaxed",
                  previewNotice.tone === "ok" ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {previewNotice.message}
              </p>
            )}
          </section>

          <EngineInfo settings={settings} />
        </ProviderPane>
      </TabsContent>
    </Tabs>
  );
}

function fromSettings(settings: VoiceSettingsState): VoiceForm {
  return {
    tts: {
      endpoint: settings.tts.endpoint,
      model: settings.tts.model,
      voice: settings.tts.voice,
      hasApiKey: settings.tts.hasApiKey,
    },
    asr: {
      endpoint: settings.asr.endpoint,
      model: settings.asr.model,
      hasApiKey: settings.asr.hasApiKey,
    },
    ttsKey: "",
    asrKey: "",
  };
}

function modelHint(
  kind: VoiceKind,
  catalog: ModelCatalogState,
  hasApiKey: boolean,
): string {
  if (catalog.status === "loading") return "正在从百炼读取模型列表…";
  if (catalog.status === "error") return catalog.error ?? "读取模型列表失败。";
  if (catalog.status === "ready") {
    if (catalog.models.length === 0) {
      return kind === "tts"
        ? "这个业务空间下没有实时语音合成模型，去百炼开通后再试。"
        : "这个业务空间下没有 AOQ 可用的实时语音识别模型，去百炼开通后再试。";
    }
    return `共 ${catalog.models.length} 个可用模型 · 来自百炼官方模型列表接口。`;
  }
  return hasApiKey
    ? "点右侧刷新，从百炼读取官方模型列表。"
    : "先填 API Key，保存后自动读取官方模型列表。";
}

function voiceHint(
  catalog: VoiceCatalogState,
  current: string,
  model: string,
  custom: boolean,
): string {
  if (custom) return "手填音色 ID 仅用于声音复刻等自定义音色；官方音色请从列表选。";
  if (catalog.status === "loading") return "正在读取官方音色列表…";
  if (catalog.status === "error") return catalog.error ?? "读取音色列表失败。";
  if (catalog.status === "ready") {
    if (catalog.voices.length === 0) return "官方音色列表里没有这个模型的系统音色，可手动输入音色 ID。";
    const known = catalog.voices.some((voice) => voice.id === current);
    const source =
      catalog.warning === null
        ? "来自百炼官方音色列表。"
        : catalog.warning;
    const mismatch =
      current !== "" && !known
        ? ` 当前音色不在 ${model} 的官方列表里，试听会失败，建议换一个。`
        : "";
    return `共 ${catalog.voices.length} 个音色 · ${source}${mismatch}`;
  }
  return "选好模型后自动读取官方音色列表。";
}

function microphoneLabel(access: VoiceSettingsState["microphone"]): string {
  switch (access) {
    case "granted":
      return "已授权";
    case "denied":
      return "被拒绝";
    case "restricted":
      return "受限";
    case "not-determined":
      return "未询问";
    default:
      return "未知";
  }
}

/**
 * 一个 tab 的主体：左边供应商列表，右边选中供应商的参数。
 * 供应商目前只有阿里云百炼一个，列表按「将来会多」的形状保留。
 */
function ProviderPane({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 border-t">
      <aside className="flex w-40 shrink-0 flex-col border-r bg-muted/30">
        <div className="flex h-10 items-center px-4 text-xs text-muted-foreground">供应商</div>
        <div className="px-2">
          <div className="flex w-full items-center gap-2 rounded-lg bg-accent px-2 py-1.5 text-left text-sm font-medium text-accent-foreground">
            <img src={bailianLogo} alt="" className="size-5 shrink-0" />
            <span className="truncate">阿里云百炼</span>
            <span
              aria-hidden="true"
              className={cn(
                "ml-auto size-1.5 shrink-0 rounded-full",
                ready ? "bg-emerald-500" : "bg-muted-foreground/40",
              )}
            />
          </div>
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

function ProviderHeading({ kind, ready }: { kind: VoiceKind; ready: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <img src={bailianLogo} alt="阿里云百炼" className="size-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">阿里云百炼</h2>
          <Badge variant="secondary" className="text-[10px]">
            实时流式
          </Badge>
          {ready ? (
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <CircleCheck className="size-3" />
              已配置
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              待配置
            </Badge>
          )}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
          <span>{kind === "asr" ? "语音识别 · 边说边出字" : "语音合成 · 面试官开口说话"}</span>
          <span className="opacity-50">·</span>
          <span>接入 AOQ 实时语音</span>
          <span className="opacity-50">·</span>
          <ExternalLink href={BAILIAN_API_KEYS}>API Key 获取</ExternalLink>
          <span className="opacity-50">·</span>
          <ExternalLink href={BAILIAN_CONSOLE}>百炼控制台</ExternalLink>
        </p>
      </div>
    </div>
  );
}

function ConfigRow({
  label,
  htmlFor,
  hint,
  hintError = false,
  hintAction,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  hintError?: boolean;
  /** 提示行右侧的小动作（例如「手动输入模型 ID」）。 */
  hintAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.75rem_1fr] items-start gap-3 px-4 py-3">
      <Label htmlFor={htmlFor} className="pt-1.5 text-sm font-medium">
        {label}
      </Label>
      <div className="grid gap-1.5">
        {children}
        {(hint !== undefined || hintAction !== undefined) && (
          <div className="flex items-start justify-between gap-2">
            {hint !== undefined && (
              <p
                className={cn(
                  "min-w-0 flex-1 text-[11px] leading-relaxed",
                  hintError ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {hint}
              </p>
            )}
            {hintAction !== undefined && <span className="shrink-0">{hintAction}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** 模型下拉旁边的「手动输入 / 从官方列表选择」切换。 */
function ManualModelToggle({ custom, onToggle }: { custom: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
      onClick={onToggle}
    >
      {custom ? "从官方列表选择" : "手动输入模型 ID"}
    </button>
  );
}

function manualModelHint(kind: VoiceKind): string {
  return kind === "tts"
    ? "手动填写的模型 ID 会原样发给百炼；AOQ 可用的是 qwen-audio-3.1 / 3.0 的 tts-plus / tts-flash。"
    : "手动填写的模型 ID 会原样发给百炼；AOQ 需要 qwen-audio 的实时流式模型。";
}

function ModelSelect({
  id,
  kind,
  value,
  catalog,
  hasApiKey,
  custom,
  onChange,
  onRefresh,
}: {
  id: string;
  kind: VoiceKind;
  value: string;
  catalog: ModelCatalogState;
  hasApiKey: boolean;
  /** 手动输入模式：下拉换成文本框（没有 Key 也能填）。 */
  custom: boolean;
  onChange: (value: string) => void;
  onRefresh: () => void;
}) {
  const options = catalog.models;
  const missing = value.trim() !== "" && !options.some((model) => model.id === value);
  const refresh = (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="刷新模型列表"
      title="从百炼官方接口读取模型列表"
      disabled={!hasApiKey || catalog.status === "loading"}
      onClick={onRefresh}
    >
      <RefreshCw className={cn(catalog.status === "loading" && "animate-spin")} />
    </Button>
  );

  if (custom) {
    return (
      <div className="flex items-center gap-2">
        <Input
          id={id}
          spellCheck={false}
          className="flex-1"
          value={value}
          placeholder="手动填写模型 ID"
          onChange={(event) => onChange(event.target.value)}
        />
        {refresh}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={onChange} disabled={!hasApiKey}>
        <SelectTrigger
          id={id}
          className="min-w-0 flex-1"
          aria-label={kind === "tts" ? "语音合成模型" : "语音识别模型"}
        >
          <SelectValue>
            {value === "" ? (hasApiKey ? "选择模型" : "先配置 API Key") : value}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start" className="max-h-72">
          {options.map((model) => (
            <SelectItem key={model.id} value={model.id} className="py-2">
              <span className="flex w-full min-w-0 max-w-[16rem] flex-col items-start gap-0.5">
                <span className="w-full truncate text-sm">{model.name}</span>
                <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                  {model.id}
                </span>
              </span>
            </SelectItem>
          ))}
          {missing && (
            <SelectItem value={value} className="py-2">
              <span className="flex w-full min-w-0 max-w-[16rem] flex-col items-start gap-0.5">
                <span className="text-sm">当前配置</span>
                <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                  {value}
                </span>
              </span>
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {refresh}
    </div>
  );
}

function ApiKeyInput({
  id,
  hasKey,
  value,
  onChange,
  onClear,
}: {
  id: string;
  hasKey: boolean;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="flex-1"
        value={value}
        placeholder={hasKey ? "已保存，留空保持不变" : "sk-..."}
        onChange={(event) => onChange(event.target.value)}
      />
      {hasKey && (
        <Button type="button" size="sm" variant="outline" onClick={onClear}>
          清除
        </Button>
      )}
    </div>
  );
}

function EngineInfo({ settings }: { settings: VoiceSettingsState }) {
  return (
    <div className="rounded-xl bg-muted/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
      <p>
        语音引擎：AOQ（阿里云实时多模态 SDK）{settings.sdkVersion ?? "未加载"}
        {settings.sdkError !== null && <span className="text-destructive"> · {settings.sdkError}</span>}
      </p>
      <p className="mt-0.5">
        配置文件：<code>~/.goodjob/voice.json</code>（0600，Key 为 safeStorage 密文）。
        录音不落盘，识别文本随面试对话一起保存。
      </p>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="underline underline-offset-2 hover:text-foreground"
      onClick={(event) => {
        event.preventDefault();
        void window.goodjob.app.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
