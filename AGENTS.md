# AGENTS.md

GoodJob：一个带内嵌浏览器的求职助手桌面端。选型理由见 `docs/STACK.md`。

## 硬约束

1. **UI = shadcn/ui（Radix 原语）+ Tailwind 4；AI 对话区按 AI Elements 的 pattern 组装。**
   - 基础组件是**源码入库**的：`src/renderer/src/components/ui/`（registry 的 `radix-rhea` 风格）。
     加组件用 `pnpm dlx shadcn@latest add <name>` 或取
     `https://ui.shadcn.com/r/styles/radix-rhea/<name>.json`，落盘后把 `from "cn"` 改成
     `from "@/lib/utils"`、`@/registry/...` 改成 `@/components/ui/...`。
   - 样式只写 Tailwind utility + `globals.css` 的 token，**不新增全局 CSS 文件**，
     也不引第二套组件库（MUI / Chakra / Mantine / lobe-ui 都不行）。
   - AI Elements 是 pattern（`https://ui.shadcn.com/docs/ai-elements/base/<name>.md`），不是包：
     别装 `vercel/ai-elements`（2026-11 底废弃），按上游结构组合 message / bubble /
     message-scroller / input-group。
   - **状态变体只能通过 `globals.css` 的 `@custom-variant` 桥接**：registry 源码写
     `data-checked:` / `data-open:` / `data-horizontal:`，Radix 发的是
     `data-state="checked"` / `data-orientation="horizontal"`。删掉桥接，开关和弹层动画静默失效。
