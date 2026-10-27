import { useLayoutEffect } from "react";

interface ThemeApplierProps {
  dark: boolean;
  /** 界面字号（px）。globals.css 里的 `--text-*` 刻度都以它为基准。 */
  fontSize: number;
}

/**
 * 主题的唯一真值源是 `<html>` 上的 `.dark` class 与 `--font-base` 变量。
 *
 * antd 时代这里要把 design token 逐个映射成 CSS 变量；现在 token 本身就在
 * globals.css 里，组件只认 tailwind 的 `bg-background` / `text-foreground` 这一套，
 * 所以深浅色切换只剩一次 class 开关。
 */
export function ThemeApplier({ dark, fontSize }: ThemeApplierProps) {
  // layout effect：首帧就是正确颜色，不会先闪一下浅色。
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.setProperty("--font-base", `${fontSize}px`);
  }, [dark, fontSize]);

  return null;
}
