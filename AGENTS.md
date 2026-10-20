# AGENTS.md

GoodJob：一个带内嵌浏览器的求职助手桌面端。技术栈与理由见 `docs/STACK.md`。

## 硬约束

1. **UI 只用 antd 6 + @ant-design/x 2。** 不引入第二套组件库（lobe-ui / shadcn / MUI 都不行），
   不手写基础控件；页面只做组合。`@ant-design/x` 2.x 强依赖 `antd ^6.1.1`，不要降级 antd。
2. **渲染层不碰 Node。** `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。
   新增能力一律走 main 实现 + preload 的窄接口，不要为省事放开 nodeIntegration。
3. **凭据只在 main。** API Key 用 `safeStorage` 加密存**当前工作区的** `models.json`
   （目录 0700 / 文件 0600），不进渲染层、不进日志、不进仓库。
4. **不伪造回复。** 未配置模型时返回 `llm_not_configured` 并引导用户去设置，
   不要内置 mock provider 或示例数据。
5. **内嵌浏览器是 `WebContentsView`（原生视图）。** 任何 Modal / Drawer / Dropdown
   打开前必须隐藏它，否则会被它盖住。布局给浏览器留矩形区域，不要指望 CSS 裁剪。
6. **preload 必须打成 CommonJS。** 沙箱化 preload 不支持 ESM，产物固定 `out/preload/index.cjs`。
7. **浏览器自动化走 agent-browser，且必须锁 tab。** CDP 端口会同时暴露我们自己的 UI 窗口，
   模型不能直接拼 CLI：只允许白名单动作，永远先 `tab` 锁定面板 target 再执行。
   禁止 `eval` / `cookies` / `storage` / `state` / `network route` / `install` / `upgrade`。
   细节见 `docs/BROWSER-AGENT.md`。

## 组件知识库（必读）

antd / Ant Design X 的事实来源是 `.agents/skills/`，不是模型记忆（训练数据停在 antd 4/5、
X 1.x，本项目跑 antd 6 + X 2，存在破坏性变更）。

- `skills/antd`：官方 antd CLI 技能。**写任何 antd 代码前**先
  `antd info <组件> --version 6.6.6` 查 props，必要时 `antd demo` / `antd token` / `antd semantic`。
- `skills/x-*` 与 `skills/use-x-chat`：`@ant-design/x` 2.9.0 官方技能（中文版）。
- **改完 antd 代码必须 `antd lint ./src`**，弃用 API 清零。
- 来源、版本与更新命令见 `.agents/README.md`。

## 目录

```
.agents/       官方 antd / X Skills 与更新说明（组件知识库）
src/main/      窗口、BrowserPanel(WebContentsView)、ChatService、WorkspacesStore、ModelsStore、paths、IPC
src/preload/   contextBridge -> window.goodjob
src/renderer/  React + antd + X
src/shared/    三进程共用的类型与 IPC 频道名（保持零依赖）
```

## 工作区

**一个工作区 = 配置目录下的一个文件夹，目录名是 ID**，给人看的名字只存在索引里，
所以改名不用动磁盘。同一份软件可以并存多份工作区（不同的人 / 同一人不同时期）。
模型配置和数据都跟着工作区走，切换工作区等于换一整套配置。

```
~/.goodjob/                 0700
  workspaces.json           0600  索引：items[]（id / name / createdAt）+ currentId
  preferences.json          0600  机器级偏好：界面主题、界面字号
  workspaces/               0700
    <workspaceId>/          0700  目录名一律 ID（ws_ 前缀 + 12 位 hex）
      models.json           0600  模型供应商 + 加密 Key
      conversations/        0700
      cache/                0700
      logs/                 0700
```

- **外观（主题 / 字号）是机器级偏好，不进工作区**：存根目录 `preferences.json`，
  切工作区不跟着变。字号 10–18px，主题 `system | light | dark`。
- 首次启动时若索引为空（或整个目录为空），自动建一个「默认工作区」。
- 旧版本放在根目录的 `models.json` / `conversations` 会在此时迁移进默认工作区。
- 新增持久化数据请先在 `src/main/paths.ts` 的 `WorkspacePaths` 里登记路径，
  再由 `ensureWorkspaceDirs()` 建目录——不要绕过工作区往根目录写东西。

## 验证

```bash
pnpm typecheck   # tsconfig.node.json + tsconfig.web.json
pnpm build       # 必须无警告级错误
antd lint ./src  # antd 6 弃用 API 检查（应为 0 issues）
./start-test.command --check   # 同上两项的组合入口
./start-test.command           # 隔离实例启动（数据在 .tmp/test-home）
```

改动涉及 IPC 时，`src/shared/types.ts` 与 `src/preload/index.ts` 要同时更新。
新增持久化目录时，同步更新上面「工作区」一节与 `src/main/paths.ts`。
