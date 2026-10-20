import { useEffect, useRef, useState } from "react";

import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  BugOutlined,
  HomeOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { Button, Flex, Input, Space, Tooltip, Typography } from "antd";

import type { BrowserState } from "@shared/types";

const HOME = "https://www.bing.com";

const INITIAL_STATE: BrowserState = {
  url: HOME,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
};

interface BrowserPanelProps {
  /** Only the visible tab may own the native view. */
  active: boolean;
  /** Anything that opens an antd overlay must suspend the view or it paints on top. */
  suspended: boolean;
}

/**
 * Reserves a rectangle in the DOM and tells the main process to park the native
 * `WebContentsView` exactly there. The DOM node itself stays empty on purpose.
 */
export function BrowserPanel({ active, suspended }: BrowserPanelProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const editingRef = useRef(false);
  const [state, setState] = useState<BrowserState>(INITIAL_STATE);
  const [address, setAddress] = useState(HOME);

  const browser = window.goodjob.browser;

  useEffect(
    () =>
      browser.onState((next) => {
        setState(next);
        if (!editingRef.current && next.url !== "") setAddress(next.url);
      }),
    [browser],
  );

  // Keep the native view glued to the placeholder while the splitter moves.
  useEffect(() => {
    const element = holderRef.current;
    if (element === null) return;

    if (!active) {
      browser.setBounds(null);
      return;
    }

    const sync = (): void => {
      const rect = element.getBoundingClientRect();
      browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener("resize", sync);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      browser.setBounds(null);
    };
  }, [browser, active]);

  useEffect(() => {
    browser.setVisible(active && !suspended);
  }, [browser, active, suspended]);

  const navigate = (value: string): void => {
    editingRef.current = false;
    void browser.navigate(value);
  };

  return (
    <Flex vertical style={{ height: "100%", background: "var(--surface-bg)" }}>
      <Flex align="center" gap={8} className="browser-toolbar">
        <Space size={2}>
          <Tooltip title="后退">
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              disabled={!state.canGoBack}
              onClick={() => browser.back()}
            />
          </Tooltip>
          <Tooltip title="前进">
            <Button
              type="text"
              size="small"
              icon={<ArrowRightOutlined />}
              disabled={!state.canGoForward}
              onClick={() => browser.forward()}
            />
          </Tooltip>
          {state.loading ? (
            <Tooltip title="停止">
              <Button type="text" size="small" icon={<StopOutlined />} onClick={() => browser.stop()} />
            </Tooltip>
          ) : (
            <Tooltip title="刷新">
              <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => browser.reload()} />
            </Tooltip>
          )}
          <Tooltip title="回到首页">
            <Button type="text" size="small" icon={<HomeOutlined />} onClick={() => navigate(HOME)} />
          </Tooltip>
        </Space>

        <Input
          size="small"
          value={address}
          spellCheck={false}
          placeholder="输入网址或搜索内容"
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => {
            editingRef.current = true;
            event.currentTarget.select();
          }}
          onBlur={() => {
            editingRef.current = false;
          }}
          onPressEnter={() => navigate(address)}
        />

        <Tooltip title="浏览器 DevTools">
          <Button type="text" size="small" icon={<BugOutlined />} onClick={() => browser.toggleDevTools()} />
        </Tooltip>
      </Flex>

      <div ref={holderRef} style={{ flex: 1, minHeight: 0 }} />

      {state.title !== "" && (
        <Typography.Text type="secondary" ellipsis className="browser-title">
          {state.title}
        </Typography.Text>
      )}
    </Flex>
  );
}
