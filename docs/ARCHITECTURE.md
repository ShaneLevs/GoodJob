# 技术方案

> 状态：2026-10-24 定稿（产品决策见 `docs/PRODUCT.md`），P1 已于同日实现；
> 2026-10-27 完成目录重构（main 按 app / agent / browser / stores / services / ipc / workspace 分层，
> renderer 按 shell / chat / browser / document / settings / modules / ui 分组，shared types 按域拆分）。
> 与 `STACK.md`（选型）、`BROWSER-AGENT.md`（浏览器安全）互补；本文讲产品需求如何映射到代码。
> 未实现部分以 Pn 标注分期。

## 1. 分层

```
renderer   模块页（内嵌 Chat + 模块内容）· 浏览器浮层 · 模块菜单
preload    window.goodjob 窄接口（新增 agent / file / notify 频道）
main       app/context.ts（store / service 装配）
             ├─ agent/runtime.ts（ToolLoopAgent + 指令 + 压缩）
             │    └─ agent/tools/*（file / domain / task / notify / browser / skill）
             │        + agent/skills/*（内置技能：SKILL.md + references，按需加载）
             ├─ stores/*（conversations / resumes / models / … + domain/*）
             ├─ services/*（tasks / notify / pdf-export）✅ P3
             └─ browser/automation/*（agent-browser，P4，见 BROWSER-AGENT.md）
```

## 2. 定案

| # | 决策 | 理由 / 说明 |
| --- | --- | --- |
| 1 | 主简历 = Markdown 文件为唯一源 | 人机共编最自然；结构化需求（自动填表等）由 Agent 使用时现场提取，不维护第二份源 |
| 2 | 一切 LLM 环节统一 Agent 模式 | 对话、模块按钮触发的技能、评分、解析、模拟面试全部走 AI SDK 工具循环（`ToolLoopAgent` / `streamText` + tools + `toolApproval`），没有裸 chat 调用 |
| 3 | Agent 文件工具按任务限定目录 | 简历任务只能读写 `resumes/<id>/`；realpath 校验，拒绝 `..` 与 symlink 逃逸；跨实体读写走类型化 domain 工具，不给裸 fs |
| 4 | 存储用 JSON 文件，不引 SQLite | 个人量级（数百条封顶）启动载入内存过滤足够；与现有 store 模式一致，零原生依赖 |
| 5 | 简历只有 Markdown，PDF 后置 | P5 接开源 Markdown 简历渲染组件，模板保持简洁，可微调 Markdown 语法 |
| 6 | 匹配度不用 embedding | 多供应商下 embedding 未必可用；LLM 直接比对 |
| 7 | 通知整条流程封装为独立工具 | 模型只见 `notify` / `requestConfirmation` 两个工具与 approved / timeout 结果；SMTP/IMAP 凭据 safeStorage 加密，不进渲染层、不进日志 |
| 8 | 语音后置（P5） | 文本先行；届时用 AI SDK `transcribe`（ASR）+ `generateSpeech`（TTS） |
| 9 | 门控分级 | 在场：`toolApproval` 界面审批；离场：邮件确认工具。副作用动作必过其一 |
| 10 | 无会话列表 | 每个模块一条滚动会话（`conversations/<key>.json`）；预算按模型配置的 `contextWindow`（默认 200K）算，用到约 90%（并为 `maxOutputTokens` 预留空间）就把更早消息压缩进摘要，切点对齐到 user 消息；完整历史始终保留，Agent 可用 `conversation_search` / `conversation_read` 回查被压缩的原文。渲染层有上下文用量气泡（可手动压缩） |

## 3. 目录布局（工作区内）

