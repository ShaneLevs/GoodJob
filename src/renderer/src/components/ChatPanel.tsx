import { useMemo, useState } from "react";

import { ApiOutlined } from "@ant-design/icons";
import { Button, Flex, theme, Typography } from "antd";
import { Bubble, Sender, type BubbleItemType } from "@ant-design/x";

import type { ActiveModel } from "@shared/types";

import type { UiMessage } from "../types";

interface ChatPanelProps {
  messages: UiMessage[];
  streaming: boolean;
  activeModel: ActiveModel | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
}

export function ChatPanel({
  messages,
  streaming,
  activeModel,
  onSend,
  onStop,
  onOpenSettings,
}: ChatPanelProps) {
  const { token } = theme.useToken();
  const [draft, setDraft] = useState("");

  const items = useMemo<BubbleItemType[]>(
    () =>
      messages.map((message) => {
        const isUser = message.role === "user";
        return {
          key: message.id,
          role: isUser ? "user" : "ai",
          placement: isUser ? "end" : "start",
          variant: isUser ? "filled" : "borderless",
          streaming: message.streaming === true,
          loading: message.streaming === true && message.content === "",
          content: message.content,
          contentRender: (content: string) => (
            <div
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: message.failed === true ? token.colorError : undefined,
              }}
            >
              {content}
            </div>
          ),
        };
      }),
    [messages],
  );

  const empty = messages.length === 0;

  const composer = (
    <Flex vertical gap={8}>
      <Sender
        value={draft}
        loading={streaming}
        placeholder="说说你想找什么岗位，Enter 发送"
        onChange={(value) => setDraft(value)}
        onSubmit={(value) => {
          const text = value.trim();
          if (text === "" || streaming) return;
          setDraft("");
          onSend(text);
        }}
        onCancel={onStop}
        footer={
          <Flex justify="space-between" align="center" style={{ padding: "0 4px" }}>
            <Button
              type="text"
              size="small"
              icon={<ApiOutlined />}
              onClick={onOpenSettings}
              style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}
            >
              {activeModel === null
                ? "未配置模型"
                : `${activeModel.providerName} · ${activeModel.name}`}
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Enter 发送 · Shift + Enter 换行
            </Typography.Text>
          </Flex>
        }
      />
    </Flex>
  );

  return (
    <div className="chat-column">
      {empty ? (
        <div className="chat-empty">
          <div className="chat-composer chat-composer-inline">{composer}</div>
        </div>
      ) : (
        <>
          <div className="chat-scroll">
            <Bubble.List autoScroll items={items} />
          </div>
          <div className="chat-composer chat-composer-docked">{composer}</div>
        </>
      )}
    </div>
  );
}
