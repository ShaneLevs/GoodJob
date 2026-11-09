import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatStatus, UIMessage } from "ai";

import type { ReasoningEffort, UploadedFileMeta, VoiceState } from "@shared/types";
import { createIdleVoiceState } from "@shared/types";

import { ipcErrorMessage } from "@/lib/utils";

/**
 * 语音面试的渲染层编排：只负责「什么时候朗读 / 什么时候开麦」和把定稿文本
 * 交回 `useChat`，音频通路全在 main。
 *
 * 一轮的节奏：
 * 面试官回复完成（status = ready）→ speak（朗读）→ 播放排空后自动 startListening
 * → 用户点「完成回答」→ stopListening 拿到定稿文本 → chat.send 走原来的
 * `interview:<id>` 会话与轮次工具。
 *
 * 只在这场面试的模式是 voice 且还没结束时启用；停用 / 卸载 / 结束都会 stopAll，
 * 保证麦克风与 AOQ 连接不残留。
 */
export function useVoiceInterview({
  enabled,
  interviewRunning,
  pageActive,
  messages,
  status,
  send,
}: {
  enabled: boolean;
  interviewRunning: boolean;
  /** 这个模块页当前是否可见（切模块只加 invisible，不会卸载）。 */
  pageActive: boolean;
  messages: UIMessage[];
  status: ChatStatus;
  send: (text: string, uploads: UploadedFileMeta[], effort?: ReasoningEffort) => void;
}): {
  state: VoiceState;
  notice: string | null;
  /** 最近一次失败是「语音模型没配好」：状态条上要直接给「去设置」。 */
  needsSettings: boolean;
  startListening: () => void;
  finishAnswer: () => void;
  stopSpeaking: () => void;
  stopAll: () => void;
} {
  const [state, setState] = useState<VoiceState>(createIdleVoiceState);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsSettings, setNeedsSettings] = useState(false);
  const phaseRef = useRef<VoiceState["phase"]>("idle");
  phaseRef.current = state.phase;

  const aliveRef = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const runningRef = useRef(interviewRunning);
  runningRef.current = interviewRunning;
  const pageActiveRef = useRef(pageActive);
  pageActiveRef.current = pageActive;
  /**
   * 已经朗读过的助手消息 id（同一条只读一次）。初值取挂载时最后一条助手消息：
   * 切回一场进行中的面试时，不把历史里最后那段提问再念一遍。
   */
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const spokenRef = useRef<string | null>(lastAssistant?.id ?? null);
  /** 每次 stopAll / 卸载递增：作废在途的「朗读完自动开麦」。 */
  const generationRef = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    aliveRef.current = true;
    const unsubscribe = window.goodjob.voice.onState((next) => {
      if (aliveRef.current) setState(next);
    });
    void window.goodjob.voice.getState().then((snapshot) => {
      if (aliveRef.current) setState(snapshot);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
  }, []);

  const stopAll = useCallback((): void => {
    generationRef.current += 1;
    void window.goodjob.voice.stop();
  }, []);

  // 结束面试 / 关掉这场面试 / 从语音切到别的会话：立刻释放麦克风与连接。
  useEffect(() => {
    if (enabled && interviewRunning && pageActive) return;
    stopAll();
    if (!enabled) setState(createIdleVoiceState());
  }, [enabled, interviewRunning, pageActive, stopAll]);

  // 挂载即语音面试：卸载时收尾（切面试、切模块都会走这里）。
  useEffect(
    () => () => {
      generationRef.current += 1;
      void window.goodjob.voice.stop();
    },
    [],
  );

  // 用户直接打字发了一条：别让麦克风继续录（这一轮以打字为准）。
  useEffect(() => {
    if (!enabled) return;
    if (status !== "submitted" && status !== "streaming") return;
    if (state.phase === "listening" || state.phase === "recognizing") {
      generationRef.current += 1;
      void window.goodjob.voice.stop();
    }
  }, [enabled, status, state.phase]);

  useEffect(() => {
    if (!enabled || !interviewRunning || !pageActive) return;
    if (status !== "ready") return;
    // 用户已经先开了麦（例如上一轮还没说完就点了「开始回答」）：别再抢语音通道。
    if (phaseRef.current === "listening" || phaseRef.current === "recognizing") return;
    if (lastAssistant === undefined || lastAssistant.id === spokenRef.current) return;
    const text = assistantText(lastAssistant);
    if (text === "") return;
    spokenRef.current = lastAssistant.id;

    const generation = generationRef.current;
    const alive = (): boolean => aliveRef.current && generation === generationRef.current;

    void (async () => {
      setNotice(null);
      try {
        await window.goodjob.voice.speak(text);
      } catch (cause) {
        if (!alive()) return;
        // 错误本身已经由 main 推成 voice:state；这里只补一句「可以打字继续」。
        const message = ipcErrorMessage(cause);
        setNotice(message);
        setNeedsSettings(isConfigMessage(message));
        return;
      }
      if (!alive() || !enabledRef.current || !runningRef.current || !pageActiveRef.current) {
        return;
      }
      try {
        await window.goodjob.voice.startListening();
      } catch (cause) {
        if (!alive()) return;
        const message = ipcErrorMessage(cause);
        setNotice(message);
        setNeedsSettings(isConfigMessage(message));
      }
    })();
    // 只在「新的一条助手消息 + 本轮已结束」时触发一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, interviewRunning, pageActive, status, lastAssistant?.id]);

  const startListening = useCallback((): void => {
    generationRef.current += 1;
    setNotice(null);
    setNeedsSettings(false);
    void window.goodjob.voice.startListening().catch((cause: unknown) => {
      if (!aliveRef.current) return;
      const message = ipcErrorMessage(cause);
      setNotice(message);
      setNeedsSettings(isConfigMessage(message));
    });
  }, []);

  const finishAnswer = useCallback((): void => {
    setNotice(null);
    void window.goodjob.voice
      .stopListening()
      .then((result) => {
        // 识别期间切走了页面 / 面试已结束：这一轮作废，不要把文本发进会话。
        if (!aliveRef.current || !pageActiveRef.current || !runningRef.current) return;
        const text = result.text.trim();
        if (text === "") {
          setNotice("这次没有听清：再点「开始回答」说一次，或直接在下面打字。");
          return;
        }
        sendRef.current(text, []);
      })
      .catch((cause: unknown) => {
        if (!aliveRef.current) return;
        setNotice(ipcErrorMessage(cause));
      });
  }, []);

  const stopSpeaking = useCallback((): void => {
    generationRef.current += 1;
    window.goodjob.voice.stopSpeaking();
    setNotice("已跳过朗读，点「开始回答」继续。");
  }, []);

  return { state, notice, needsSettings, startListening, finishAnswer, stopSpeaking, stopAll };
}

/** 「还没有配置 / 去设置」这类错误才配「去设置」按钮；网络 / 超时错误给「重试」。 */
function isConfigMessage(message: string): boolean {
  return message.includes("还没有配置") || message.includes("语音模型");
}

/**
 * 助手消息里「这一轮的答复」：取最后一个工具 / 思考块之后的连续文本，
 * 与 ChatPanel 把最后一段正文当答案的规则一致（前面那些「我先读一下材料」
 * 不该被念出来）。
 */
function assistantText(message: UIMessage): string {
  let answer: string[] = [];
  let current: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      current.push(part.text);
    } else if (current.length > 0) {
      answer = current;
      current = [];
    }
  }
  if (current.length > 0) answer = current;
  return answer.join("\n").trim();
}
