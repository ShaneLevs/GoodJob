import { z } from "zod";

/**
 * 受控动作枚举（BROWSER-AGENT §3 / M3）：模型工具的 inputSchema 只接受这里的
 * 枚举值与 ref / 文本参数；argv 全部由 buildArgv 组装——模型永远拼不了 CLI 字符串。
 *
 * 白名单 = BROWSER-AGENT §3 允许清单（open back forward reload tab snapshot click
 * dblclick fill type press hover focus check uncheck select scroll scrollintoview
 * wait get is find screenshot keyboard mouse）。禁止清单不靠逐条拒绝实现，而是
 * 「枚举之外无命令」：network route / cookies / storage / state / eval / pdf /
 * trace / profiler / dashboard / install / upgrade / close --all 在这个类型系统里
 * 根本构造不出来，--profile / --executable-path / --extension / --init-script
 * 等全局旗标也从不进 argv（全局旗标只有 agent-browser.ts 里的固定三个）。
 *
 * 本模块保持纯净（只依赖 zod），可以脱离 Electron 单测。
 */

/** @e12 形态的快照 ref（@ 可省）。字符集收窄，防止把它当旗标或路径注入。 */
const refSchema = z
  .string()
  .regex(/^@?[A-Za-z0-9_-]{1,64}$/, "ref 必须是 snapshot 返回的 @e12 形态");
/** 只允许 http(s)（与内嵌面板 isHttpUrl 的边界一致）。 */
const urlSchema = z
  .string()
  .max(2048)
  .refine((value) => /^https?:\/\/\S+$/i.test(value), "只允许 http(s) 链接");
/** 位置参数文本：非空、限长、不以 - 开头（CLI 解析器会把 -x 当旗标）。 */
const textArg = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.startsWith("-"), "文本不能以 - 开头");
/** CSS 选择器（snapshot -s / get count 用）。 */
const selectorSchema = textArg(200).refine(
  (value) => !/[<>]/.test(value),
  "选择器里不能有 <>",
);
/** 按键名：Enter / Control+a / Shift / F5 这类组合。 */
const keySchema = z
  .string()
  .regex(/^[A-Za-z0-9]([A-Za-z0-9+_-]*[A-Za-z0-9])?$/, "按键名形如 Enter / Control+a / F5");

/** browser_read：只读动作（导航 / 观测 / 等待 / 滚动——不改变平台侧状态）。 */
export const browserReadActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), url: urlSchema }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("forward") }),
  z.object({ kind: z.literal("reload") }),
  z.object({
    kind: z.literal("snapshot"),
    interactive: z.boolean().optional(),
    compact: z.boolean().optional(),
    depth: z.number().int().min(1).max(12).optional(),
    urls: z.boolean().optional(),
    selector: selectorSchema.optional(),
  }),
  z.object({
    kind: z.literal("get"),
    what: z.enum(["text", "value", "attr", "title", "url", "count", "box"]),
    ref: refSchema.optional(),
    selector: selectorSchema.optional(),
    attr: z.string().regex(/^[A-Za-z][A-Za-z-]{0,39}$/).optional(),
  }),
  z.object({ kind: z.literal("is"), what: z.enum(["visible", "enabled", "checked"]), ref: refSchema }),
  z.object({
    kind: z.literal("wait"),
    ref: refSchema.optional(),
    ms: z.number().int().min(50).max(15_000).optional(),
    text: z.string().min(1).max(200).optional(),
    load: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
  }),
  z.object({
    kind: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    px: z.number().int().min(1).max(10_000).optional(),
  }),
  z.object({ kind: z.literal("scrollintoview"), ref: refSchema }),
  z.object({ kind: z.literal("screenshot") }),
]);

/** browser_act：写动作（点击 / 填写等，改变页面或平台状态，每步挂界面审批）。 */
/**
 * 点击时按住 ⌘/Ctrl 或中键会在新标签打开。newTab=true 时 runner 不直接 click，
 * 而是先读链接的 href 再在我们的面板里新建标签（用户看得见）。
 */
