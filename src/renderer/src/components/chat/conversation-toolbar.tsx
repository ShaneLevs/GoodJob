import { useState } from "react";

import { Check, History, LoaderCircle, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { ConversationControl } from "./conversation-pane";

/**
 * 对话区左上角的历史记录 / 新建对话入口。
 * 打开历史时通知外层隐藏原生 WebContentsView，否则下拉会被浏览器视图盖住。
 */
export function ConversationToolbar({
  control,
  onOverlayChange,
}: {
  control: ConversationControl;
  onOverlayChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    onOverlayChange(next);
    if (next) control.onRefresh();
  };

  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-0.5 rounded-full border border-border/60 bg-card/90 p-0.5 shadow-sm backdrop-blur">
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-muted-foreground"
            aria-label="历史对话"
          >
            <History />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-80 gap-0 rounded-2xl p-1">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">历史对话</span>
            <span className="text-xs tabular-nums text-muted-foreground/70">
              {control.threads.length} 条
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {control.threads.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                还没有历史对话，发一条消息后就会出现在这里。
              </p>
            ) : (
              control.threads.map((thread) => {
                const active = thread.key === control.activeKey;
                const removing = control.removingKey === thread.key;
                return (
                  <div
                    key={thread.key}
                    className={cn(
                      "group flex w-full items-center rounded-xl transition-colors hover:bg-foreground/[0.06]",
                      active && "bg-foreground/[0.06]",
                    )}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-2 py-2 text-left"
                      onClick={() => {
                        control.onSelect(thread.key);
                        changeOpen(false);
                      }}
                    >
                      <span className="block truncate text-sm">
                        {thread.title ?? "新对话"}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {thread.messageCount === 0
                          ? "还没有消息"
                          : formatTime(thread.updatedAt)}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="mr-1 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      aria-label={`删除对话「${thread.title ?? "新对话"}」`}
                      disabled={removing}
                      onClick={() => {
                        changeOpen(false);
                        control.onRequestRemove(thread.key);
                      }}
                    >
                      {removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                    </Button>
                    {active && (
                      <Check className="mr-1.5 size-4 shrink-0 text-primary group-hover:hidden" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full text-muted-foreground"
        aria-label="新建对话"
        disabled={control.creating}
        onClick={control.onCreate}
      >
        {control.creating ? <LoaderCircle className="animate-spin" /> : <Plus />}
      </Button>
    </div>
  );
}