```
workspaces/<id>/
  models.json                            供应商配置（Key 为 safeStorage 密文；通知配置 P3 同级）
  conversations/<key>.json               滚动会话（UIMessage[] + 摘要 + summarizedFrom；
                                         key = 模块名或 job:<jobId>，文件名整体 encodeURIComponent）
  resumes/<resumeId>/                    一份主简历一个文件夹（简历类任务的文件作用域）
    index.json  resume.md  history/      索引 / 正文（唯一源）/ 覆盖前快照
    tailored/<jobId>.md (+ history/)     岗位定制简历（与岗位 1:1；P1 旧 name 文件兼容读取）
    scripts/<jobId>.md (+ .json + history/)   岗位话术：当前版 + 定稿 sidecar（final /
                                         finalizedAt / sha 指纹，改过即「待重新定稿」）+ 版本快照
    reports/<ts>-integrity.json          主简历完整性报告（score + 模型生成的整页 HTML；
                                         后台任务写入，保留历史；旧版结构化报告兼容读取）
    upload/                              用户上传的参考文件（Agent 用工具读取）
  companies/<id>.json                    公司档案（含调研快照 research + researchedAt）
  jobs/<id>.json                         岗位（JD 原文 + 匹配度报告 matchReport）
  applications/<id>.json                 投递（jobId + 状态时间线 + Offer 字段）
  applications/pipeline.json             工作区级状态流水线：有序阶段 + 终态标记（可增删改名）
  interviews/<id>.json                   模拟面试（P3 M1）：config { rounds, mode } + 结构化
                                         逐轮记录 + 总评；问答消息本体在 conversations/ 的
                                         interview:<id> 会话里
  notifications.json                     通知配置（P3 M3）：SMTP / IMAP 账户 + 日报 / 周报
                                         调度；密码 safeStorage 密文（通知配置跟随工作区）
  memory.md  cache/  logs/
```

- 领域实体 ID：`co_` / `job_` / `app_` / `iv_` + 12 位 hex；一个实体一个 JSON 文件（0600），
  全量载内存（`src/main/stores/json-collection.ts` 的通用底座 + `src/main/stores/domain/`
  下的实体 store；`stores/domain/interviews.ts` 复用同一底座）。
  引用存名不存内容，删除不级联，悬空引用由渲染层提示。
- 公司名的确定性去重：`CompaniesStore.findByName` 先比归一化全名（忽略大小写 / 空格 /
  标点），再比去掉「有限公司」这类法人后缀的核心名；`ensure()` 有则返回、无则新建。
  岗位建档（`job_create` / `job_update` 的 `companyName`）走它自动入库，避免同一家公司
  被建成「字节跳动」「字节跳动有限公司」两条。只做确定性匹配，不做模糊打分。
- 集合写入广播：`json-collection.ts` 的 `onCollectionChanged` 在每次 `put` / `remove`
  之后把集合名推给渲染层（`domain:changed`），模块页据此重拉——Agent 在右边对话里建的
  岗位 / 公司不必等切模块才出现。
- 新目录 / 文件一律先登记 `src/main/workspace/paths.ts` 的 `WorkspacePaths`，再由 `ensureWorkspaceDirs()`
  创建——不绕过工作区往根目录写东西。通知配置跟随工作区（不同工作区可对不同邮箱）。

## 4. AgentRuntime

- `agent/runtime.ts` 承载 AgentRuntime：自定义 `ChatEvent` 通道迁移为 AI SDK UIMessage
  part 流（硬约束 8）；渲染层消费 `text` / `tool-*` / `data-*` part，工具执行过程同时就是
  浏览器工具条与 `logs/agent.log` 审计的数据源。
- 会话类型：`ConversationKey` = `"resume" | "companies" | "jobs" | "applications" | \`job:${jobId}\` | \`interview:${id}\``
  （复合 key 是通用机制；interview:<id> 自 P3 M1 起）。没有独立「对话」页——
  产品决策：所有 LLM 交互都发生在具体模块里。UIMessage[] 与元数据持久化到 `conversations/`。
- 会话落盘节奏（`renderer/components/chat/use-module-chat.ts`）：空闲时消息一变就写，
  run 进行中按 600ms **节流**写（不是防抖——token 连续到达时防抖会被一直取消，永远不落盘）。
  以前只在 run 结束（ready / error）时 sync，于是「刚发出 / 流到一半」的消息只在内存里，
  页面一卸载整轮就没了。写入带 `workspaceId`（`conversations.get` 拿到的），main 对不上
  当前工作区就丢弃——页面卸载时的收尾写入可能晚于「切换工作区」，不能写串。
- 模块页常驻（`App.tsx` 的 `mountedModules`）：会话状态住在页面里的 `useChat` 实例上，
  `useChat` 卸载时会 `chat.stop()` → transport cancel → main `abort`，那一轮就废了。
  所以模块页第一次进入才挂载，之后只切 `visible / invisible`（保留布局，滚动锚定不丢）；
  岗位表与二级工作台同时挂载，钻进某个岗位不打断表格那边的对话。
