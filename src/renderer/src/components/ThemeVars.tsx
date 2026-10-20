import { useLayoutEffect } from "react";

import { theme } from "antd";

/**
 * 颜色的唯一来源是 antd 的 design token。
 *
 * antd 自己的组件（Button / Menu / Modal …）天然跟随主题：切深色只是换 `darkAlgorithm`，
 * 组件重新算一遍 token，不用我们管。但我们自绘的壳层、卡片、侧栏用的是普通 CSS，
 * 拿不到组件级 token，所以这里把 token 写成 `:root` 的 CSS 变量下发——
 * 深色模式下这些变量会自动变成深色算法算出来的值，不需要再手写两套颜色。
 */
export function ThemeVars({ dark }: { dark: boolean }) {
  const { token } = theme.useToken();

  // layout effect：保证首帧就是正确颜色，不会先闪一下浅色。
  useLayoutEffect(() => {
    const root = document.documentElement;
    const set = (name: string, value: string): void => root.style.setProperty(name, value);

    // 背景与分隔
    set("--shell-bg", token.colorBgLayout);
    // 卡片是浮在画布上的"更高一层"，深色下要更亮，所以用 elevated 而不是 container。
    set("--surface-bg", token.colorBgElevated);
    set("--panel-bg", token.colorFillQuaternary);
    set("--nav-bg", token.colorFillQuaternary);
    set("--hairline", token.colorBorderSecondary);
    set("--surface-shadow", token.boxShadowTertiary ?? token.boxShadowSecondary);

    // 文本阶梯
    set("--text-strong", token.colorText);
    set("--text-body", token.colorTextSecondary);
    set("--text-muted", token.colorTextTertiary);
    set("--text-faint", token.colorTextQuaternary);

    // 交互底色
    set("--subtle-bg", token.colorFillTertiary);
    set("--hover-bg", token.colorFillSecondary);
    set("--active-bg", token.colorFill);
    set("--focus-ring", token.colorBorder);
    set("--scroll-thumb", token.colorFill);

    // 语义色
    set("--status-on", token.colorSuccess);
    set("--status-warn", token.colorWarning);
    set("--status-off", token.colorTextQuaternary);

    // 字号也来自 token（buildTheme 把"界面字号"设成 fontSize）。
    set("--font-base", `${token.fontSize}px`);

    // 让原生控件（滚动条、输入光标）也用对明暗。
    root.style.colorScheme = dark ? "dark" : "light";
  }, [token, dark]);

  return null;
}