2. **渲染层不碰 Node。** `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。
   新增能力走 main 实现 + preload 窄接口，不要为省事放开 nodeIntegration。
3. **凭据只在 main。** API Key 用 `safeStorage` 加密存**配置目录的** `models.json`
   （目录 0700 / 文件 0600），不进渲染层、不进日志、不进仓库。
4. **不伪造回复。** 未配置模型时返回 `llm_not_configured` 并引导去设置；不内置 mock provider。
5. **内嵌浏览器是 `WebContentsView`（原生视图），多标签。** Dialog / Dropdown / Popover
   打开前必须隐藏它，否则被它盖住；布局给浏览器留矩形区域，不要指望 CSS 裁剪。
   标签池是 `main/browser/panel.ts` 的 `Map<tabId, WebContentsView>`，**只有活动标签的 view
   挂在窗口上**，其余 detach 但 webContents 活着（页面状态保留）。Agent 建/关/切标签必须走
   `PanelDescriptor`（构造进 `BrowserPanel`），**绝不直接调 CLI 的 `tab new`**——那会在同一个
   Chromium 里造一个我们拿不到 view 的隐形页面。
6. **preload 必须打成 CommonJS。** 沙箱化 preload 不支持 ESM，产物固定 `out/preload/index.cjs`。
7. **浏览器自动化走 agent-browser，且必须锁 tab。** CDP 端口会同时暴露我们自己的 UI 窗口：
   只允许白名单动作，永远先 `tab list` 再显式 `tab <targetId>` 绑定；标签↔target 对账靠
   `webContents.debugger` 的 `Target.getTargetInfo`（确定性，同站多标签也不串）。
   ⚠️ **会话未绑定时第一条命令不能带 `--pin-tab`**：它会调 `Target.createTarget`，
   Electron 不支持该 CDP 命令，直接报错。禁止 `eval` / `cookies` / `storage` / `state` /
   `network route` / `install` / `upgrade`。**run 结束要断开会话**（`endTask` →
   `cli.closeAsync()` + 停下锁定标签）：BOSS直聘这类站点一检测到 CDP 就自我重载，只有断开
   daemon 才安静。细节见 `docs/BROWSER-AGENT.md`。
8. **AI 能力只走 AI SDK。** 模型调用、流式、工具循环、结构化输出、embedding、多模态、
   MCP 一律用 `ai`(7.x) + `@ai-sdk/*`(4.x) 的现成能力，不自拼 fetch/SSE、不自己写
   provider 适配层或 tool loop。
   - 新增供应商 = `agent/model-provider.ts` 里一个 protocol case + 设置页一个 preset，
     不是新 HTTP 客户端。
   - 流式一律走 UI message part（`text` / `reasoning` / `tool-*` / `source` / `file` /
     `data-*`），不要往自定义 `ChatEvent` 加通道。
   - OpenAI 兼容协议用 `@ai-sdk/openai-compatible`，**不要**用 `@ai-sdk/openai` 的 `.chat()`：
     后者只解析 `delta.content` / `tool_calls`，中转站塞在同一条 delta 里的
     `reasoning_content` 会被静默丢弃。它和 `ai` 发版节奏不一致，升级前先看
     `@ai-sdk/provider` 版本要和 `@ai-sdk/openai` 一致（当前 `provider@4.0.33` /
     `provider-utils@5.0.67`），否则 `LanguageModelV4` 两个副本会报类型不兼容。
   - 工具用 `tool({ inputSchema: z.object(...) })`——v7 是 `inputSchema`，老教程的
     `parameters` 编译不过。副作用动作走 `toolApproval`，不要靠 prompt 祈使。

## 知识库（先查再用）

训练数据停在 shadcn 旧版 / AI SDK 4-5，本项目跑 Tailwind 4 + AI SDK 7，都是破坏性版本，
**不要凭记忆写**。

- **AI SDK 7**：文档随包发布，`node_modules/ai/docs/`（`03-ai-sdk-core/`、`03-agents/`、
  `07-reference/`），与安装版本严格对应；类型以 `node_modules/ai/dist/index.d.ts` 为准。
  不用看 `05-ai-sdk-rsc`（Next RSC）与 `03-ai-sdk-harnesses`（外部 harness），与 Electron 无关。
  AI SDK 只跑在 main，产物过 `pnpm typecheck` 即可。
- **shadcn/ui**：`src/renderer/src/components/ui/*.tsx` 就是事实来源，改组件直接改文件，
  props 看类型定义。文档 `https://ui.shadcn.com/docs/components/<name>`（加 `.md` 取正文）。
- **Tailwind 4 没有 config 文件**：token 全在 `src/renderer/src/globals.css`（shadcn 变量 +
  壳层语义变量 + `@custom-variant` 桥接 + markdown 排版）。
- `src/main/agent/skills/` 是**产品内置技能**（简历写作 / 简历优化与判断 / 面试准备），
  注入模型上下文、按场景由 `skill_read` 加载。迁移前的 `.agents/`、`skills/x-*` 开发知识库
  已废弃，不要按它们写代码。

## 界面结构（渲染层）

三层，从外到内：**48px 顶栏 → 平铺的左栏 → 白色内容块**。

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●   ⧉ ⧉                                    ← 顶栏 48px │  ← 只有自己的操作按钮
├──────────────────┬────────────────────────────────────────────┤
│ 🐝 GoodJob        │ ╭────────────────────────────────────────╮ │
│ ▸ 简历 / 岗位 …   │ │           对话 / 空状态                  │ │
│                  │ │  ╭──────────────────────────────────╮  │ │
│ 默认工作区 ▾ ⚙    │ │  ╰──────────────────────────────────╯  │ │
└──────────────────┴─╰────────────────────────────────────────╯─┘
   铺在 bg-shell 上        白色卡片（rounded-2xl）
```

- **左栏第一行就是品牌位**：`🐝 GoodJob` 本身是菜单项（`brand: true`），点它回到 Agent 首页；
  一列只出现一次 GoodJob，不要另起一行品牌标题。
- **顶栏是唯一放操作按钮的地方**：按钮永远在它控制的那一侧（左栏开关贴左，任务角标与
  浏览器开关贴右）。48px 高，`pl-[92px]` 让出 macOS 交通灯（实测 x 16–75 / y 19–30.5，
  中心 y≈24.5 落在中线上）。顶栏是 `drag` 区、body 是 `no-drag`；按钮 `variant` 用
  `secondary` 表示"当前是展开的"。
- **左栏不是卡片**：直接铺在 `bg-shell` 上，无描边无阴影——它属于窗口本身。选中项用
  `bg-foreground/[0.07]`（`bg-accent` 在这个底色上看不出来）。
- **内容块是白色卡片**：`rounded-2xl bg-card shadow-sm`，不带描边（靠 `--shell` 与 `--card`
  的明度差区分），只有一块。
- **浏览器是盖在内容块上的浮层**：`absolute inset-0` 铺满同一矩形（原生视图需要矩形落位），
  模块页留在下层不卸载，否则会话与「让 Agent 接管」监听会断。**Agent 后台跑不弹面板**
  （顶栏地球图标亮「agent 控制中」），只有用户批准了写动作（点击 / 填写 / 提交）才自动打开。
- **模块页常驻**：第一次进入才挂载，之后切模块只改 `visible / invisible`。会话状态住在页面
  里的 `useChat` 上，卸载会 `stop()` → main abort，整轮对话就废了。
- **不要往卡片里塞折叠把手**：收起/展开只在顶栏。对话内容列 `max-w-3xl` 居中，容器变窄只
  收窄容器，不改内容列宽。

## 结构

```
docs/           PRODUCT.md（产品方案）、ARCHITECTURE.md（技术定案）、STACK.md（选型）、
                BROWSER-AGENT.md（浏览器安全）、plan/（分期计划）
src/main/       index.ts 入口；app/（window / security / context 装配）；
                agent/（runtime / context / instructions / model-provider / workflow +
                  tools/ 按会话组装 + skills/ 内置技能，构建时 ?raw 内联）；
                browser/（panel.ts 多标签池 + automation/ CLI·动作·tab 锁定·审计·设置）；
                stores/（json-collection 底座 + conversations/resumes/models/notify/
                  preferences/workspaces/memory + domain/ 一个实体一个文件）；
                services/（tasks 后台任务、notify 邮件、pdf-export、model-probe）；
                ipc/（index + 分域注册）；workspace/（paths 路径登记、uploads）
src/preload/    contextBridge -> window.goodjob
src/renderer/   App / main / globals.css；config/modules 左栏菜单；
                components/{shell, chat, browser, document, settings, modules, ui}；
                components/ui/ai-elements 放 AI Elements 组件；routes/ExportRoute
src/shared/     三进程共用类型与 IPC 频道名（零依赖），types/ 下按域分文件 + index re-export
scripts/        图标管线（make-icons / render-svg）、dist-mac.sh、p*-smoke.mjs 一次性冒烟
```

## 工作区

**一个工作区 = 配置目录下一个文件夹，目录名是 ID**，给人看的名字只存索引（改名不动磁盘）。
**设置全局通用，数据跟着工作区走。**

```
~/.goodjob/                 0700
  workspaces.json           0600  索引：items[]（id / name / createdAt）+ currentId
  preferences.json          0600  基础设置：界面主题、字号、简历主题、自动检查更新
  models.json               0600  Agent 设置：模型供应商 + safeStorage 加密 Key
  notifications.json        0600  Agent 设置：SMTP / IMAP + 日报 / 周报调度（密码密文）
  agent-browser.json        0600  Agent 设置：开关（默认开）+ 自动通过（默认关）+
                                  提交限速 + 单站提交记账（每日上限按本地日历日重置）
  browser-playbooks.md      0600  Agent 设置：投递平台适配模板（用户手编），投递前读进指令
  workspaces/               0700
    <workspaceId>/          0700  ws_ + 12 位 hex
      conversations/        0700  一条对话一个 <key>.json（key = scope 或 scope#threadId，
                                  encodeURIComponent）+ threads.json 索引（标题/时间/条数）
      resumes/              0700  主简历们：一份一个文件夹（resume.md / history /
                                  tailored/<jobId>.md 与 history / scripts 话术含定稿
                                  sidecar / reports 评分报告 / upload 参考文件）
      companies/            0700  一个公司一个 <id>.json（含调研快照）+ upload/
      jobs/                 0700  一个岗位一个 <id>.json（JD + 匹配度）+ upload/、
                                  upload/<jobId>/（岗位工作台）
      applications/         0700  一个投递一个 <id>.json + pipeline.json（工作区级流水线）
                                  + upload/
      interviews/           0700  一场 <id>.json（config + 逐轮记录 + 总评；问答本体在
                                  conversations/ 的 interview:<id> 会话）+ upload/<id>/
      workflows/            0700  GoodJob 工作流快照：一个对话一个 <key>.json
                                  （单 agent 任务不落这里）
      uploads/              0700  GoodJob 会话上传的文件（工作区级，不跟对话走）
      memory.md             0600  工作区级长期记忆，每次会话注入 instructions
      cache/  logs/         0700  cache/agent-screenshots；agent.log 浏览器审计、
                                  chat.log 每次 run 的收发痕迹（都不含 prompt 与正文）
```

- 会话 scope：`orchestrator`（GoodJob）/ `resume` / `companies` / `jobs` / `applications` /
  `job:<jobId>` / `interview:<id>`。
- 设置全在根下、所有工作区共用：字号 10–18px，主题 `system | light | dark`，简历主题存模板 id
  （`components/document/templates`：`mint` / `graphite` / `navy`，预览与 PDF 共用）。设置弹窗
  只分「基础设置 / Agent 设置」两组，不展示工作区。
- **agent-browser 自己的状态目录是 `~/.agent-browser`**（daemon pid / socket / 会话恢复），
  不在 `~/.goodjob` 里——既有约定的偏离，设置页已告知，不要试图改 HOME 迁移它。
- 首次启动索引为空时自动建「默认工作区」。旧版的根目录 `conversations`/`cache`/`logs` 迁进默认
  工作区；旧版放在工作区里的设置文件搬回根目录（不覆盖已有设置）。
- 实体 ID：`co_` / `job_` / `app_` / `iv_` + 12 位 hex；引用存 id 不存内容，删除不级联
  （悬空引用由渲染层提示）。
- 后台任务注册表只在内存：同 type 同 target 去重，退出 / 切工作区即停，不做断点续跑。
- 新增持久化数据先登记 `WorkspacePaths` 再由 `ensureWorkspaceDirs()` 建目录——**不要绕过
  工作区往根目录写数据**；设置类反过来登记到 `RootPaths`（`rootPaths(root)`）。

## 验证

```bash
pnpm typecheck                  # tsconfig.node.json + tsconfig.web.json
pnpm build                      # 必须无警告级错误
./start-test.command --check    # 上面两项的组合入口
./start-test.command            # 隔离实例（数据在 .tmp/test-home）
```

- 界面改动必须浅色 + 深色各看一眼：`.dark` 下的 token 与 `@custom-variant` 桥接最容易在
  开关、弹层、标签页这类状态上出问题。
- 动 IPC 时 `src/shared/types/` 与 `src/preload/index.ts` 同时更新；新增持久化目录同步更新上面
  「工作区」一节与 `src/main/workspace/paths.ts` 的注释。
