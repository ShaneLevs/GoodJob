# AGENTS.md

GoodJob：一个带内嵌浏览器的求职助手桌面端。技术栈与理由见 `docs/STACK.md`。

## 硬约束

1. **UI = shadcn/ui（Radix 原语）+ Tailwind 4，AI 对话区按 AI Elements 的 pattern 组装。**
   - 基础组件是**源码入库**的：`src/renderer/src/components/ui/`（来自 shadcn registry，
     `radix-rhea` 风格）。要加新组件就 `pnpm dlx shadcn@latest add <name>` 或从
     `https://ui.shadcn.com/r/styles/radix-rhea/<name>.json` 取，落盘后把 `from "cn"`
     改成 `from "@/lib/utils"`、`@/registry/...` 改成 `@/components/ui/...`。
   - 样式只写 Tailwind utility + `globals.css` 里的 token，**不新增全局 CSS 文件**，
     也不引入第二套组件库（MUI / Chakra / Mantine / lobe-ui 都不行）。
   - AI Elements 是 pattern（`https://ui.shadcn.com/docs/ai-elements/base/<name>.md`），
     不是包；我们按它的结构组合 message / bubble / message-scroller / input-group。
     上游独立包 `vercel/ai-elements` 2026-11 底废弃，**不要装它**。
   - **状态变体只能通过 `globals.css` 的 `@custom-variant` 桥接**：registry 源码写
     `data-checked:` / `data-open:` / `data-horizontal:`，Radix 原语发的是
     `data-state="checked"` / `data-orientation="horizontal"`。删掉桥接，开关和弹层动画会静默失效。
