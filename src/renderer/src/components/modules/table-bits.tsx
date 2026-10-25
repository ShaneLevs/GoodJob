import { useCallback, useState } from "react";

import { ChevronDown, ChevronUp } from "lucide-react";

import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * 三张领域表的公共小件（P2）：内存排序状态 + 可点击列头。
 * 排序约定（计划已拍板）：store 的 list() 只给确定性顺序，
 * 一切业务排序（更新时间 / 匹配度 / 薪资带 / 状态…）在渲染层做。
 */

export type SortDirection = "asc" | "desc";

export interface TableSort<K extends string> {
  sortKey: K;
  direction: SortDirection;
  /** 列头点击：同列切换 asc/desc，换列从 asc 开始。 */
  toggle: (key: K) => void;
}

export function useTableSort<K extends string>(
  defaultKey: K,
  defaultDirection: SortDirection = "desc",
): TableSort<K> {
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [direction, setDirection] = useState<SortDirection>(defaultDirection);

  const toggle = useCallback(
    (key: K) => {
      if (key === sortKey) {
        setDirection((prev) => (prev === "asc" ? "desc" : "asc"));
        return;
      }
      setSortKey(key);
      setDirection("asc");
    },
    [sortKey],
  );

  return { sortKey, direction, toggle };
}

/** 可排序列头：当前排序列给方向箭头，其余悬停时给淡淡的提示。 */
export function SortableHead<K extends string>({
  label,
  sortKey,
  table,
  className,
}: {
  label: string;
  sortKey: K;
  table: TableSort<K>;
  className?: string;
}) {
  const active = table.sortKey === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md text-xs font-medium transition-colors outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring/30",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
        aria-label={`按${label}排序`}
        onClick={() => table.toggle(sortKey)}
      >
        {label}
        {active ? (
          table.direction === "asc" ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )
        ) : (
          <ChevronDown className="size-3 opacity-0 transition-opacity group-hover:opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

/** 中文字符串排序（薪资带 / 名称这类自由文本列用它即可）。 */
export function cmpText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN");
}

/** 数值列排序：null（未评估 / 未填写）永远排最后，不随方向翻转。 */
export function cmpNumber(a: number | null, b: number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

/** ISO 时间列排序：空值最后；direction 已在内部处理。 */
export function cmpTime(a: string | null, b: string | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = a.localeCompare(b);
  return direction === "asc" ? result : -result;
}

/** 表格里统一的时间显示：YYYY-MM-DD HH:mm；空值给占位符。 */
export function formatTime(iso: string | null): string {
  if (iso === null || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 「当前状态」列的可分组着色（看板预留）：按阶段在流水线里的序号取色。
 * 固定的 class 列表，Tailwind 才能静态收集；超过 8 个阶段循环使用。
 */
const STAGE_DOT_CLASSES = [
  "bg-sky-500",
  "bg-violet-500",
  "bg-teal-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-orange-500",
] as const;

export function stageDotClass(stageIndex: number): string {
  if (stageIndex < 0) return "bg-muted-foreground/40";
  return STAGE_DOT_CLASSES[stageIndex % STAGE_DOT_CLASSES.length] ?? "bg-muted-foreground/40";
}
