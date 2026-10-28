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
5. **内嵌浏览器是 `WebContentsView`（原生视图），并且是多标签的。** 任何 Dialog /
   Dropdown / Popover 打开前必须隐藏它，否则会被它盖住。布局给浏览器留矩形区域，
   不要指望 CSS 裁剪。标签池是 `main/browser/panel.ts` 的一个 `Map<tabId, WebContentsView>`，
   **只有活动标签那个 view 挂在窗口上**，其余 detach 但 webContents 活着（页面状态保留）。
   Agent 的建/关/切标签必须走 `PanelDescriptor`（构造进 `BrowserPanel`），**绝不直接调
   CLI 的 `tab new`**——那会在同一个 Chromium 里造一个我们拿不到 view 的隐形页面。
6. **preload 必须打成 CommonJS。** 沙箱化 preload 不支持 ESM，产物固定 `out/preload/index.cjs`。
7. **浏览器自动化走 agent-browser，且必须锁 tab。** CDP 端口会同时暴露我们自己的 UI 窗口，
   模型不能直接拼 CLI：只允许白名单动作，永远先 `tab list` 再显式 `tab <targetId>` 绑定。
   标签↔target 的对账靠 `webContents.debugger` 的 `Target.getTargetInfo`（确定性，同站
   多标签也不会串）。⚠️ **会话未绑定时第一条命令不能带 `--pin-tab`**：它会尝试
   `Target.createTarget`，Electron 不支持该 CDP 命令，会直接报错。
   禁止 `eval` / `cookies` / `storage` / `state` / `network route` / `install` / `upgrade`。
   细节见 `docs/BROWSER-AGENT.md`。
8. **AI 能力只走 AI SDK。** 模型调用、流式、工具循环、结构化输出、embedding、
   多模态、MCP 客户端，一律用 `ai`（7.x）+ `@ai-sdk/*`（4.x）的现成能力，
   不要自己拼 fetch/SSE、不要自己写 provider 适配层或 tool loop。
   - 新增供应商 = `chat-service.ts` 里一个 protocol case + 设置页一个 preset，
     不是一个新 HTTP 客户端。
   - 流式一律走 AI SDK 的 UI message part（`text` / `reasoning` / `tool-*` /
     `source` / `file` / `data-*`），不要再往自定义 `ChatEvent` 里加通道。
   - OpenAI 兼容协议（`openai-chat`）用 `@ai-sdk/openai-compatible`，**不要**用
     `@ai-sdk/openai` 的 `.chat()`：后者只解析 `delta.content` / `tool_calls` /
     `annotations`，中转站塞在同一条 delta 里的 `reasoning_content` 会被静默丢弃，
     思考型模型界面上一个字都看不到。openai-compatible 发版节奏和 `ai` 对不齐，
     升级前先看它的 `@ai-sdk/provider` 版本，和 `@ai-sdk/openai` 用同一个（当前都锁
     `provider@4.0.33` / `provider-utils@5.0.67`），否则 `LanguageModelV4` 两个副本会
     报类型不兼容。
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

### 内置技能库

- `src/main/agent/skills/` 是产品内置技能（简历写作 / 简历优化与判断 / 面试准备），
  会被注入模型上下文，按会话场景通过 `skill_read` 加载。
- 它与上面的 `.agents/skills/` 无关：后者是迁移前的开发知识库，不会进产品。

## 界面结构（渲染层）

三层，从外到内：**48px 顶栏 → 平铺的左栏 → 白色内容块**。

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●   ⧉ ⧉                                    ← 顶栏 48px │  ← 只有自己的操作按钮
├──────────────────┬────────────────────────────────────────────┤
│ GoodJob          │ ╭────────────────────────────────────────╮ │
│ 工作区            │ │                                        │ │
│ ▸ 个人简历        │ │           对话 / 空状态                  │ │
│                  │ │                                        │ │
│                  │ │  ╭──────────────────────────────────╮  │ │
│ 默认工作区 ▾ ⚙    │ │  ╰──────────────────────────────────╯  │ │
└──────────────────┴─╰────────────────────────────────────────╯─┘
   铺在 bg-shell 上        白色卡片（rounded-2xl）
