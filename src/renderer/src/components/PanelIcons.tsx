import type { CSSProperties, SVGProps } from "react";

import Icon from "@ant-design/icons";

/**
 * 面板开合图标：圆角矩形 + 一条竖分隔线，分隔线靠左 = 左栏，靠右 = 右栏（镜像）。
 *
 * 通过 `@ant-design/icons` 的 `Icon component={...}` 通道渲染，而不是手写裸 `<svg>`：
 * 这样能继承 `anticon` 类名、`role="img"`、`aria-hidden`、`spin`/`rotate` 与
 * `<ConfigProvider>` 的 iconPrefixCls，和其余 antd 图标行为一致。
 */
const VIEW_BOX = "0 0 24 24";
/**
 * 图形几乎顶满 24 的盒：含描边约 23.0 × 20.6（96% 宽 / 86% 高），描边 2.3。
 * antd 自家 Outlined 图标在 em 盒里约占 89%，留白过多 + 描边偏细会让它看着比旁边图标小一号；
 * 面板按钮是无文字图标按钮，可读性优先，所以直接顶满。
 */
const FRAME = { x: 1.65, y: 2.85, width: 20.7, height: 18.3, radius: 4.05 };
/** 分隔线位置：左栏在左侧 37.5%，右栏取镜像（62.5%）。 */
const DIVIDER_LEFT = FRAME.x + FRAME.width * 0.375;
const DIVIDER_RIGHT = FRAME.x + FRAME.width * 0.625;

function PanelFrame({ dividerX, ...props }: SVGProps<SVGSVGElement> & { dividerX: number }) {
  return (
    <svg
      {...props}
      viewBox={VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.3}
      strokeLinejoin="round"
    >
      <rect
        x={FRAME.x}
        y={FRAME.y}
        width={FRAME.width}
        height={FRAME.height}
        rx={FRAME.radius}
      />
      <path d={`M${dividerX} ${FRAME.y}v${FRAME.height}`} />
    </svg>
  );
}

function PanelLeftSvg(props: SVGProps<SVGSVGElement>) {
  return <PanelFrame {...props} dividerX={DIVIDER_LEFT} />;
}

function PanelRightSvg(props: SVGProps<SVGSVGElement>) {
  return <PanelFrame {...props} dividerX={DIVIDER_RIGHT} />;
}

interface PanelIconProps {
  className?: string;
  style?: CSSProperties;
  rotate?: number;
  spin?: boolean;
}

/** 左栏（侧边栏）开合 */
export function PanelLeftIcon(props: PanelIconProps) {
  return <Icon component={PanelLeftSvg} {...props} />;
}

/** 右栏（工作台）开合 */
export function PanelRightIcon(props: PanelIconProps) {
  return <Icon component={PanelRightSvg} {...props} />;
}
