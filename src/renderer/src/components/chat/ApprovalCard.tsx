import { Mail, MousePointerClick, Send, ShieldQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/lib/utils";

import { toolLabel } from "./ToolTrace";

/**
 * 工具审批卡片（AI Elements 的 confirmation）：等待批准的工具调用**不进思维链**，
 * 而是单独一张 Item 卡片——批准 / 拒绝要一眼看见、一次点按完成，不能被「已工作 X 秒」
 * 这类折叠收进去。
 *
 * 批准之后这里就消失（part 变成 approval-responded，重新变成一条工具行）。
 */

/** 浏览器写动作：批准后要把面板打开，用户才看得见它点了什么、填了什么。 */
export function isBrowserWriteTool(name: string): boolean {
  return name === "browser_act" || name === "browser_submit";
}

function clamp(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function rec(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function values(value: unknown): string {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").join(" / ") : "";
}

/** 浏览器写动作 → 一句人话（“点击 @e12”比一段 JSON 有用得多）。 */
function describeAct(input: unknown): string {
  const action = rec(input);
  const ref = str(action.ref);
  switch (str(action.kind)) {
    case "click":
      return `点击元素 ${ref}${action.newTab === true ? "（在新标签打开链接）" : ""}`;
    case "dblclick":
      return `双击元素 ${ref}`;
    case "fill":
      return `把「${clamp(str(action.text), 60)}」填进 ${ref}`;
    case "type":
      return `在 ${ref} 里输入「${clamp(str(action.text), 60)}」`;
    case "press":
      return `按键 ${str(action.key)}`;
    case "hover":
      return `把鼠标移到 ${ref} 上`;
    case "focus":
      return `聚焦到 ${ref}`;
    case "check":
      return `勾选 ${ref}`;
    case "uncheck":
      return `取消勾选 ${ref}`;
    case "select":
      return `在 ${ref} 里选择「${values(action.values)}」`;
    case "keyboard":
      return `键盘动作 ${str(action.op)}${str(action.text) === "" ? "" : `「${clamp(str(action.text), 40)}」`}`;
    case "mouse":
      return `鼠标动作 ${str(action.op)}`;
    case "find":
      return `按 ${str(action.strategy)} 定位「${str(action.value)}」并 ${str(action.action)}`;
    default:
      return "在页面上执行一个操作";
  }
}

interface ApprovalView {
  title: string;
  detail: string;
  reason: string;
  browser: boolean;
}

function viewOf(toolName: string, input: unknown, requestReason: string | undefined): ApprovalView {
  const data = rec(input);
  const fallbackReason = requestReason ?? "这个动作在等你批准后才会执行。";

  switch (toolName) {
    case "browser_act":
      return {
        title: "要操作这个页面吗？",
        detail: describeAct(input),
        reason: "批准后浏览器会自动打开，你能看见它点的位置。",
        browser: true,
      };
    case "browser_submit": {
      const summary = str(data.summary);
      return {
        title: "要提交这个表单吗？",
        detail: summary === "" ? "提交当前页面" : clamp(summary, 200),
        reason: "提交是对外动作（可能已投出简历 / 发出消息），批准后浏览器会自动打开。",
        browser: true,
      };
    }
    case "notify":
      return {
        title: "要发送这封邮件吗？",
        detail: clamp(str(data.summary), 200),
        reason: "会发到你配置的邮箱，发出后不可撤回。",
        browser: false,
      };
    default:
      return {
        title: `要运行「${toolLabel(toolName)}」吗？`,
        detail: "",
        reason: fallbackReason,
        browser: false,
      };
  }
}

function iconOf(toolName: string) {
  if (toolName === "browser_act") return <MousePointerClick />;
  if (toolName === "browser_submit") return <Send />;
  if (toolName === "notify") return <Mail />;
  return <ShieldQuestion />;
}

export function ApprovalCard({
  toolName,
  input,
  requestReason,
  onRespond,
  className,
}: {
  toolName: string;
  input: unknown;
  requestReason?: string;
  /** approved=true 才继续执行；父级负责在批准浏览器写动作时把面板打开。 */
  onRespond: (approved: boolean) => void;
  className?: string;
}) {
  const view = viewOf(toolName, input, requestReason);

  return (
    <Item
      variant="outline"
      size="sm"
      className={cn("items-start border-border/70 bg-muted/30", className)}
    >
      <ItemMedia variant="icon" className="mt-0.5 text-muted-foreground">
        {iconOf(toolName)}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{view.title}</ItemTitle>
        {view.detail !== "" && (
          <ItemDescription className="text-foreground/80">{view.detail}</ItemDescription>
        )}
        <ItemDescription className="text-xs text-muted-foreground">{view.reason}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onRespond(false)}>
          拒绝
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={() => onRespond(true)}>
          批准
        </Button>
      </ItemActions>
    </Item>
  );
}