```

- **顶栏是唯一放操作按钮的地方**：左栏开关贴左，任务角标与浏览器开关贴右
  （按钮永远在它控制的那一侧），中间留给以后新加的功能。
  它 48px 高，`pl-[92px]` 让出 macOS 交通灯（实测窗口 x 16–75 / y 19–30.5，
  中心 y≈24.5，正好落在 48px 的中线上）。顶栏本身就是 `drag` 区，body 是 `no-drag`；
  按钮里 `variant` 用 `secondary` 表示"当前是展开的"。
- **左栏不是卡片**：直接铺在 `bg-shell` 上，没有描边没有阴影 —— 它属于窗口本身，
  而内容块才是被呈现的东西。选中项用 `bg-foreground/[0.07]`（`bg-accent` 在这个底色上看不出来）。
- **内容块是白色卡片**：`rounded-2xl bg-card shadow-sm`，不带描边（靠 `--shell` 与 `--card`
  的明度差区分）。只有一块 —— 模块页独占它，没有并列的第二块。
- **浏览器是盖在内容块上的浮层**：顶栏地球图标或 `agent:pane-open` 事件打开，
  用 `absolute inset-0` 铺满同一个矩形（WebContentsView 需要一块矩形落位），
  模块页留在下层不卸载，否则它的会话与「让 Agent 接管」监听会断。
- **不要往卡片里塞折叠把手**：收起/展开只在顶栏，卡片内部只放内容自身的控件。
- 对话内容列 `max-w-3xl` 居中，容器变窄只收窄容器，不改变内容列宽。

## 目录

```
.agents/        迁移前的 antd / X 知识库（历史归档，勿参考）
docs/           PRODUCT.md（产品方案）、ARCHITECTURE.md（技术方案定案）、STACK.md（选型）、BROWSER-AGENT.md（浏览器安全）、plan/（分期实施计划）
src/main/       Electron 主进程
  index.ts      Electron 入口：单实例、窗口生命周期、启动/退出编排
  app/          窗口装配（window.ts）、安全硬化（security.ts）、store/service 构造（context.ts）
  agent/        LLM Agent：runtime.ts（run / abort / context / compact / runDigest）、
                context.ts（预算 / 压缩 / 摘要）、instructions.ts（会话指令）、
                prompts/resume-format.ts、model-provider.ts、deps.ts、
                tools/（conversation / shared / resume / domain / job / interview / skills
                按会话组装）、
                skills/（内置技能库：resume-writing / resume-review / interview-prep；
                一个技能一个目录，SKILL.md + references/ 构建时以 ?raw 内联，
                系统提示只放索引，正文由 skill_read 按会话场景按需读取）
  browser/      内嵌浏览器：panel.ts（多标签 WebContentsView 池）；
                automation/（cli.ts 二进制定位与 spawn、actions.ts 受控动作与 argv、
                target.ts tab 锁定、runner.ts 任务包络与审计、settings-store.ts 开关与限速）
  stores/       持久化：json-collection.ts 通用底座、conversations / resumes / models /
                notify / preferences / workspaces / memory、domain/（companies / jobs /
                applications / pipeline / interviews 一个实体一个文件）
  services/     tasks.ts（后台任务：简历评估 / 完整性评分）、notify.ts（SMTP / IMAP /
                确认门 / 日报调度）、pdf-export.ts（printToPDF）、model-probe.ts
                （设置页拉模型列表 / 测连通性）
  ipc/          index.ts + browser / chat / resume / domain / settings / workspace 分域注册
  workspace/    paths.ts（WorkspacePaths 登记）、uploads.ts（会话上传目录与文件读取）
src/preload/    contextBridge -> window.goodjob
src/renderer/   React + shadcn/ui + Tailwind 4
  App.tsx / main.tsx / globals.css
  config/modules.tsx   左栏模块菜单注册表（简历/岗位/投递/面试/公司）
  lib/                 utils / format（通用格式化） / theme（主题解析）
  routes/ExportRoute.tsx  #export 导出路由（main.tsx 按 hash 分流，导出窗不挂 App）
  components/shell/    Sidebar / TasksBadge / ThemeApplier
  components/chat/     ChatPanel（消息列表）/ Composer（输入区）/ ToolTrace（工具与思考）/
                       AssistantMarkdown（AI 流式 Markdown）/ IPC transport / 会话 hooks
  components/browser/  BrowserPanel（内嵌多标签浏览器：标签条 + 工具条）
  components/document/ DocumentPreview（文档纸面）+ render / icons / templates
  components/settings/ SettingsModal + 外观 / 模型 / 通知 / 浏览器 / Skill 管理分区
  components/modules/  resume / companies / jobs / applications / interview 各模块页与
                       同目录弹窗；shared/ 放跨模块组件（ModelGate / Scorecard /
                       ResumeEditorCard / DeleteDialog / table-bits / module-page）
  components/ui/       shadcn 基础组件源码；ai-elements/ 放 AI Elements 组件
                       （bubble / message / message-scroller / attachment / input-group /
                       trace / code-block）
src/shared/     三进程共用的类型与 IPC 频道名（保持零依赖）
  types/        common / chat / browser / resume / domain / notify / models / workspace /
                tasks / export / ipc，index.ts 统一 re-export
