# P1 实施计划：Agent 运行时内核 + 简历闭环

> **目录说明（2026-10-27）**：代码已按职责重组，本文路径已同步为当前结构——
> main 的持久化在 `src/main/stores/`，LLM Agent 在 `src/main/agent/`，
> 浏览器面板与自动化在 `src/main/browser/`。

> 状态：已实现（2026-10-24 批准并落地）。对应 `docs/ARCHITECTURE.md` §8 的 P1，细化后的执行版。
> 实现偏差：编辑器用 `@milkdown/crepe`（即时渲染）而非 CodeMirror；装配落盘由渲染层
> `conversations:sync` 完成。**验收后 UI 简化（2026-10-24）**：删除独立「对话」页
> （`ConversationKey` 收窄为 `"resume"`）；编辑器卡撤掉简历切换 / 导入按钮 / 文档标签行，
> 上传旧简历并入 Chat 输入框左下角「+」，编辑器卡只留保存状态 + 保存 + 冲突条
> （定制稿文件与 Agent 工具保留，暂无 UI 浏览入口）。
> **编辑器换型（2026-10-25）**：Milkdown 退出，改为编辑 / 预览双模式——CodeMirror 源码
> 编辑 + 通用文档预览组件 `DocumentPreview`（marked `==高亮==`、`#### A | B | C` 特有语法
> 按模板 CSS 渲染，`src/renderer/src/components/document/`，简历外其他文档展示复用），参考 Typora
> 简历模板项目（阿杆 markdown-resume-template 的 mint 主题）。
> **上传与对话反馈改造（2026-10-25）**：上传改为文件落盘（`resumes/<id>/upload/`，
> 消息只带 `data-upload` part，不进模型输入），Agent 用 `resume_upload_list/read` 自行读取；
> 助手消息脚补耗时（`metadata.durationMs`）与复制按钮，思考中用 shimmer 动效，
> 输入框附件 chips 走 shadcn Attachment 组件，去掉快捷键提示。
> 遗留人工验收：浅色/深色各过一遍、接真实模型跑通上传→共编→定制全流程、
> 压缩触发观察。后续 Pn 计划也放本目录。

范围与决策已确认：无用户可见"会话"概念（每模块一条滚动对话，自带压缩 + 长期记忆）；
编辑器用即时渲染型 Markdown（Milkdown Crepe，CodeMirror 并排预览作 fallback）；
上传解析 PDF/DOCX；定制简历先支持粘贴 JD 生成。岗位/投递/面试/公司页为占位。

## 新增依赖（均无构建脚本，不涉及 pnpm-workspace allowBuilds）

- `@ai-sdk/react`（与 ai@7 配对，按 peer 解析锁定）— useChat / addToolApprovalResponse（后者 P1 仅预留）
- `@milkdown/kit` + `@milkdown/preset-crepe` + `@milkdown/react` — Typora 式即时渲染编辑器，
  纯 npm 打包无 CDN（若序列化保真或打包不顺，降级为 @uiw/react-codemirror + 并排预览）
- `unpdf`（PDF 抽文本，纯 ESM 无原生依赖）、`mammoth`（DOCX 抽文本）

## 一、主进程

**1. `src/main/agent/runtime.ts`（替代并删除 chat-service.ts）**
- `send({ key, runId, messages })`：ModelsStore.resolveActive() → 未配置则发 error chunk
  （`llm_not_configured`，不伪造）
- 按 key 组装 `ToolLoopAgent`（模型每次动态解析，agent 每次新建）：`instructions` =
  模块指令 + `memory.md` 全文 + 滚动摘要；`tools` = 该模块工具注册表；
  `toolApproval` 配置位预留（P1 无需审批的副作用工具）
- `agent.stream({ messages: convertToModelMessages(uiMessages) })` → `toUIMessageStream`
  → for-await 每个 UIMessageChunk 发 `chat:chunk`（payload 带 key+runId）
- onFinish：把最终 assistant 消息持久化进 conversations store，然后异步 `maybeCompact`
- abort 按 key 管理 AbortController；workspace 切换 / before-quit 全部 abort

**2. `src/main/stores/conversations.ts`** — 每模块一个滚动会话文件
`conversations/<key>.json`：`{ key, type, messages: UIMessage[], summary, summarizedFrom, updatedAt }`。
压缩：模型输入 = 指令 + memory + summary + `messages.slice(summarizedFrom)`；
当尾部字符量超阈值（先定 ~50k chars，可配）→ 用同模型 generate() 把
[旧 summary + 已被覆盖消息] 再摘要，推进 summarizedFrom。UI 完整历史不截断。
`useWorkspace()` 随工作区重载。

**3. `src/main/stores/resumes.ts`** — `resumes/index.json`（items + currentId）+
`resumes/<id>/{resume.md, meta.json, history/, tailored/}`。
API：list/create/rename/setCurrent/delete、read/save（写前快照到 `history/<ts>.md`，
保留最近 50 份）、tailored 的 list/read/write（文件名 slug 校验）。
fs.watch 当前简历目录 → 防抖后广播 `file:changed`。
`importResumeFile()`：dialog 选 pdf/docx/md/txt → unpdf/mammoth 抽文本 →
返回 `{fileName, text}`（结构化交给 Agent，此处不做 LLM）。

