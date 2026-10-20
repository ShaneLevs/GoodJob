import { CheckOutlined, DownOutlined, ProfileOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Dropdown, Menu, Tooltip } from "antd";

import type { WorkspaceInfo } from "@shared/types";

interface SidebarProps {
  workspaces: WorkspaceInfo[];
  currentWorkspace: WorkspaceInfo | null;
  onOpenSettings: () => void;
  onSwitchWorkspace: (id: string) => void;
}

const MENU_ITEMS = [{ key: "resume", icon: <ProfileOutlined />, label: "个人简历" }];

export function Sidebar({
  workspaces,
  currentWorkspace,
  onOpenSettings,
  onSwitchWorkspace,
}: SidebarProps) {
  // 用勾选图标而不是 selectable：antd 弹出菜单的选中态底色在本主题下对比度很差。
  const switcherItems = workspaces.map((workspace) => ({
    key: workspace.id,
    label: workspace.name,
    icon: workspace.id === currentWorkspace?.id ? <CheckOutlined /> : null,
  }));

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">GoodJob</div>

      <div className="sidebar-section">工作区</div>

      <Menu mode="inline" className="sidebar-menu" selectedKeys={["resume"]} items={MENU_ITEMS} />

      <div className="sidebar-spacer" />

      {/* 左下角：工作区切换在左，设置在最右。 */}
      <div className="sidebar-footer">
        <Dropdown
          trigger={["click"]}
          placement="topLeft"
          disabled={workspaces.length === 0}
          menu={{
            items: switcherItems,
            onClick: ({ key }) => {
              if (key !== currentWorkspace?.id) onSwitchWorkspace(key);
            },
          }}
        >
          <Button
            type="text"
            className="sidebar-workspace"
            aria-label="切换工作区"
            title={currentWorkspace?.name ?? "工作区"}
          >
            <span className="sidebar-workspace-name">{currentWorkspace?.name ?? "工作区"}</span>
            <DownOutlined className="sidebar-workspace-caret" />
          </Button>
        </Dropdown>

        <Tooltip title="设置">
          <Button
            type="text"
            className="sidebar-settings"
            aria-label="设置"
            icon={<SettingOutlined />}
            onClick={onOpenSettings}
          />
        </Tooltip>
      </div>
    </aside>
  );
}
