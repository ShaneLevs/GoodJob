import { useState } from "react";

import { ApiOutlined, ArrowLeftOutlined, SkinOutlined } from "@ant-design/icons";
import { Button, Menu, Modal, Typography } from "antd";
import type { MenuProps } from "antd";

import type { AppearanceSettings, ModelsConfig } from "@shared/types";

import { AppearanceSettings as AppearanceSettingsPane } from "./settings/AppearanceSettings";
import { ModelsSettings } from "./settings/ModelsSettings";

/** 左侧分组。新的设置分区直接往这里加。 */
const NAV_ITEMS: MenuProps["items"] = [
  { key: "appearance", icon: <SkinOutlined />, label: "外观" },
  { key: "models", icon: <ApiOutlined />, label: "模型设置" },
];

type SectionKey = "appearance" | "models";

interface SettingsModalProps {
  open: boolean;
  models: ModelsConfig | null;
  appearance: AppearanceSettings;
  /** 左下角显示当前工作区，和主界面一致。 */
  workspaceName: string;
  onClose: () => void;
  onSaved: (models: ModelsConfig) => void;
  onAppearanceChange: (patch: Partial<AppearanceSettings>) => void;
}

export function SettingsModal({
  open,
  models,
  appearance,
  workspaceName,
  onClose,
  onSaved,
  onAppearanceChange,
}: SettingsModalProps) {
  const [section, setSection] = useState<SectionKey>("appearance");

  return (
    <Modal
      className="settings-modal"
      open={open}
      onCancel={onClose}
      centered
      width={1040}
      destroyOnHidden
      // 无标题栏、无页脚：左侧导航里的「返回工作区」负责关闭。
      title={null}
      closable={false}
      footer={null}
      afterClose={() => setSection("appearance")}
      styles={{ body: { padding: 0 } }}
    >
      <div className="settings-body">
        <nav className="settings-nav">
          <Button
            type="text"
            className="settings-back"
            icon={<ArrowLeftOutlined />}
            onClick={onClose}
          >
            返回工作区
          </Button>

          <div className="settings-nav-group">基础设置</div>
          <Menu
            mode="inline"
            className="settings-nav-menu"
            selectedKeys={[section]}
            items={NAV_ITEMS}
            onClick={({ key }) => setSection(key as SectionKey)}
          />

          <div className="settings-nav-account">
            <span className="settings-avatar">{workspaceName.trim().slice(0, 1) || "G"}</span>
            <span className="settings-account-name">{workspaceName}</span>
          </div>
        </nav>

        <div className="settings-content">
          {section === "appearance" ? (
            <AppearanceSettingsPane appearance={appearance} onChange={onAppearanceChange} />
          ) : models === null ? (
            <div className="settings-page">
              <h1 className="settings-page-title">模型设置</h1>
              <Typography.Text type="secondary">正在读取模型…</Typography.Text>
            </div>
          ) : (
            <ModelsSettings models={models} onSaved={onSaved} />
          )}
        </div>
      </div>
    </Modal>
  );
}