export const browserActActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ref: refSchema, newTab: z.boolean().optional() }),
  z.object({ kind: z.literal("dblclick"), ref: refSchema }),
  z.object({ kind: z.literal("fill"), ref: refSchema, text: textArg(4000) }),
  z.object({ kind: z.literal("type"), ref: refSchema, text: textArg(4000) }),
  z.object({ kind: z.literal("press"), key: keySchema }),
  z.object({ kind: z.literal("hover"), ref: refSchema }),
  z.object({ kind: z.literal("focus"), ref: refSchema }),
  z.object({ kind: z.literal("check"), ref: refSchema }),
  z.object({ kind: z.literal("uncheck"), ref: refSchema }),
  z.object({
    kind: z.literal("select"),
    ref: refSchema,
    values: z.array(textArg(200)).min(1).max(5),
  }),
  z.object({
    kind: z.literal("keyboard"),
    op: z.enum(["type", "inserttext", "press", "keydown", "keyup"]),
    // 位置参数（keyboard <op> <text>），与其他自由文本一样拒绝以 - 开头。
    text: textArg(200).optional(),
  }),
  z.object({
    kind: z.literal("mouse"),
    op: z.enum(["move", "down", "up", "wheel"]),
    x: z.number().int().min(0).max(10_000).optional(),
    y: z.number().int().min(0).max(10_000).optional(),
    dx: z.number().int().min(-10_000).max(10_000).optional(),
    dy: z.number().int().min(-10_000).max(10_000).optional(),
  }),
  z.object({
    kind: z.literal("find"),
    strategy: z.enum(["role", "text", "label", "placeholder", "testid"]),
    value: textArg(200),
    action: z.enum(["click", "fill", "type", "hover", "focus", "check", "uncheck"]),
    text: textArg(4000).optional(),
    name: textArg(200).optional(),
    exact: z.boolean().optional(),
  }),
]);

/** browser_submit：提交类动作（点击提交按钮 / 回车），双重审批 + 限速。 */
export const browserSubmitActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), ref: refSchema }),
  z.object({ kind: z.literal("press"), key: keySchema }),
]);

/** tab 是内部动作：只有 target.ts 用（列目标 + 锁定面板），不进模型工具面。 */
/**
 * tab 工具面（多标签）：list / new / switch / close。
 *
 * 注意：new / close / switch **不**直接映射成 CLI 的 `tab new` / `tab close`——
 * 那会在同一个 Chromium 里造一个我们拿不到 WebContentsView 的页面（用户看不见，
 * 等于 Agent 在隐形页面里点按钮）。它们的 argv 只是审计用的标签，真正执行走
 * panel（BrowserPanel 的标签宿），见 agent/runner.ts 的 tab 分支。
 * list / switch 的目标只能是**我们自己的标签 id**（tab_xxx），不是 CDP targetId：
 * 模型看不到也不应该拼 CDP id。
 */
export const tabActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tab"), op: z.literal("list") }),
  z.object({
    kind: z.literal("tab"),
    op: z.literal("new"),
    url: urlSchema.optional(),
  }),
  z.object({
    kind: z.literal("tab"),
    op: z.literal("switch"),
    target: z.string().regex(/^tab_[A-Za-z0-9]{4,32}$/, "target 必须是 tab_list 返回的标签 id"),
  }),
  z.object({
    kind: z.literal("tab"),
    op: z.literal("close"),
    target: z.string().regex(/^tab_[A-Za-z0-9]{4,32}$/, "target 必须是 tab_list 返回的标签 id"),
  }),
]);

export type BrowserReadAction = z.infer<typeof browserReadActionSchema>;
export type BrowserActAction = z.infer<typeof browserActActionSchema>;
export type BrowserSubmitAction = z.infer<typeof browserSubmitActionSchema>;
export type TabAction = z.infer<typeof tabActionSchema>;

/** buildArgv 的可选上下文：screenshot 的落盘路径由 main 指定（工作区 cache/），模型指定不了。 */
export interface ArgvContext {
  screenshotPath?: string;
}