- 工具注册表按域分组（file / domain / task / notify / browser / skill），入口在
  `agent/tools/index.ts` 的 `toolsFor(key)`，各域工厂在 `agent/tools/` 下按会话类型组装：领域会话拿类型化 CRUD（写操作的枚举 / 引用校验在 store，错误以 tool-error 带回
  模型）；`job:<jobId>` 会话的工具全部锁定该岗位（定制稿 / 话术无 id 参数）；
  `interview:<id>` 会话材料全只读（主简历 / 定制稿 / 话术 / JD），唯一写入口是面试记录
  本身——`interview_round_log`（逐轮落账，序号由 store 分配）与 `interview_submit_review`
  （收束并写总评），轮次进度每次 send 由 runtime 注入指令（硬约束不靠模型自觉）。
  skill（评分）走后台任务：模块页按钮与会话内工具触发的是同一个 `TaskManager.run`，
  状态经 `task:event` 推渲染层，结果落库（匹配度报告写回岗位、完整性报告进 `reports/`）。
- 内置技能库（`agent/skills/`）：一个技能一个目录（`SKILL.md` + `references/*.md`），
  构建时以 `?raw` 内联进主进程产物；系统提示只注入当前会话适用的技能索引，
  正文由 `skill_read` 按需读取。技能只提供方法论，不授予新工具；场景过滤在
  `skills/index.ts` 的 `scenarioOf(key)`，当前给简历会话与 `job:<jobId>` 工作台。
  同一份注册表经 `skills:list` 暴露给设置 → Skill 管理（只读查看元数据与全部文件正文）。
- 后台 `resume-integrity` 任务直接复用 `resume-review` 的 `references/scoring-rubric.md`
  作为评分规则，输出 `score` + 整页 HTML；评分卡在 sandbox iframe 里渲染，
  渲染前经 DOMPurify 清洗并注入 CSP。
- 审批分级：只读自动放行；工作区内写文件自动放行但先快照到 `history/`；
  邮件外发、浏览器写动作（browser_act）走 `toolApproval` 界面审批；浏览器提交
  （browser_submit）双重门——在场（默认）界面审批并展示「将要提交的内容摘要」，
  离场（用户 ≥10 分钟无操作才允许）走 request_confirmation 邮件确认门。

## 5. Markdown 人机共编协议

磁盘文件是唯一事实源：main 侧 fs.watch 监听 → `file:changed` 推给渲染层 →
编辑器无本地修改时热重载；有未保存修改时提示用户选择（保留我的 / 载入新版本）。
用户手动保存与 Agent 工具写入都先快照到 `history/`，冲突最多丢一次编辑，不丢历史。
Agent 写入以整文件覆盖为主，避免局部补丁错位。

## 6. NotifyService（✅ P3 M3，2026-10-25）

- 发送用 `nodemailer`（SMTP），回信监控用 `imapflow`（连接空闲自动进 IMAP IDLE，
  新邮件 `exists` 事件即查；tick 每分钟兜底轮询，应对各家 IDLE 行为不一），
  调度是 main 内分钟级 tick，不引 cron 依赖。
- 确认状态机：`sent`（唯一 token 写入 Message-ID / Subject）→ `waiting ≤10min` →
  回信（按 In-Reply-To / References / Subject 匹配 token，内容不限）⇒ `approved`；
  超时 → `reminded` 再等一轮 → 仍无回信 ⇒ `timeout`（未放行，Agent 走取消分支）。
  确认邮件发给用户自己的邮箱，寄出的原信按 Message-ID 排除、不算回信。
- 对模型的接口只有两个工具：`notify(summary)` 与 `request_confirmation(subject, body)`
  → `"approved" | "timeout"`。实现为长时 async 工具（可 abort，停止 run 即取消门）；
  并发量大再改票据回调式。两个工具挂在 applications 会话（P4 自动投递接入 job 会话
  时扩展）；`notify` 挂 `toolApproval` 界面审批（P1 预留位兑现），确认门工具本身即门。
- 日报 / 周报 = 调度器到点发起一次 Agent 运行（`AgentRuntime.runDigest`：generateText +
  notify 工具，汇总 P2 实体快照，无内容时如实说）；到点即记账、当日不重试，补发走
  设置页「立即生成」。配置存 `<workspace>/notifications.json`（0600，密码 safeStorage
  密文），设置窗「通知」节维护并带逐项「测试连接」（SMTP verify / IMAP verifyOnly）。

## 7. 代码落点

