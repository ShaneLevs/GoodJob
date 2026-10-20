import { theme as antdTheme, type ThemeConfig } from "antd";

import type { ThemeMode } from "@shared/types";

/** 近黑的主色在深色下会消失，所以深色用反相的中性色。 */
const LIGHT_TEXT = "#1f2328";
const DARK_TEXT = "rgba(255, 255, 255, 0.92)";

/**
 * 主题与字号都是配置出来的：字号走 antd 的 `fontSize` token，
 * 主题在系统跟随/浅色/深色之间切换（`resolveDark` 由调用方按系统偏好算）。
 */
export function buildTheme(options: { dark: boolean; fontSize: number }): ThemeConfig {
  const { dark, fontSize } = options;
  const text = dark ? DARK_TEXT : LIGHT_TEXT;
  const surface = dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)";
  const surfaceHover = dark ? "rgba(255, 255, 255, 0.09)" : "rgba(0, 0, 0, 0.04)";
  const subtle = dark ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.45)";
  const body = dark ? "rgba(255, 255, 255, 0.7)" : "rgba(0, 0, 0, 0.72)";
  /*
   * 分栏拖拽线的各状态色。antd 默认从 colorPrimary 推导，而我们的主色是近黑（深色下近白），
   * 于是 hover / 拖动两张卡片之间的 2px 分割条时会显出一条黑（白）竖线。
   * 这里压成中性发丝线：idle 用默认那条线，hover 几乎不加深（反馈交给 col-resize 光标），
   * 拖动中只轻微加深。
   */
  const dividerActive = dark ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.12)";
  const dividerActiveHover = dark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.18)";

  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      // Near-monochrome palette: the product should read as ink on paper, not as a web app.
      colorPrimary: text,
      colorInfo: text,
      colorTextBase: text,
      colorBgLayout: dark ? "#16171a" : "#f2f2f3",
      borderRadius: 10,
      fontSize,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif',
    },
    components: {
      Menu: {
        itemBg: "transparent",
        itemSelectedBg: surface,
        itemSelectedColor: text,
        itemColor: body,
        itemHoverBg: surfaceHover,
        itemHoverColor: text,
        itemBorderRadius: 10,
        itemHeight: 38,
        itemMarginInline: 10,
        iconMarginInlineEnd: 10,
        iconSize: 15,
        activeBarBorderWidth: 0,
      },
      Tabs: {
        horizontalItemGutter: 22,
        horizontalItemPadding: "10px 0",
        titleFontSize: Math.max(10, fontSize - 1),
        itemColor: subtle,
        itemSelectedColor: text,
        itemHoverColor: text,
        inkBarColor: text,
      },
      Splitter: {
        // 分割条只是拖拽热区与落点提示线，卡片间隙由 .pane-slot 的 padding 让出（见 styles.css）。
        splitBarSize: 2,
        splitTriggerSize: 16,
        // idle 就是默认那条发丝线，hover / 拖动只轻微加深，不参与 colorPrimary 的明暗。
        controlItemBgHover: "transparent",
        controlItemBgActive: dividerActive,
        controlItemBgActiveHover: dividerActiveHover,
      },
      Button: {
        defaultShadow: "none",
        primaryShadow: "none",
        fontWeight: 500,
      },
      Input: {
        activeShadow: "none",
      },
    },
  };
}

/** 主题偏好 → 当前是否深色（系统模式交给系统偏好决定）。 */
export function resolveDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemPrefersDark;
}
