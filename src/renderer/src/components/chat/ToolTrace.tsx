import { useEffect, useRef, useState } from "react";

import type { UIMessage } from "ai";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/ai-elements/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/ai-elements/trace";
import { formatWorkDuration } from "@/lib/format";

import { AssistantMarkdown } from "./AssistantMarkdown";

/** 工具 part 的宽松视图：工具名/状态/输入输出都从这取。 */
export interface ToolPartView {
  type: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /** 「等待批准」态才有：approval.id 是批准 / 拒绝要回填的凭据。 */
  approval?: {
    id: string;
    requestReason?: string;
    isAutomatic?: boolean;
  };
}

/**
 * 把一条消息的 parts 切成两种块：正文块，和「思考 + 工具调用」块。
 *
 * reasoning / tool-* 连续出现就合并成一个 Trace（AI Elements 的 chain-of-thought 结构：
 * 一串可展开的步骤行），中间夹着正文时切开——保持流式的真实顺序。
 * 其他 part（step-start / file / data-*）不进渲染。
 */
export type TraceGroup =
  | { kind: "text"; key: string; part: { type: "text"; text: string } }
  | { kind: "trace"; key: string; parts: UIMessage["parts"] };

export function groupTraceParts(parts: UIMessage["parts"]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let buffer: UIMessage["parts"] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    groups.push({ kind: "trace", key: `trace-${groups.length}`, parts: buffer });
    buffer = [];
  };

  for (const part of parts) {
    if (part.type === "text") {
      flush();
      groups.push({ kind: "text", key: `text-${groups.length}`, part });
      continue;
    }
    if (part.type === "reasoning" || part.type.startsWith("tool-")) {
      buffer.push(part);
    }
  }
  flush();

  return groups;
}

/**
 * 工具名 → 中文标签。工具是 `<名词>_<动作>` 的 snake_case，这里拆开查两张小表，
 * 新增工具不用改这里；查不到就原样显示。
 */
const TOOL_NOUNS: Record<string, string> = {
  browser: "页面",
  memory: "记忆",
  resume: "简历",
  resume_tailored: "定制稿",
  resume_job: "岗位匹配",
  script: "话术",
  job: "岗位",
  company: "公司",
  application: "投递",
  pipeline: "流水线",
};

const TOOL_VERBS: Record<string, string> = {
  read: "读取",
  list: "查看",
  get: "查看",
  write: "写入",
  create: "新建",
  update: "更新",
  delete: "删除",
  act: "操作",
  submit: "提交",
  evaluate: "评估",
  check: "检查",
  finalize: "定稿",
  advance: "推进",
  info: "查看",
};

/** 名字不按 `<名词>_<动作>` 来的少数几个，单独给标签。 */
const TOOL_SPECIAL: Record<string, string> = {
  upload_list: "查看上传文件",
  upload_read: "读取上传文件",
  notify: "发送通知",
  request_confirmation: "请求确认",
  memory_read: "读取记忆",
  memory_write: "更新记忆",
  browser_read: "读取页面",
  browser_act: "操作页面",
  browser_submit: "提交表单",
};

export function toolLabel(name: string): string {
  const special = TOOL_SPECIAL[name];
  if (special !== undefined) return special;
  const segments = name.split("_");
  const verb = segments[segments.length - 1] ?? name;
  const noun = TOOL_NOUNS[segments.slice(0, -1).join("_")];
  const action = TOOL_VERBS[verb];
  return noun !== undefined && action !== undefined ? `${action}${noun}` : name;
}

/** JSON / 字符串统一成一段可复制的文本。 */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value, null, 2) ?? String(value);
}

/**
 * 一轮 run 的「工作过程」：思考 + 工具调用 + 中间正文整段折成一行「已工作 X 分 Y 秒」。
 * 跑的时候默认展开（看得见在动），这轮结束后默认收起；点标题随时展开。
 *
 * `pending`（有工具在等批准）也算「还在工作」：等待时既不能收起——否则批准按钮
 * 跟着折叠一起消失，用户以为这轮已经跑完了——标题也不能写「已工作」。
 */
