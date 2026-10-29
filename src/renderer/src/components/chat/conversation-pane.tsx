import { useCallback, useEffect, useState, type ReactNode } from "react";

import { LoaderCircle } from "lucide-react";

import type {
  ConversationKey,
  ConversationScope,
  ConversationThreadSummary,
} from "@shared/types";

import { DeleteDialog } from "@/components/modules/shared/DeleteDialog";

import {
  useBrowserTakeover,
  useConversationInitial,
  useModuleChat,
  type ModuleChat,
} from "./use-module-chat";

/** 历史对话工具条需要的状态与动作（传给 ChatPanel）。 */
export interface ConversationControl {
  threads: ConversationThreadSummary[];
  activeKey: ConversationKey;
  creating: boolean;
  /** 正在删除的对话 key；对应行的删除按钮显示加载态。 */
  removingKey: ConversationKey | null;
  onSelect: (key: ConversationKey) => void;
  onCreate: () => void;
  /** 打开删除确认；真正删除由 ConversationPane 统一处理。 */
  onRequestRemove: (key: ConversationKey) => void;
  onRefresh: () => void;
}

interface ConversationPaneProps {
  scope: ConversationScope;
  /** 浏览器面板「让 Agent 接管」只挂在这几个会话上。 */
  takeover?: boolean;
  /** 删除确认弹窗打开时隐藏原生浏览器视图。 */
  onOverlayChange: (open: boolean) => void;
  children: (chat: ModuleChat, control: ConversationControl) => ReactNode;
}

/**
 * 一个场景（模块 / 岗位工作台）里的对话容器：
 * 负责历史列表、当前对话选择与空对话创建；切换对话时只重挂聊天子树，
 * 页面右侧的表格 / 编辑器不会被卸载。
 */
export function ConversationPane({
  scope,
  takeover = false,
  onOverlayChange,
  children,
}: ConversationPaneProps) {
  const [threads, setThreads] = useState<ConversationThreadSummary[] | null>(null);
  const [activeKey, setActiveKey] = useState<ConversationKey | null>(null);
  const [creating, setCreating] = useState(false);
  const [removingKey, setRemovingKey] = useState<ConversationKey | null>(null);
  const [pendingRemove, setPendingRemove] = useState<ConversationKey | null>(null);

  useEffect(() => {
    let alive = true;
    setThreads(null);
    setActiveKey(null);
    void window.goodjob.conversations
      .list(scope)
      .then((items) => {
        if (!alive) return;
        setThreads(items);
        // 最近更新的一条；还没有任何对话时先用旧版默认 key，发第一条消息时才落盘。
        setActiveKey(items[0]?.key ?? scope);
      })
      .catch(() => {
        if (!alive) return;
        setThreads([]);
        setActiveKey(scope);
      });
    return () => {
      alive = false;
    };
  }, [scope]);

  const refresh = useCallback(() => {
    void window.goodjob.conversations
      .list(scope)
      .then(setThreads)
      .catch(() => setThreads([]));
  }, [scope]);

  const create = useCallback(() => {
    if (creating) return;
    setCreating(true);
    void window.goodjob.conversations
      .create(scope)
      .then((thread) => {
        setThreads((prev) => [thread, ...(prev ?? []).filter((item) => item.key !== thread.key)]);
        setActiveKey(thread.key);
      })
      .catch((cause: unknown) => {
        console.error("新建对话失败", cause);
      })
      .finally(() => setCreating(false));
  }, [creating, scope]);

  const remove = useCallback(
    async (key: ConversationKey): Promise<void> => {
      if (removingKey !== null) return;
      setRemovingKey(key);
      try {
        await window.goodjob.conversations.remove(key);
        if (key !== activeKey) {
          setThreads((prev) => (prev ?? []).filter((thread) => thread.key !== key));
          return;
        }
        // 删的是当前对话：切到下一条；如果一条都不剩，就补一条新的空对话
        // （不能回落到旧版 scope key——它在 main 里已被标成删除，写入会被忽略）。
        const remaining = await window.goodjob.conversations.list(scope);
        if (remaining.length > 0) {
          setThreads(remaining);
          setActiveKey(remaining[0]!.key);
          return;
        }
        const created = await window.goodjob.conversations.create(scope);
        setThreads([created]);
        setActiveKey(created.key);
      } catch (cause) {
        console.error("删除对话失败", cause);
        throw cause;
      } finally {
        setRemovingKey(null);
      }
    },
    [activeKey, removingKey, scope],
  );

  if (activeKey === null) return <ChatLoading />;

  const pendingTitle =
    threads?.find((thread) => thread.key === pendingRemove)?.title ?? "新对话";

  const control: ConversationControl = {
    threads: threads ?? [],
    activeKey,
    creating,
    removingKey,
    onSelect: setActiveKey,
    onCreate: create,
    onRequestRemove: (key) => {
      // AlertDialog 是受控组件：从外部把 open 改成 true 时不会触发 onOpenChange，
      // 所以这里主动让原生浏览器视图让位。
      onOverlayChange(true);
      setPendingRemove(key);
    },
    onRefresh: refresh,
  };

  return (
    <>
      <ConversationThreadView
        key={activeKey}
        threadKey={activeKey}
        takeover={takeover}
        control={control}
      >
        {children}
      </ConversationThreadView>
      <DeleteDialog
        open={pendingRemove !== null}
        title={`删除「${pendingTitle}」？`}
        description="这条对话和它的全部消息会从磁盘删除，无法恢复。"
        onClose={() => {
          setPendingRemove(null);
          // 确认删除成功后 Dialog 只会走 onClose（不会再触发 onOpenChange），
          // 这里补一次，避免原生浏览器视图一直处于让位状态。
          onOverlayChange(false);
        }}
        onConfirm={async () => {
          if (pendingRemove === null) return;
          await remove(pendingRemove);
        }}
        onOverlayChange={onOverlayChange}
      />
    </>
  );
}

/**
 * 固定加载顺序：先拿到这条对话的初始消息，再创建 useChat。
 * 这样保证 useChat 的初始 messages 一次性给准，切换对话也是干净的 remount。
 */
function ConversationThreadView({
  threadKey,
  takeover,
  control,
  children,
}: {
  threadKey: ConversationKey;
  takeover: boolean;
  control: ConversationControl;
  children: ConversationPaneProps["children"];
}) {
  const initial = useConversationInitial(threadKey);
  if (initial === null) return <ChatLoading />;
  return (
    <ConversationThreadLoaded
      threadKey={threadKey}
      initialMessages={initial}
      takeover={takeover}
      control={control}
    >
      {children}
    </ConversationThreadLoaded>
  );
}

function ConversationThreadLoaded({
  threadKey,
  initialMessages,
  takeover,
  control,
  children,
}: {
  threadKey: ConversationKey;
  initialMessages: Parameters<typeof useModuleChat>[1];
  takeover: boolean;
  control: ConversationControl;
  children: ConversationPaneProps["children"];
}) {
  const chat = useModuleChat(threadKey, initialMessages);
  useBrowserTakeover(chat.send, takeover);
  return <>{children(chat, control)}</>;
}

function ChatLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-card">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        正在加载对话…
      </div>
    </div>
  );
}
