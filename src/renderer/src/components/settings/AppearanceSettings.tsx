import { DesktopOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { InputNumber, Select } from "antd";

import type { AppearanceSettings, ThemeMode } from "@shared/types";

interface AppearanceSettingsProps {
  appearance: AppearanceSettings;
  onChange: (patch: Partial<AppearanceSettings>) => void;
}

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 18;

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "系统", icon: <DesktopOutlined /> },
  { value: "light", label: "浅色", icon: <SunOutlined /> },
  { value: "dark", label: "深色", icon: <MoonOutlined /> },
];

export function AppearanceSettings({ appearance, onChange }: AppearanceSettingsProps) {
  return (
    <div className="settings-page">
      <h1 className="settings-page-title">外观</h1>

      <section className="settings-group">
        <h2 className="settings-group-title">界面设置</h2>
        <p className="settings-group-desc">设置应用主题和界面文字大小。</p>

        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">界面主题</div>
              <div className="settings-row-desc">选择浅色、深色或跟随系统主题。</div>
            </div>
            <Select
              className="settings-row-control settings-theme-select"
              value={appearance.themeMode}
              options={THEME_OPTIONS.map((option) => ({
                value: option.value,
                label: (
                  <span className="settings-option">
                    {option.icon}
                    {option.label}
                  </span>
                ),
              }))}
              onChange={(themeMode: ThemeMode) => onChange({ themeMode })}
            />
          </div>

          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">界面字号</div>
              <div className="settings-row-desc">调整应用界面的文字大小，图标和布局尺寸不受影响。</div>
            </div>
            <InputNumber
              className="settings-row-control settings-size-input"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              suffix="px"
              value={appearance.fontSize}
              onChange={(value) => {
                if (typeof value !== "number") return;
                onChange({ fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value)) });
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
