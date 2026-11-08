import fs from "node:fs";

import {
  DEFAULT_MARKDOWN_THEME_ID,
  type AppearanceSettings,
  type MarkdownSettings,
  type ThemeMode,
  type UpdatePreferences,
} from "@shared/types";

import { createRootPaths, writeJsonFile, type RootPaths } from "../workspace/paths";

const VERSION = 1;
const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 18;

interface PreferencesDoc {
  version: number;
  appearance: AppearanceSettings;
  markdown: MarkdownSettings;
  updates: UpdatePreferences;
}

const DEFAULTS: AppearanceSettings = { themeMode: "system", fontSize: 13 };
const MARKDOWN_DEFAULTS: MarkdownSettings = { themeId: DEFAULT_MARKDOWN_THEME_ID };
const UPDATE_DEFAULTS: UpdatePreferences = { autoCheck: true };

/**
 * 机器级偏好（`~/.goodjob/preferences.json`，0600）。
 * 界面主题 / 字号 / 文档预览的 Markdown 主题都是"这个人对这台机器的偏好"，
 * 切工作区不该跟着变，所以不放进工作区目录。
 */
export class PreferencesStore {
  readonly root: RootPaths;
  private doc: PreferencesDoc;

  constructor() {
    this.root = createRootPaths();
    this.doc = this.read();
  }

  get appearance(): AppearanceSettings {
    return this.doc.appearance;
  }

  get markdown(): MarkdownSettings {
    return this.doc.markdown;
  }

  get updates(): UpdatePreferences {
    return this.doc.updates;
  }

  saveAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
    this.doc = {
      ...this.doc,
      appearance: normalizeAppearance({ ...this.doc.appearance, ...patch }),
    };
    writeJsonFile(this.root.preferences, this.doc);
    return this.doc.appearance;
  }

  saveMarkdown(patch: Partial<MarkdownSettings>): MarkdownSettings {
    this.doc = {
      ...this.doc,
      markdown: normalizeMarkdown({ ...this.doc.markdown, ...patch }),
    };
    writeJsonFile(this.root.preferences, this.doc);
    return this.doc.markdown;
  }

  saveUpdates(patch: Partial<UpdatePreferences>): UpdatePreferences {
    this.doc = {
      ...this.doc,
      updates: normalizeUpdates({ ...this.doc.updates, ...patch }),
    };
    writeJsonFile(this.root.preferences, this.doc);
    return this.doc.updates;
  }

  private read(): PreferencesDoc {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.root.preferences, "utf8"));
      const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const appearance = typeof record.appearance === "object" && record.appearance !== null
        ? (record.appearance as Record<string, unknown>)
        : {};
      const markdown = typeof record.markdown === "object" && record.markdown !== null
        ? (record.markdown as Record<string, unknown>)
        : {};
      const updates = typeof record.updates === "object" && record.updates !== null
        ? (record.updates as Record<string, unknown>)
        : {};
      return {
        version: VERSION,
        appearance: normalizeAppearance({
          themeMode: appearance.themeMode as ThemeMode | undefined,
          fontSize: typeof appearance.fontSize === "number" ? appearance.fontSize : undefined,
        }),
        markdown: normalizeMarkdown({
          themeId: typeof markdown.themeId === "string" ? markdown.themeId : undefined,
        }),
        updates: normalizeUpdates({
          autoCheck: typeof updates.autoCheck === "boolean" ? updates.autoCheck : undefined,
        }),
      };
    } catch {
      return {
        version: VERSION,
        appearance: { ...DEFAULTS },
        markdown: { ...MARKDOWN_DEFAULTS },
        updates: { ...UPDATE_DEFAULTS },
      };
    }
  }
}

function normalizeAppearance(input: Partial<AppearanceSettings>): AppearanceSettings {
  const mode = input.themeMode;
  const size = input.fontSize;
  return {
    themeMode: mode !== undefined && THEME_MODES.includes(mode) ? mode : DEFAULTS.themeMode,
    fontSize:
      typeof size === "number" && Number.isFinite(size)
        ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
        : DEFAULTS.fontSize,
  };
}

/**
 * 主题 id 的合法性由渲染层模板注册表兜底（未知 id 回退默认），main 只保证是非空字符串。
 * 这样新增模板只需要渲染层加一份 CSS + 一行登记。
 */
function normalizeMarkdown(input: Partial<MarkdownSettings>): MarkdownSettings {
  const themeId = input.themeId?.trim();
  return {
    themeId: themeId !== undefined && themeId !== "" ? themeId : MARKDOWN_DEFAULTS.themeId,
  };
}

function normalizeUpdates(input: Partial<UpdatePreferences>): UpdatePreferences {
  return {
    autoCheck:
      typeof input.autoCheck === "boolean" ? input.autoCheck : UPDATE_DEFAULTS.autoCheck,
  };
}