export function WorkBlock({
  groups,
  streaming,
  pending,
  tailPart,
  elapsedMs,
}: {
  groups: TraceGroup[];
  streaming: boolean;
  /** 这一轮里有工具在等用户批准。 */
  pending: boolean;
  tailPart: UIMessage["parts"][number] | undefined;
  elapsedMs: number | null;
}) {
  const [open, setOpen] = useState<boolean>();
  const active = streaming || pending;

  return (
    <TraceCollapsible open={open ?? active} onOpenChange={setOpen}>
      <div className="border-b border-border/60 pb-2">
        <TraceCollapsibleTrigger>
          <TraceLine status={streaming ? "running" : undefined}>
            <TraceTitle>
              {pending
                ? "等待批准"
                : elapsedMs === null
                  ? "工作过程"
                  : `已工作 ${formatWorkDuration(elapsedMs)}`}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
      </div>
      <TraceCollapsibleContent>
        <Trace>
          {groups.map((group) =>
            group.kind === "text" ? (
              <AssistantMarkdown key={group.key} streaming={streaming && group.part === tailPart}>
                {group.part.text}
              </AssistantMarkdown>
            ) : (
              group.parts.map((part, index) =>
                part.type === "reasoning" ? (
                  <ReasoningRow
                    key={`${group.key}-${index}`}
                    text={part.text}
                    streaming={streaming && part === tailPart && part.state !== "done"}
                  />
                ) : (
                  <ToolRow key={`${group.key}-${index}`} part={part as unknown as ToolPartView} />
                ),
              )
            ),
          )}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * 思考内容：标题写状态，展开是模型的原始推理文本；无图标，完成后默认收起。
 * 正文最多露 10 行，超出在框内滚动（跟随到底部，用户往上翻后不再抢滚动），
 * 否则长思考会把下面的工具行和正文一直往下推。
 */
function ReasoningRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState<boolean>();
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastHeightRef = useRef(0);
  const wasStreamingRef = useRef(streaming);

  // 思考一结束就收起：即使读者在流式过程中手动展开过，也回到默认的折叠态。
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) setOpen(undefined);
    wasStreamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    // 用「这次增长之前」的高度判断读者是否停在底部：scroll 事件是异步派发的，
    // 靠它记跟随状态会被下一段 delta 抢先，读者往上翻也会被拽回底部。
    const atBottom = body.scrollTop + body.clientHeight >= lastHeightRef.current - 8;
    if (streaming && atBottom) body.scrollTop = body.scrollHeight;
    lastHeightRef.current = body.scrollHeight;
  }, [text, streaming]);

  const line = (
    <TraceLine status={streaming ? "running" : undefined}>
      <TraceTitle>{streaming ? "思考中" : "思考完成"}</TraceTitle>
    </TraceLine>
  );

  if (text.length === 0) return line;

  return (
    <TraceCollapsible
      open={open ?? streaming}
      onOpenChange={(next) => {
        setOpen(next);
        // 重新展开时按「从底部继续跟随」处理，而不是沿用折叠前的高度。
        if (next) lastHeightRef.current = 0;
      }}
    >
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">
        <div ref={bodyRef} className="max-h-[10lh] overflow-y-auto overscroll-contain">
          {text}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** 一条工具调用：标题是「运行 + 中文工具名」，无图标；输入 / 输出 / 错误折在行内。
 *  执行中展开，完成后默认收起。等待批准时只留一行状态——批准 / 拒绝的按钮跟
 *  `ApprovalCard` 一起待在思维链外面（见 AI Elements 的 confirmation）。 */
function ToolRow({ part }: { part: ToolPartView }) {
  const [open, setOpen] = useState<boolean>();
  const name = part.type.slice("tool-".length);
  const label = toolLabel(name);

  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    part.state === "approval-responded";
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const waiting =
    part.state === "approval-requested" && part.approval !== undefined && !part.approval.isAutomatic;

  const status = failed
    ? ("error" as const)
    : waiting
      ? ("pending" as const)
      : running
        ? ("running" as const)
        : undefined;

  const title = failed
    ? `运行 ${label} 失败`
    : denied
      ? `已拒绝：${label}`
      : waiting
        ? `等待批准：${label}`
        : `运行 ${label}`;

  const errorText = failed ? part.errorText : undefined;
  const hasDetail =
    (part.input !== undefined && part.input !== null) ||
    (part.output !== undefined && part.output !== null) ||
    (errorText !== undefined && errorText !== "");

  const line = (
    <TraceLine status={status}>
      <TraceTitle>{title}</TraceTitle>
    </TraceLine>
  );

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {hasDetail ? (
        <TraceCollapsible open={open ?? (running || waiting)} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-xs">
            <ToolDetail input={part.input} output={part.output} errorText={errorText} />
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ) : (
        line
      )}
    </div>
  );
}

/** 工具入参 / 输出。长 JSON 用 CodeBlock 折在 Trace 里，带复制按钮。 */
function ToolDetail({
  input,
  output,
  errorText,
}: {
  input: unknown;
  output: unknown;
  errorText: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-2">
      {input !== undefined && input !== null && (
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>调用参数</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={valueText(input)} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {valueText(input)}
          </CodeBlockContent>
        </CodeBlock>
      )}
      {errorText !== undefined && errorText !== "" && (
        <CodeBlock size="sm" variant="destructive">
          <CodeBlockHeader>
            <CodeBlockTitle>错误</CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {errorText}
          </CodeBlockContent>
        </CodeBlock>
      )}
      {output !== undefined && output !== null && (
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>结果</CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton value={valueText(output)} />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-56">
            {valueText(output)}
          </CodeBlockContent>
        </CodeBlock>
      )}
    </div>
  );
}