| 模块 | 当前落点 |
| --- | --- |
| Electron 入口 / 装配 | `src/main/index.ts`、`src/main/app/context.ts`、`src/main/app/window.ts` |
| Agent 运行时 | `src/main/agent/runtime.ts`（run / abort / context / compact / runDigest） |
| 上下文预算与压缩 | `src/main/agent/context.ts` |
| 会话指令 / persona | `src/main/agent/instructions.ts`、`src/main/agent/prompts/` |
| 工具注册表 | `src/main/agent/tools/index.ts` + `tools/`（conversation / shared / resume / domain / job / interview / skills） |
| 内置技能库 | `src/main/agent/skills/`（resume-writing / resume-review / interview-prep；SKILL.md + references，`?raw` 内联） |
| 持久化 | `src/main/stores/json-collection.ts` + `stores/`（conversations / resumes / models / …） |
| 领域实体 | `src/main/stores/domain/companies.ts`、`jobs.ts`、`applications.ts`、`pipeline.ts`、`interviews.ts` |
| 通知 / 后台任务 / PDF | `src/main/services/notify.ts`、`tasks.ts`、`pdf-export.ts` |
| IPC | `src/main/ipc/index.ts` + `browser.ts` / `chat.ts` / `resume.ts` / `domain.ts` / `settings.ts` / `workspace.ts` |
| 内嵌浏览器 | `src/main/browser/panel.ts` + `browser/automation/`（cli / actions / target / runner / settings-store） |
| 工作区路径 / 上传 | `src/main/workspace/paths.ts`、`workspace/uploads.ts` |
| 渲染层壳层 | `src/renderer/src/App.tsx`、`components/shell/`、`routes/ExportRoute.tsx` |
| 对话 UI | `components/chat/`（ChatPanel / Composer / ToolTrace / AssistantMarkdown） |
| 文档渲染 | `components/document/`（DocumentPreview / render / icons / templates） |
| 模块页 | `components/modules/{resume,companies,jobs,applications,interview}/` + `modules/shared/` |

## 8. 分期任务

**P1 Agent 内核 + 简历闭环（已完成 2026-10-24）**
> 实现偏差：会话装配落盘由渲染层在 run 结束后 `conversations:sync` 完成（以 AI SDK 的
> reducer 为准，main 只持久化）。编辑器两度换型：Milkdown Crepe（即时渲染）→
> **2026-10-25 定稿为编辑 / 预览双模式**——编辑是 CodeMirror 源码高亮，预览走通用文档
> 组件 `DocumentPreview`（marked + `==高亮==`、`#### A | B | C` 扩展语法 + DOMPurify +
> 模板 CSS，`src/renderer/src/components/document/`；简历之外的其他文档展示也复用它），
> 参考「阿杆的 Markdown 简历模板」（Typora mint 主题）。
> **上传与对话反馈改造（2026-10-25，2026-01 推广到全模块）**：上传不再抽文本直发消息，
> 而是把文件原样落盘到**当前会话所属模块的 upload/ 目录**（`chat:upload` IPC 带会话 key，
> main 侧系统选择框 + `src/main/workspace/uploads.ts` 的 `uploadDirFor` 选目录：简历落
> `resumes/<id>/upload/`，公司 / 岗位 / 投递落各自集合下的 `upload/`，`job:<id>` 与
> `interview:<id>` 再下一层），消息只附 `data-upload` part 展示文件名 / 图片缩略图，
> 内容由 Agent 用 `upload_list` / `upload_read` 两个通用工具按需抽取（unpdf / mammoth
> 在工具里跑）；图片（png / jpg / jpeg）例外——勾了「视觉输入」的模型会在
> `convertToModelMessages` 的 `convertDataPart` 里拿到缩到 1024px 的图片 file part，
> 没勾时仍只落盘。模拟面试会话不发这对工具（角色限定），所以那里的输入框不显示
> 「+」。run 结束由渲染层把耗时写进助手消息 `metadata.durationMs` 并在消息脚展示，
> 另补复制按钮、shimmer 思考动效，输入框去掉快捷键提示。
1. AgentRuntime：ToolLoopAgent、UIMessage 流迁移、会话持久化与会话列表
2. file 工具（作用域限定 + 写前快照）与 `file:changed` 事件
3. 左栏模块菜单 + 中间卡模块路由；简历页（Chat 与 Markdown 编辑器并排）
4. 上传：文件落盘 upload/ + Agent 工具读取（旧方案「抽文本直发消息」已废弃）
5. 定制简历生成（主简历 + JD → tailored/<jobId>.md）

