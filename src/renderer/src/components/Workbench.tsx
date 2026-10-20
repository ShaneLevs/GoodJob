import { Empty, Tabs, Tag, Typography } from "antd";

import { BrowserPanel } from "./BrowserPanel";
import { PANES, PANE_BY_KEY, type PaneKey } from "../panes";

interface WorkbenchProps {
  openPanes: PaneKey[];
  activePane: PaneKey | null;
  /** Overlays (drawer/modal) must hide the native browser view. */
  suspended: boolean;
  onSelect: (key: PaneKey) => void;
  /**
   * 只给 Agent 侧的通道预留：右栏不提供手动创建标签的入口，
   * 标签页由 Agent 在需要时打开。
   */
  onOpen: (key: PaneKey) => void;
  onClose: (key: PaneKey) => void;
}

const PLACEHOLDER_HINT: Record<Exclude<PaneKey, "browser">, string> = {
  markdown: "AI 生成的简历、岗位对比、面试准备清单会以 Markdown 形式在这里预览。",
  editor: "在这里直接修改文档，改动会保存到本地工作区。",
  log: "AI 每一步做了什么、看了哪个页面、提交了哪些信息，都会记录在这里。",
};

export function Workbench({ openPanes, activePane, suspended, onSelect, onClose }: WorkbenchProps) {
  const renderPane = (key: PaneKey) => {
    if (key === "browser") {
      return <BrowserPanel active={activePane === "browser"} suspended={suspended} />;
    }
    const meta = PANE_BY_KEY[key];
    return (
      <div className="pane-placeholder">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <div className="pane-placeholder-text">
              <Typography.Text strong>
                {meta.icon} {meta.label}
              </Typography.Text>
              <Typography.Text type="secondary">{PLACEHOLDER_HINT[key]}</Typography.Text>
              <Tag variant="filled">规划中</Tag>
            </div>
          }
        />
      </div>
    );
  };

  return (
    <div className="workbench">
      {openPanes.length === 0 ? (
        <div className="pane-empty">
          <div className="pane-empty-copy">
            <Typography.Title level={4} className="pane-empty-title">
              右栏由 Agent 使用
            </Typography.Title>
            <Typography.Text type="secondary" className="pane-empty-hint">
              这里不需要你手动打开标签。对话中 Agent 需要给你看东西时，会自己把标签页打开在这里。
            </Typography.Text>
          </div>

          <ul className="pane-preview-list">
            {PANES.map((pane) => (
              <li key={pane.key} className="pane-preview-item">
                <span className="pane-preview-icon">{pane.icon}</span>
                <div>
                  <div className="pane-preview-label">{pane.label}</div>
                  <div className="pane-preview-hint">{pane.hint}</div>
                </div>
              </li>
            ))}
          </ul>

          <Tag variant="filled">Agent 按需打开</Tag>
        </div>
      ) : (
        <Tabs
          type="editable-card"
          hideAdd
          className="workbench-tabs"
          activeKey={activePane ?? openPanes[0]}
          onChange={(key) => onSelect(key as PaneKey)}
          onEdit={(targetKey, action) => {
            if (action === "remove" && typeof targetKey === "string") {
              onClose(targetKey as PaneKey);
            }
          }}
          items={openPanes.map((key) => ({
            key,
            closable: true,
            label: (
              <span className="workbench-tab-label">
                {PANE_BY_KEY[key].icon}
                {PANE_BY_KEY[key].label}
              </span>
            ),
            children: renderPane(key),
          }))}
        />
      )}
    </div>
  );
}