**4. `src/main/stores/memory.ts`** — `<workspace>/memory.md` 读写 + 注入 instructions +
`memory.read/write` 工具定义（写前同样快照到 history 机制简化版：整文件覆盖）。

**5. 工具注册表**（P1 全部在 resume 模块会话；对 chat 模块只给 memory 工具）：
`resume.read` / `resume.write` / `resume.tailored.list` / `resume.tailored.read` /
`resume.tailored.write` / `memory.read` / `memory.write`。
全部 `tool({ inputSchema: z.object(...) })`，执行在 main，写路径一律锁定在
resume 文件夹或 memory.md 内。

**6. `src/main/workspace/paths.ts`** — WorkspacePaths 增加 `resumes`，ensureWorkspaceDirs 创建。

**7. `src/main/ipc/` / `src/main/index.ts`** — 新频道注册；
服务构造顺序：Workspaces → Models → Conversations/Resume/Memory → AgentRuntime；
`file:changed` 广播。

## 二、shared + preload（保持零依赖）

- `IPC` += `chat:chunk`、`chat:send` 载荷改为 `{key, runId, messages}`、`chat:abort(key)`、
  `conversations:get`、`resume:list/create/rename/delete/select/read/save/import`、`file:changed`
- shared 里消息/chunk 用宽松结构类型（不 import ai），渲染层再断言为 UIMessage/UIMessageChunk
- preload 按现有惯例加窄接口；`env.d.ts` 类型随之更新

## 三、渲染层

**1. `chat/ipc-chat-transport.ts`** — 实现 `ChatTransport<UIMessage>`：
`sendMessages` → invoke `chat:send`，把 `onChunk` 订阅（按 key+runId 过滤）桥接成
`ReadableStream<UIMessageChunk>`；abortSignal → `chat.abort`；`reconnectToStream` 返回 null。

**2. `chat/use-module-chat.ts`** — 挂载时 `conversations:get(key)` 取初始 messages →
`useChat({ id: key, messages, transport })`；暴露 send/stop/status/error。

**3. ChatPanel 重构** — 数据源改为 UIMessage[]（parts 渲染）：text part → 现有 Markdown
组件；tool part → 紧凑工具条（图标+名称+状态：运行中/完成/等待批准，可展开输入输出）；
保留模型下拉、overlay 上报、停止按钮、AI Elements 结构。

**4. 模块路由** — `App.tsx`：菜单 key 状态 + 中间卡切换；Sidebar 改模块菜单
（对话/简历/岗位/投递/面试/公司，lucide 图标，选中 `bg-foreground/[0.07]`，
工作区下拉+设置保留在底部）。页面：`ChatPage`（整宽对话）、
`ResumePage`（Resizable：Chat | 编辑器卡）、其余四页 Empty 占位（注明 P2）。

**5. `ResumeEditorCard.tsx`** — Milkdown Crepe 即时渲染编辑；
工具条：简历切换/新建/重命名、上传解析按钮（调 `resume:import` 后把文本作为用户消息
发进会话，Agent 全程可见地整理写入）、定制简历列表（查看/由对话新建）；
状态条：未保存/已保存/「文件已被 Agent 修改」（非脏热更新，脏时二选一：
载入新版 / 保留我的）；Cmd+S 保存。

## 四、指令（instructions）草案

- resume 模块：角色（简历协作 Agent）、resume.md 章节模板约定、文件工具用法与快照机制、
  定制简历流程（读主简历 + 用户粘贴的 JD → 写 `tailored/<slug>.md`）、
  memory.md 用法（沉淀用户偏好与简历约定）。
- chat 模块：通用助手 + memory 注入。

## 五、文档同步（实现完成后）

- `docs/ARCHITECTURE.md` / `PRODUCT.md`：会话模型定案（无列表、单滚动会话 + 压缩 +
  memory.md）、编辑器与解析依赖、chat:chunk 协议
- `AGENTS.md`：目录/工作区小节同步新增路径（resumes/、memory.md）

## 六、验证

1. `pnpm typecheck` + `pnpm build` 无警告
2. `./start-test.command` 隔离实例手测：配模型 → 简历页上传 PDF → 观察 Agent 工具条与
   编辑器实时更新 → 手动编辑保存 → Agent 再改 → 冲突 banner → 重启恢复滚动会话与简历 →
   粘贴 JD 生成定制简历 → 对话页通用会话 → memory.md 沉淀
3. 浅色 + 深色各过一遍（AGENTS.md 硬要求）
4. 临时调低压缩阈值观察摘要触发与恢复

## 明确不做（P1）

会话列表/切换；toolApproval UI（仅 runtime 预留）；岗位/公司/投递实体与评分话术（P2）；
右栏 pane 扩展与 agent:pane-open（P3）；PDF 导出、语音、通知（P3+）；`.goodjob` 目录名不变。
