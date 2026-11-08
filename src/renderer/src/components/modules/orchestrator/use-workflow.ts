import { useEffect, useState } from "react";

import type { ConversationKey, WorkflowState } from "@shared/types";

/**
 * 当前 GoodJob 对话的最近一次工作流。
 *
 * 挂载 / 切对话时从 main 拉一次快照，之后靠 workflow:event 增量更新。
 * 单 agent 任务不会创建 WorkflowState，返回值保持 null，右侧栏不出现。
 */
export function useWorkflow(key: ConversationKey): WorkflowState | null {
  const [workflow, setWorkflow] = useState<WorkflowState | null>(null);

  useEffect(() => {
    let alive = true;
    setWorkflow(null);

    void window.goodjob.workflow
      .get(key)
      .then((state) => {
        if (!alive) return;
        setWorkflow((prev) => latest(prev, state));
      })
      .catch(() => {
        if (alive) setWorkflow(null);
      });

    const off = window.goodjob.workflow.onEvent((state) => {
      if (state.key !== key) return;
      setWorkflow((prev) => latest(prev, state));
    });

    return () => {
      alive = false;
      off();
    };
  }, [key]);

  return workflow;
}

/** 事件与快照可能乱序到达：按 updatedAt 取较新的那份。 */
function latest(prev: WorkflowState | null, next: WorkflowState | null): WorkflowState | null {
  if (next === null) return prev;
  if (prev === null) return next;
  return next.updatedAt >= prev.updatedAt ? next : prev;
}