2. **渲染层不碰 Node。** `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。
   新增能力一律走 main 实现 + preload 的窄接口，不要为省事放开 nodeIntegration。
3. **凭据只在 main。** API Key 用 `safeStorage` 加密存**当前工作区的** `models.json`
   （目录 0700 / 文件 0600），不进渲染层、不进日志、不进仓库。
4. **不伪造回复。** 未配置模型时返回 `llm_not_configured` 并引导用户去设置，
   不要内置 mock provider 或示例数据。
5. **内嵌浏览器是 `WebContentsView`（原生视图）。** 任何 Dialog / Dropdown / Popover
   打开前必须隐藏它，否则会被它盖住。布局给浏览器留矩形区域，不要指望 CSS 裁剪。
6. **preload 必须打成 CommonJS。** 沙箱化 preload 不支持 ESM，产物固定 `out/preload/index.cjs`。
7. **浏览器自动化走 agent-browser，且必须锁 tab。** CDP 端口会同时暴露我们自己的 UI 窗口，
   模型不能直接拼 CLI：只允许白名单动作，永远先 `tab` 锁定面板 target 再执行。
   禁止 `eval` / `cookies` / `storage` / `state` / `network route` / `install` / `upgrade`。
   细节见 `docs/BROWSER-AGENT.md`。
8. **AI 能力只走 AI SDK。** 模型调用、流式、工具循环、结构化输出、embedding、
   多模态、MCP 客户端，一律用 `ai`（7.x）+ `@ai-sdk/*`（4.x）的现成能力，
   不要自己拼 fetch/SSE、不要自己写 provider 适配层或 tool loop。
   - 新增供应商 = `chat-service.ts` 里一个 protocol case + 设置页一个 preset，
     不是一个新 HTTP 客户端。
   - 流式一律走 AI SDK 的 UI message part（`text` / `reasoning` / `tool-*` /
     `source` / `file` / `data-*`），不要再往自定义 `ChatEvent` 里加通道。
   - 工具用 `tool({ inputSchema: z.object(...) })`——v7 是 `inputSchema`，老教程的
     `parameters` 会编译不过。浏览器动作的白名单就体现在 tool 注册表里，
     副作用动作走 `toolApproval`，不要靠 prompt 祈使。
   - 版本必须成对：`ai@7` 配 `@ai-sdk/*@4`（provider 规范 v4），不要单独升降一边。

## 知识库（必读）

多数组件与 SDK 都有本地事实来源，**先查再用**，不要凭记忆写（训练数据停在 shadcn 旧版、
AI SDK 4/5，本项目跑 Tailwind 4 + AI SDK 7，都是破坏性版本）。

### AI SDK 7

- **文档随包发布**：`node_modules/ai/docs/`（250+ mdx，与安装版本严格对应）。
  查 API 看 `03-ai-sdk-core/`、`03-agents/`、`07-reference/`，不要搜网上教程。
- 类型以 `node_modules/ai/dist/index.d.ts` 为准；`ai@7` 与 `@ai-sdk/*@4` 成对升级。
- 不用看的：`05-ai-sdk-rsc`（Next.js Server Components）、`03-ai-sdk-harnesses`
  （Claude Code / Codex 那类外部 harness），与 Electron 架构无关。
- AI SDK 跑在 main 进程，产物只需过 `pnpm typecheck`；渲染层只消费序列化后的 part。

### shadcn/ui + AI Elements

- **以入库源码为准**：`src/renderer/src/components/ui/*.tsx` 就是事实来源，
  改组件直接改文件；`props` 看类型定义，不要凭 shadcn 旧版文档的记忆写。
- 文档：`https://ui.shadcn.com/docs/components/<name>`，AI 对话结构：
  `https://ui.shadcn.com/docs/ai-elements/base/<name>`（可加 `.md` 直接取正文）。
- 取组件源码：`https://ui.shadcn.com/r/styles/radix-rhea/<name>.json`。
- **Tailwind 4 没有 config 文件**：token 全在 `src/renderer/src/globals.css`
  （shadcn 变量 + 壳层语义变量 + `@custom-variant` 桥接 + markdown 排版）。
- `.agents/skills/antd`、`skills/x-*` 是迁移前的历史知识库，**已不适用**，不要再按其写代码。

## 界面结构（渲染层）

三层，从外到内：**48px 顶栏 → 平铺的左栏 → 白色内容块**。

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●   ⧉ ⧉                                        ← 顶栏 48px │  ← 只有自己的操作按钮
├──────────────────┬────────────────────────────────────────────┤
│ GoodJob          │ ╭──────────────────────╮ ╭───────────────╮ │
│ 工作区            │ │                      │ │ 工作台         │ │
│ ▸ 个人简历        │ │   对话 / 空状态        │ │───────────────│ │
│                  │ │                      │ │ Agent 打开的   │ │
│                  │ │  ╭────────────────╮  │ │ 标签页         │ │
│ 默认工作区 ▾ ⚙    │ │  ╰────────────────╯  │ │               │ │
└──────────────────┴─╰──────────────────────╯ ╰───────────────╯─┘
   铺在 bg-shell 上        白色卡片（rounded-2xl）      白色卡片
```

- **顶栏是唯一放操作按钮的地方**：左栏开关贴左、右栏开关贴右（按钮永远在它控制的那一侧），
  中间留给以后新加的功能。
  它 48px 高，`pl-[92px]` 让出 macOS 交通灯（实测窗口 x 16–75 / y 19–30.5，
  中心 y≈24.5，正好落在 48px 的中线上）。顶栏本身就是 `drag` 区，body 是 `no-drag`；
  按钮里 `variant` 用 `secondary` 表示"当前是展开的"。
- **左栏不是卡片**：直接铺在 `bg-shell` 上，没有描边没有阴影 —— 它属于窗口本身，
  而内容块才是被呈现的东西。选中项用 `bg-foreground/[0.07]`（`bg-accent` 在这个底色上看不出来）。
- **内容块是白色卡片**：`rounded-2xl bg-card shadow-sm`，不带描边（靠 `--shell` 与 `--card`
  的明度差区分）。对话和右栏是两块并列的卡，中间 8px 间隙里是一条 1px 可拖拽线。
- **不要往卡片里塞折叠把手**：收起/展开只在顶栏，卡片内部只放内容自身的控件
  （右栏的标签页关闭按钮除外）。
- 对话内容列 `max-w-3xl` 居中，右栏展开时只收窄容器，不改变内容列宽。

## 目录

```
.agents/        迁移前的 antd / X 知识库（历史归档，勿参考）
src/main/       窗口、BrowserPanel(WebContentsView)、ChatService、WorkspacesStore、ModelsStore、paths、IPC
src/preload/    contextBridge -> window.goodjob
src/renderer/   React + shadcn/ui + Tailwind 4
  globals.css     唯一的样式入口：token、状态变体桥接、markdown 排版
  components/ui/  shadcn 组件源码（可改）
  components/     业务组件（AI Elements pattern 在这里组装）
src/shared/     三进程共用的类型与 IPC 频道名（保持零依赖）
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
./start-test.command --check   # 同上两项的组合入口
./start-test.command           # 隔离实例启动（数据在 .tmp/test-home）
```

界面改动必须浅色 + 深色各看一眼：`.dark` 下的 token 与 `@custom-variant` 桥接
最容易在开关、弹层、标签页这类状态上出问题。

改动涉及 IPC 时，`src/shared/types.ts` 与 `src/preload/index.ts` 要同时更新。
新增持久化目录时，同步更新上面「工作区」一节与 `src/main/paths.ts`。