**P2 领域实体 + 手动闭环**：companies / jobs / applications 的 store 与 CRUD 页、
投递看板、Offer 对比；scoreIntegrity / scoreJdMatch / genInterviewScript 技能工具
与评分卡展示。
> 进展（2026-10-25）：**主进程部分已实现**——`src/main/stores/domain/`（companies / jobs /
> applications / pipeline，`stores/json-collection.ts` 提供通用底座）、后台任务管理器
> （job-match / resume-integrity，`task:event`）、`agent/tools/index.ts` 的 `toolsFor(key)`
> 分发与三模块指令、定制稿工具迁移 jobId 键、话术 scripts + 定稿 sidecar、PDF 导出
> main 侧（`services/pdf-export.ts`：隐藏窗口 → 渲染层 `#export` 路由 → printToPDF）。
> **渲染层同日完成**——三张表格页（列头内存排序、行内编辑/删除弹层先让位
> WebContentsView）、岗位二级工作台（JobWorkbenchPage，复用编辑器卡与 ChatPanel，
> 无定制稿时进入即带起草指令）、话术管理弹窗（预览/编辑/定稿 sidecar）、投递页
> 推进 + pipeline 设置 + Offer 对比、评分卡弹层（ScorecardDialog）、顶栏
> 任务角标（TasksBadge）、`#export` 导出路由与编辑器 PDF 按钮、未配置模型的
> ModelGateDialog 引导。细节与偏差见 `docs/plan/P2-domain-manual-loop.md` 头部
> 实施记录。看板后置（当前状态列已是可分组字段），PDF 导出自 P5-B 提前并入本期。

**P3 模拟面试 + 通知**：mock 会话类型与面试官 persona（通用 / 专项）；
NotifyService + 调度 + 确认门。
> 进展（2026-10-25）：**M1 文本面试已实现**——`src/main/stores/domain/interviews.ts`
> （`interviews/<id>.json`，复用 `stores/json-collection.ts` 的底座）、`interview:<id>` 复合会话
> （材料只读 + 逐轮落账 / 总评收束两个记录工具）、岗位页发起弹窗（轮次 / 模式，语音置灰）、InterviewPage（列表 /
> 会话 / 点评卡三栏）。细节与偏差见 `docs/plan/P3-mock-interview-notify.md` 头部实施
> 记录。**M3 通知同日实现**——`src/main/stores/notify.ts` / `src/main/services/notify.ts`
> （SMTP 发送 + IMAP 收信监控 + 确认门状态机 + 分钟级调度）、notify / request_confirmation
> 工具（applications
> 会话，notify 挂 toolApproval 界面审批）、ChatPanel 批准 / 拒绝按钮（P1 预留位兑现）、
> 设置窗「通知」节与逐项测试连接。M2 语音等厂商清单；真邮箱联调待凭据。

**P4 浏览器自动化 ✅（2026-10-25）**：按 BROWSER-AGENT.md 接入 agent-browser（0.39.2，
devDependencies 锁精确版本，打包 staging 单平台二进制 + extraResources）。
`src/main/browser/automation/` 四件套：`cli.ts`（二进制定位 / `--version` 探测 / spawn 解析 /
abort / close+pid 兜底）、`actions.ts`（受控动作枚举 + argv 组装，模型拼不了 CLI）、
`target.ts`（每次任务按面板 URL/title 锁定 target，UI 窗口永不匹配）、`runner.ts`
（任务包络 + 审计：每步命令与结果摘要写
`<workspace>/logs/agent.log`，agent:step 事件推渲染层）。工具面：browser_read
（只读）/ browser_act（写，逐条界面审批）/ browser_submit（双重门 + 单站每日 ≤10 单、
≥90s+0–30s 抖动限速，可调），注册进 companies / jobs / applications 三个会话；设置页
「浏览器」节管开关与限速；浏览器面板工具条有「让 Agent 接管」与红色「中止 Agent」。
场景：公司调研、链接抓 JD、自动搜索（只读）与 M4 填表投递（平台适配模板
`<workspace>/browser-playbooks.md`，用户可编辑）。偏差与未做项见 `docs/plan/P4-browser-agent.md`
头部实施记录。

**P5 增强**：语音面试（transcribe + generateSpeech）。（简历 PDF 导出已自 P5-B 提前并入 P2。）

## 9. 风险与坑

- **Markdown 并发**：协议见 §5；先把「写入即快照」做对，再谈合并。
- **确认工具阻塞循环**：10 分钟级 async 工具必须可 abort，界面要能随时取消整个任务。
- **招聘平台风控**：自动投递默认逐单确认 + 限速；封号风险在设置页明示。
- **邮箱兼容性**：各家 IDLE 行为不一（QQ / 163 授权码等），通知配置页要有逐项连通性测试。
- **CDP 安全**：全部约束见 BROWSER-AGENT.md；P4 已按其落地——随机空闲端口（命令行
  已带 --remote-debugging-port 时沿用）在 app.ready 前写入、仅回环、tab 锁定、命令白名单、
  审计、中止与退出兜底清理。
