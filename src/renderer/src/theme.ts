import type { ThemeMode } from "@shared/types";

/** 主题偏好 → 当前是否深色（系统模式交给系统偏好决定）。 */
export function resolveDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemPrefersDark;
}
