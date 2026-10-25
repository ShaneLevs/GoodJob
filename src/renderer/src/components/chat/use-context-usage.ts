import { useCallback, useEffect, useState } from "react";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS } from "@shared/types";
import type { ContextUsage, ConversationKey } from "@shared/types";

/**
 * 上下文用量只在 main 算（估算器和自动压缩阈值同一套），渲染层只负责看：
 * 挂载 / 切会话 / 每轮 run 结束 / 手动压缩后各取一次。
 */
function emptyUsage(limit: number, maxOutputTokens: number): ContextUsage {
  return {
    limit,
    maxOutputTokens,
    threshold: limit,
    instructions: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    used: 0,
    summarizedMessages: 0,
  };
}

export interface ContextUsageState {
  usage: ContextUsage;
  /** 手动压缩：压完返回新用量，界面立刻刷新。 */
  compact: () => Promise<void>;
}

export function useContextUsage(
  key: ConversationKey | null,
  busy: boolean,
): ContextUsageState {
  const [usage, setUsage] = useState<ContextUsage>(() =>
    emptyUsage(DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS),
  );

  const refresh = useCallback(() => {
    if (key === null) return;
    void window.goodjob.chat.context(key).then(setUsage);
  }, [key]);

  // 切会话立刻刷新；run 结束（busy 由 true 变 false）再刷一次，把这一轮的产出算进去。
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (busy) return;
    refresh();
  }, [busy, refresh]);

  const compact = useCallback(async () => {
    if (key === null) return;
    const next = await window.goodjob.chat.compact(key);
    setUsage(next);
  }, [key]);

  return { usage, compact };
}
