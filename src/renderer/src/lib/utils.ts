import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 组件统一用它拼接 className：后者覆盖前者的同类 utility。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * 把 IPC 抛出来的错误拆成一句人话。
 *
 * Electron 会把手主进程的异常包成 `Error invoking remote method 'models:probe-list':
 * Error: 真正的话`，直接往界面上放只会让人以为是自己壳里的报错。
 */
export function ipcErrorMessage(caught: unknown): string {
  const raw = caught instanceof Error ? caught.message : String(caught);
  const match = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?([\s\S]*)$/.exec(raw);
  return (match?.[1] ?? raw).trim();
}