scripts/        图标管线：make-icons.mjs 用 Electron 渲染 build/icon-drafts/logo.svg
                → build/icon.png + icon.icns（打包自动取后者，dev Dock 图标用前者）；
                dist-mac.sh 一键出 dmg（staging agent-browser → typecheck → 编译 →
                electron-builder，下载固定走 npmmirror 镜像）；p*-smoke.mjs 一次性冒烟

## 工作区

**一个工作区 = 配置目录下的一个文件夹，目录名是 ID**，给人看的名字只存在索引里，
所以改名不用动磁盘。同一份软件可以并存多份工作区（不同的人 / 同一人不同时期）。
模型配置和数据都跟着工作区走，切换工作区等于换一整套配置。

```
~/.goodjob/                 0700
  workspaces.json           0600  索引：items[]（id / name / createdAt）+ currentId
  preferences.json          0600  机器级偏好：界面主题、界面字号、Markdown 预览主题
  workspaces/               0700
    <workspaceId>/          0700  目录名一律 ID（ws_ 前缀 + 12 位 hex）
      models.json           0600  模型供应商 + 加密 Key
      conversations/        0700  滚动会话 <key>.json（resume / companies / jobs /
                                  applications / job:<jobId> / interview:<id>；
                                  复合 key 会 encodeURIComponent）
      resumes/              0700  主简历们：一份一个文件夹（resume.md / history /
                                  tailored/<jobId>.md 与 tailored/history / scripts 话术
                                  （含定稿 sidecar 与 history）/ reports 评分报告 /
                                  upload 用户上传的参考文件，Agent 用工具读）
      companies/            0700  公司档案：一个公司一个 <id>.json（含调研快照）+ upload/
                                  会话上传的参考资料
      jobs/                 0700  岗位档案：一个岗位一个 <id>.json（含 JD 与匹配度报告）
                                  + upload/（岗位会话）与 upload/<jobId>/（岗位工作台）
      applications/         0700  投递档案：一个投递一个 <id>.json + pipeline.json
                                  （工作区级状态流水线：有序阶段 + 终态标记）+ upload/
      interviews/           0700  模拟面试：一场一个 <id>.json（config 轮次/模式 + 逐轮
                                  记录 + 总评；问答消息本体在 conversations/ 的会话里）
                                  + upload/<interviewId>/（预留给将来，面试会话不发上传工具）
      notifications.json    0600  通知配置（P3 M3）：SMTP / IMAP 账户 + 日报 / 周报
                                  调度；密码 safeStorage 密文，跟随工作区（不同工作区
                                  可对不同邮箱），渲染层只见 hasPassword
      agent-browser.json    0600  浏览器自动化设置（P4）：启用开关 + 提交限速参数 +
                                  单站提交记账（每日上限按本地日历日重置）
      browser-playbooks.md  0600  投递平台适配指令模板（P4，用户手编），Agent 投递前读进指令
      memory.md             0600  工作区级长期记忆，Agent 每次会话注入 instructions
      cache/                0700  （agent 截图等可再生数据落 cache/agent-screenshots/）
      logs/                 0700  （agent.log：浏览器自动化逐步审计 JSONL，不含页面正文；
                                  chat.log：每次 Agent run 的收发痕迹 JSONL——供应商 / 协议 /
                                  baseURL origin / 模型 / 消息规模 / 首字节耗时 / chunk 类型
                                  直方图 / 错误，不含 prompt 与模型输出）
```

- **外观（主题 / 字号）与 Markdown 预览主题是机器级偏好，不进工作区**：存根目录
  `preferences.json`，切工作区不跟着变。字号 10–18px，主题 `system | light | dark`；
  Markdown 主题存模板 id（见 `components/document/templates`：`mint` / `graphite` / `navy`），
  设置页的「Markdown」标签页修改，预览与 PDF 导出共用。
- **agent-browser 自己的状态目录是 `~/.agent-browser`**（P4）：daemon pid / socket /
  会话恢复都在那里，不在 `~/.goodjob` 里——这是既有约定的一处偏离，设置页已如实
  告知；不要试图改 HOME 迁移它。
- 首次启动时若索引为空（或整个目录为空），自动建一个「默认工作区」。
- 旧版本放在根目录的 `models.json` / `conversations` 会在此时迁移进默认工作区。
- 领域实体（公司 / 岗位 / 投递 / 面试）ID 惯例：`co_` / `job_` / `app_` / `iv_` + 12 位 hex；
  引用存名不存内容（Job.companyId / Application.jobId / Interview.jobId），删除不级联——
  悬空引用由渲染层提示。
- 后台任务（`src/main/tasks.ts`）注册表只在内存：同 type 同 target 去重，应用退出 /
  切工作区即停、不做断点续跑（结果已落库可重跑）。
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
