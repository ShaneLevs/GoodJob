import { useCallback, useEffect, useRef, useState } from "react";

import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import {
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { MenuProps } from "antd";

import type {
  ModelEntry,
  ModelsConfig,
  ProviderConfig,
  ProviderDraft,
  PublicProvider,
} from "@shared/types";

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
  const { message } = AntdApp.useApp();

  const [providers, setProviders] = useState<ProviderEdit[]>(() => models.providers.map(toEdit));
  const [selectedId, setSelectedId] = useState<string | null>(
    () => models.providers[0]?.id ?? null,
  );
  const [editingModel, setEditingModel] = useState<{
    providerId: string;
    model: ModelEntry | null;
  } | null>(null);

  const provider = providers.find((item) => item.id === selectedId) ?? null;

  /*
   * 实时保存：本地 draft 先落 state（输入才不卡），停手 AUTOSAVE_MS 后落盘。
   * 落盘结果只回填"服务端才能知道"的字段（hasApiKey、已存 Key 的 settling），
   * 不回写整份 providers，否则用户正在输入的框会被打断。
   */
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const persist = useCallback(async (): Promise<void> => {
    if (validate(providersRef.current) !== null) return;
    try {
      const next = await window.goodjob.models.save({
        providers: providersRef.current.map(toDraft),
      });
      if (!mountedRef.current) return;
      setProviders((prev) =>
        prev.map((item) => {
          const saved = next.providers.find((entry) => entry.id === item.id);
          if (saved === undefined) return item;
          const keySettled = typeof item.apiKey === "string" && item.apiKey.trim() !== "";
          return { ...item, hasApiKey: saved.hasApiKey, apiKey: keySettled ? undefined : item.apiKey };
        }),
      );
      onSaved(next);
    } catch (error) {
      if (mountedRef.current) {
        void message.error(error instanceof Error ? error.message : "保存失败");
      }
    }
  }, [message, onSaved]);

  const scheduleSave = useCallback((): void => {
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
      // 半截的非法输入（比如 Base URL 刚被清空）不落盘，保留上一次的有效状态。
      if (validate(providersRef.current) !== null) return;
      void window.goodjob.models
        .save({ providers: providersRef.current.map(toDraft) })
        .then((next) => onSavedRef.current(next));
    },
    [],
  );

  const patchProvider = (id: string, patch: Partial<ProviderEdit>): void => {
    setProviders((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    scheduleSave();
  };

  const patchModel = (providerId: string, models2: ModelEntry[]): void => {
    patchProvider(providerId, { models: models2 });
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

  const addProviderMenu: MenuProps = {
    items: PROVIDER_PRESETS.map((preset) => ({ key: preset.key, label: preset.label })),
    onClick: ({ key }) => addProvider(key),
  };

  return (
    <div className="settings-page settings-page-flush">
      <h1 className="settings-page-title">模型设置</h1>

      <div className="settings-models-body">
      <div className="settings-side">
        <div className="settings-side-head">
          <Typography.Text type="secondary" className="settings-side-label">
            供应商
          </Typography.Text>
          <Dropdown menu={addProviderMenu} trigger={["click"]} placement="bottomRight">
            <Tooltip title="添加供应商">
              <Button type="text" size="small" icon={<PlusOutlined />} aria-label="添加供应商" />
            </Tooltip>
          </Dropdown>
        </div>

        <div className="settings-provider-list">
          {providers.map((item) => {
            const status = providerStatus(item);
            return (
              <button
                key={item.id}
                type="button"
                className={`settings-provider${item.id === selectedId ? " settings-provider-active" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <span className="settings-provider-name">{item.name || "未命名供应商"}</span>
                <Tooltip title={status.label}>
                  <span className={`settings-status settings-status-${status.tone}`} />
                </Tooltip>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-main">
        <div className="settings-provider-detail">
          {providers.length === 0 ? (
            <div className="settings-provider-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有供应商">
                <Dropdown menu={addProviderMenu} trigger={["click"]}>
                  <Button type="primary" icon={<PlusOutlined />}>
                    添加供应商
                  </Button>
                </Dropdown>
              </Empty>
            </div>
          ) : provider === null ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="选择一个供应商"
              style={{ margin: "48px 0" }}
            />
          ) : (
            <ProviderForm
              key={provider.id}
              provider={provider}
              canStoreKey={models.canStoreKey}
              onChange={(patch) => patchProvider(provider.id, patch)}
              onModelsChange={(models2) => patchModel(provider.id, models2)}
              onRemove={() => removeProvider(provider.id)}
              onAddModel={() => setEditingModel({ providerId: provider.id, model: null })}
              onEditModel={(model) => setEditingModel({ providerId: provider.id, model })}
            />
          )}
        </div>
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
          const exists = target.models.some(
            (item) => item.id === entry.id && item.id !== editingModel.model?.id,
          );
          if (exists) {
            void message.error("这个供应商里已经有同名模型了");
            return;
          }
          const next =
            editingModel.model === null
              ? [...target.models, entry]
              : target.models.map((item) =>
                  item.id === editingModel.model?.id ? entry : item,
                );
          patchModel(editingModel.providerId, next);
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
  onModelsChange: (models: ModelEntry[]) => void;
  onRemove: () => void;
  onAddModel: () => void;
  onEditModel: (model: ModelEntry) => void;
}

function ProviderForm({
  provider,
  canStoreKey,
  onChange,
  onModelsChange,
  onRemove,
  onAddModel,
  onEditModel,
}: ProviderFormProps) {
  const pendingKey = provider.apiKey;

  return (
    <Form layout="vertical" className="settings-form settings-form-card">
      <Flex align="center" gap={12} className="settings-provider-head">
        <Input
          className="settings-provider-title"
          variant="borderless"
          value={provider.name}
          placeholder="供应商名称"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <Tooltip title={provider.enabled ? "停用这个供应商" : "启用这个供应商"}>
          <Switch
            checked={provider.enabled}
            onChange={(checked) => onChange({ enabled: checked })}
          />
        </Tooltip>
        <Popconfirm
          title="删除这个供应商？"
          description="它的模型和已保存的 API Key 会一起删除。"
          okText="删除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={onRemove}
        >
          <Button type="text" danger icon={<DeleteOutlined />} aria-label="删除供应商" />
        </Popconfirm>
      </Flex>

      <Form.Item label="Base URL" required style={{ marginBottom: 16 }}>
        <Input
          spellCheck={false}
          value={provider.baseURL}
          placeholder="https://api.openai.com/v1"
          onChange={(event) => onChange({ baseURL: event.target.value })}
        />
      </Form.Item>

      <Form.Item label="API 格式" style={{ marginBottom: 16 }}>
        <Select
          value={provider.protocol}
          options={PROTOCOL_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          optionRender={(option) => {
            const hint = PROTOCOL_OPTIONS.find((item) => item.value === option.value)?.hint;
            return (
              <Flex vertical>
                <span>{option.label}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {hint}
                </Typography.Text>
              </Flex>
            );
          }}
          onChange={(value) => onChange({ protocol: value })}
        />
      </Form.Item>

      <Form.Item label="API Key" style={{ marginBottom: 16 }}>
        <Flex gap={8}>
          <Input.Password
            className="settings-key-input"
            autoComplete="off"
            spellCheck={false}
            visibilityToggle
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
            <Button onClick={() => onChange({ apiKey: null })}>清除</Button>
          )}
        </Flex>
        <Typography.Text
          type={canStoreKey ? "secondary" : "warning"}
          className="settings-hint"
        >
          {canStoreKey
            ? "使用本地模型时可以留空。"
            : "当前系统无法保存 API Key，使用本地模型时可以直接留空。"}
        </Typography.Text>
      </Form.Item>

      <Flex justify="space-between" align="center" className="settings-models-head">
        <Typography.Text strong>模型列表</Typography.Text>
        <Button size="small" icon={<PlusOutlined />} onClick={onAddModel}>
          添加模型
        </Button>
      </Flex>

      {provider.models.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有模型，先添加一个"
          style={{ margin: "16px 0" }}
        />
      ) : (
        <div className="settings-model-list">
          {provider.models.map((model) => (
            <div key={model.id} className="settings-model-row">
              <span className="settings-model-name" title={model.name || model.id}>
                {model.name || model.id}
              </span>
              {model.contextWindow !== undefined && (
                <Tag className="settings-model-tag">{formatContext(model.contextWindow)}</Tag>
              )}
              {model.vision === true && <Tag className="settings-model-tag">视觉</Tag>}
              {model.reasoning === true && <Tag className="settings-model-tag">推理</Tag>}
              <span className="settings-model-spacer" />
              <Switch
                size="small"
                checked={model.enabled}
                onChange={(checked) =>
                  onModelsChange(
                    provider.models.map((item) =>
                      item.id === model.id ? { ...item, enabled: checked } : item,
                    ),
                  )
                }
              />
              <Tooltip title="编辑">
                <Button
                  type="text"
                  size="small"
                  aria-label="编辑模型"
                  icon={<EditOutlined />}
                  onClick={() => onEditModel(model)}
                />
              </Tooltip>
              <Popconfirm
                title="删除这个模型？"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() =>
                  onModelsChange(provider.models.filter((item) => item.id !== model.id))
                }
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label="删除模型"
                  icon={<DeleteOutlined />}
                />
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
    </Form>
  );
}

interface ModelFormValues {
  id: string;
  name?: string;
  contextWindow?: number | null;
  vision?: boolean;
  reasoning?: boolean;
  enabled?: boolean;
}

interface ModelEditorProps {
  open: boolean;
  model: ModelEntry | null;
  onCancel: () => void;
  onSubmit: (model: ModelEntry) => void;
}

function ModelEditor({ open, model, onCancel, onSubmit }: ModelEditorProps) {
  const [form] = Form.useForm<ModelFormValues>();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      id: model?.id ?? "",
      name: model?.name ?? "",
      contextWindow: model?.contextWindow ?? null,
      vision: model?.vision === true,
      reasoning: model?.reasoning === true,
      enabled: model?.enabled !== false,
    });
  }, [open, model, form]);

  return (
    <Modal open={open} title={model === null ? "添加模型" : "编辑模型"} onCancel={onCancel} onOk={() => form.submit()} okText="保存" cancelText="取消" destroyOnHidden width={440}>
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) =>
          onSubmit({
            id: values.id.trim(),
            name: (values.name ?? "").trim() === "" ? values.id.trim() : (values.name ?? "").trim(),
            enabled: values.enabled !== false,
            contextWindow:
              typeof values.contextWindow === "number" && values.contextWindow > 0
                ? values.contextWindow
                : undefined,
            vision: values.vision === true,
            reasoning: values.reasoning === true,
          })
        }
      >
        <Form.Item
          label="模型 ID"
          name="id"
          extra="请求里 model 字段的值，例如 gpt-4o、claude-sonnet-4-5。"
          rules={[{ required: true, message: "请填写模型 ID" }]}
        >
          <Input spellCheck={false} placeholder="模型 ID" />
        </Form.Item>
        <Form.Item label="显示名称" name="name" extra="留空则与模型 ID 相同。">
          <Input spellCheck={false} placeholder="可选" />
        </Form.Item>
        <Form.Item label="上下文窗口" name="contextWindow" extra="只用于界面标记，单位 token。">
          <InputNumber min={1} step={1000} style={{ width: "100%" }} placeholder="例如 128000" />
        </Form.Item>
        <Flex gap={24}>
          <Form.Item label="视觉输入" name="vision" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item label="推理模型" name="reasoning" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch size="small" />
          </Form.Item>
        </Flex>
      </Form>
    </Modal>
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
    contextWindow: preset.contextWindow,
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

/** Hosts whose official endpoint always rejects a keyless request. */
const OFFICIAL_HOSTS = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|deepseek\.com|openrouter\.ai)$/i;

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

function validate(providers: ProviderEdit[]): string | null {
  for (const provider of providers) {
    if (provider.name.trim() === "") return "请填写供应商名称。";
    if (provider.baseURL.trim() === "") return `供应商「${provider.name}」还没有填 Base URL。`;
    if (!isHttpUrl(provider.baseURL)) return `供应商「${provider.name}」的 Base URL 不是合法地址。`;
    if (provider.models.length === 0) return `供应商「${provider.name}」至少需要一个模型。`;
    const ids = new Set<string>();
    for (const model of provider.models) {
      if (model.id.trim() === "") return `供应商「${provider.name}」里有模型缺少 ID。`;
      if (ids.has(model.id)) return `供应商「${provider.name}」里有重复的模型 ID：${model.id}`;
      ids.add(model.id);
    }
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