/** 受控动作 → agent-browser CLI argv（不含 --session / --cdp / --pin-tab 全局旗标）。 */
export function buildArgv(action: BrowserReadAction | BrowserActAction | BrowserSubmitAction | TabAction, context: ArgvContext = {}): string[] {
  switch (action.kind) {
    // —— 导航 ——
    case "open":
      return ["open", action.url];
    case "back":
      return ["back"];
    case "forward":
      return ["forward"];
    case "reload":
      return ["reload"];
    case "tab":
      // 仅供审计；真正的标签动作走 panel（见 agent/runner.ts 的 tab 分支）。
      // 绝不让 CLI 自己 `tab new` / `tab close`：那会造 / 消一个用户看不见的页面。
      switch (action.op) {
        case "list":
          return ["tab", "list"];
        case "new":
          return ["tab", "new", action.url ?? "about:blank"];
        case "switch":
          return ["tab", action.target];
        case "close":
          return ["tab", "close", action.target];
      }
      break;
    // —— 观测 ——
    case "snapshot": {
      const argv = ["snapshot"];
      if (action.interactive) argv.push("-i");
      if (action.compact) argv.push("-c");
      if (action.depth !== undefined) argv.push("-d", String(action.depth));
      if (action.urls) argv.push("--urls");
      if (action.selector !== undefined) argv.push("-s", action.selector);
      return argv;
    }
    case "get": {
      const argv = ["get", action.what];
      if (action.ref !== undefined) argv.push(action.ref);
      else if (action.selector !== undefined) argv.push(action.selector);
      if (action.attr !== undefined) argv.push(action.attr);
      return argv;
    }
    case "is":
      return ["is", action.what, action.ref];
    case "wait": {
      if (action.ref !== undefined) return ["wait", action.ref];
      if (action.ms !== undefined) return ["wait", String(action.ms)];
      if (action.text !== undefined) return ["wait", "--text", action.text];
      if (action.load !== undefined) return ["wait", "--load", action.load];
      throw new Error("wait 需要 ref / ms / text / load 之一。");
    }
    case "screenshot": {
      if (context.screenshotPath === undefined) {
        throw new Error("screenshot 需要落盘路径（由系统指定到工作区 cache/）。");
      }
      return ["screenshot", context.screenshotPath];
    }

    // —— 滚动（读的辅助：把目标带进视口）——
    case "scroll":
      return action.px === undefined
        ? ["scroll", action.direction]
        : ["scroll", action.direction, String(action.px)];
    case "scrollintoview":
      return ["scrollintoview", action.ref];

    // —— 写动作 ——
    case "click":
      // newTab 不在 CLI 执行：`click --new-tab` 会在 Chromium 里造一个我们拿不到
      // WebContentsView 的隐形页面。runner 拦截 newTab：先 get attr href，
      // 再在我们的面板里建一个用户看得见的标签。
      return ["click", action.ref];
    case "dblclick":
      return ["dblclick", action.ref];
    case "fill":
      return ["fill", action.ref, action.text];
    case "type":
      return ["type", action.ref, action.text];
    case "press":
      return ["press", action.key];
    case "hover":
      return ["hover", action.ref];
    case "focus":
      return ["focus", action.ref];
    case "check":
      return ["check", action.ref];
    case "uncheck":
      return ["uncheck", action.ref];
    case "select":
      return ["select", action.ref, ...action.values];
    case "keyboard": {
      if (action.text === undefined) throw new Error("keyboard 需要 text。");
      return ["keyboard", action.op, action.text];
    }
    case "mouse": {
      switch (action.op) {
        case "move":
          if (action.x === undefined || action.y === undefined) throw new Error("mouse move 需要 x / y。");
          return ["mouse", "move", String(action.x), String(action.y)];
        case "down":
        case "up":
          return ["mouse", action.op];
        case "wheel":
          return ["mouse", "wheel", String(action.dy ?? 0), String(action.dx ?? 0)];
      }
      break;
    }
    case "find": {
      const argv = ["find", action.strategy, action.value, action.action];
      if (action.text !== undefined) argv.push(action.text);
      if (action.name !== undefined) argv.push("--name", action.name);
      if (action.exact) argv.push("--exact");
      return argv;
    }
  }
  // discriminatedUnion 已穷尽，这里只为让 TS 收窄通过。
  throw new Error(`未知动作：${JSON.stringify(action)}`);
}

/** 提交类动作给审计 / 确认文案用的一句话描述。 */
export function describeSubmitAction(action: BrowserSubmitAction): string {
  return action.kind === "click" ? `点击提交按钮（${action.ref}）` : `按回车提交（${action.key}）`;
}
