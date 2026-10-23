import { Monitor, Moon, Sun } from "lucide-react";

import type { AppearanceSettings as AppearanceSettingsValue, ThemeMode } from "@shared/types";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AppearanceSettingsProps {
  appearance: AppearanceSettingsValue;
  onChange: (patch: Partial<AppearanceSettingsValue>) => void;
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "跟随系统", icon: <Monitor /> },
  { value: "light", label: "浅色", icon: <Sun /> },
  { value: "dark", label: "深色", icon: <Moon /> },
];

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 18;

export function AppearanceSettings({ appearance, onChange }: AppearanceSettingsProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <h1 className="text-lg font-semibold tracking-tight">外观</h1>
      <p className="mt-1 text-sm text-muted-foreground">设置应用主题和界面文字大小。</p>

      <div className="mt-6 divide-y rounded-xl border">
        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <Label className="text-sm font-medium">界面主题</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              选择浅色、深色或跟随系统主题。
            </p>
          </div>
          <Select
            value={appearance.themeMode}
            onValueChange={(value) => onChange({ themeMode: value as ThemeMode })}
          >
            <SelectTrigger className="w-44" aria-label="界面主题">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEME_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex items-center gap-2 text-sm">
                    {option.icon}
                    {option.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-6 p-4">
          <div className="min-w-0">
            <Label htmlFor="font-size" className="text-sm font-medium">
              界面字号
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              调整应用界面的文字大小（{FONT_SIZE_MIN}–{FONT_SIZE_MAX}px），图标与布局尺寸不变。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              id="font-size"
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              value={appearance.fontSize}
              className="w-20 text-right"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                onChange({
                  fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value))),
                });
              }}
            />
            <span className="text-xs text-muted-foreground">px</span>
          </div>
        </div>
      </div>
    </div>
  );
}
