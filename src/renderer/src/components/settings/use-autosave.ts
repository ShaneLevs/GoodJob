import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 设置页的自动保存（防抖落盘）。
 *
 * 设置里不再有「保存」按钮：每次改动先把**一整份表单快照**排进队列，停手
 * `delayMs` 后写盘；连续改动只保留最后一份（旧快照作废）。保存期间又有新改动
 * 时，队列里那份会接着存，不会被「已保存」吞掉。
 *
 * 失败不自动重试：错误挂在 `error` 上由页面显示，用户下一次改动会重新排队。
 * 卸载（关设置弹窗）时把还压在防抖里的改动补写一次，免得最后几个字丢掉。
 */
export type AutoSaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutoSave<T> {
  /** 记下这次改动，`delayMs` 后落盘。 */
  schedule: (value: T) => void;
  /** 立刻落盘（不等防抖）。 */
  flush: () => Promise<void>;
  state: AutoSaveState;
  error: string | null;
}

/** 输入停下来这么久就落盘，避免每敲一个字都写一次文件。 */
export const AUTOSAVE_MS = 400;

export function useAutoSave<T>(
  save: (value: T) => Promise<void>,
  delayMs: number = AUTOSAVE_MS,
): AutoSave<T> {
  // 保存函数每次渲染都可能是新的闭包：存进 ref，定时器里取最新的那份。
  const saveRef = useRef(save);
  saveRef.current = save;

  // 用对象包一层：`T` 本身为 null/undefined 也是合法快照。
  const pendingRef = useRef<{ value: T } | null>(null);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const [state, setState] = useState<AutoSaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    while (pendingRef.current !== null) {
      const { value } = pendingRef.current;
      pendingRef.current = null;
      if (mountedRef.current) {
        setState("saving");
        setError(null);
      }
      try {
        await saveRef.current(value);
        if (mountedRef.current) setState("saved");
      } catch (caught) {
        if (mountedRef.current) {
          setState("error");
          setError(caught instanceof Error ? caught.message : String(caught));
        }
        return;
      }
    }
  }, [clearTimer]);

  const schedule = useCallback(
    (value: T): void => {
      pendingRef.current = { value };
      if (mountedRef.current) setState("pending");
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, delayMs);
    },
    [clearTimer, delayMs, flush],
  );

  // 依赖留空：只在真正卸载时补写，不能因为父组件重渲染就误触发一次保存。
  // 挂载时把 mountedRef 复位，否则 StrictMode 的「卸载再挂载」会把状态更新静音。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null) void saveRef.current(pending.value).catch(() => undefined);
    };
  }, [clearTimer]);

  return { schedule, flush, state, error };
}
