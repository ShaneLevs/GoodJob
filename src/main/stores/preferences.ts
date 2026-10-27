import fs from "node:fs";

import type { AppearanceSettings, ThemeMode } from "@shared/types";

import { createRootPaths, writeJsonFile, type RootPaths } from "../workspace/paths";

const VERSION = 1;
const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 18;

interface PreferencesDoc {
  version: number;
  appearance: AppearanceSettings;
}

const DEFAULTS: AppearanceSettings = { themeMode: "system", fontSize: 13 };

/**
 * 机器级偏好（`~/.goodjob/preferences.json`，0600）。
 * 主题和字号是"这个人对这台机器的偏好"，切工作区不该跟着变，所以不放进工作区目录。
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

  saveAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
    this.doc = {
      ...this.doc,
      appearance: normalize({ ...this.doc.appearance, ...patch }),
    };
    writeJsonFile(this.root.preferences, this.doc);
    return this.doc.appearance;
  }

  private read(): PreferencesDoc {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.root.preferences, "utf8"));
      const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const appearance = typeof record.appearance === "object" && record.appearance !== null
        ? (record.appearance as Record<string, unknown>)
        : {};
      return {
        version: VERSION,
        appearance: normalize({
          themeMode: appearance.themeMode as ThemeMode | undefined,
          fontSize: typeof appearance.fontSize === "number" ? appearance.fontSize : undefined,
        }),
      };
    } catch {
      return { version: VERSION, appearance: { ...DEFAULTS } };
    }
  }
}

function normalize(input: Partial<AppearanceSettings>): AppearanceSettings {
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
