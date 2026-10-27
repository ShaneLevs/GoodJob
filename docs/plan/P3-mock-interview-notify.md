# P3 实施计划：模拟面试（文本 + 语音）+ 通知（可顺延批）

> **目录说明（2026-10-27）**：代码已按职责重组，本文路径已同步为当前结构——
> main 的持久化在 `src/main/stores/`，LLM Agent 在 `src/main/agent/`，
> 浏览器面板与自动化在 `src/main/browser/`。

> 状态：**M1 文本面试与 M3 通知已于 2026-10-25 落地（实施记录见下）**；M2 语音等厂商清单。
> 对应 `docs/PRODUCT.md` §2 §5 §7、`docs/ARCHITECTURE.md` §6 §8。
> 前置：P2 的岗位 / 定制稿（1:1）与后台任务机制。
>
> **实施记录（2026-10-25 · M1 文本面试）**：
> - 已落地（主进程）：`src/main/stores/domain/interviews.ts`（`interviews/<id>.json`，复用
>   `src/main/stores/json-collection.ts` 的 JsonCollectionStore 底座——导出该类并把 interviews 纳入集合目录；
>   ID 惯例 `iv_` + 12hex）。发起校验：岗位存在 + 有 JD + 有定制稿 + 轮次 1–12；
>   `logRound`（轮次序号由 store 分配，同主问题补记整体覆盖、不重复计轮）与 `finish`
>   （总评清洗、roundNotes 按轮对齐补写表现小结、幂等保护）是仅有的两个记录写入口。
>   `ConversationsStore.remove(key)` 新增：删除面试时 IPC 层先 abort 会话 run，再连带清
>   `interview:<id>` 会话文件。
> - 已落地（AgentRuntime）：`interview:<id>` 复合会话（ConversationKey 扩展 +
>   `interviewKeyTarget`）。工具白名单 = job_info / resume_read / job_tailored_read /
>   job_script_read（全只读）+ interview_round_log / interview_submit_review，
>   **不给**简历 / 定制稿 / 话术 / 岗位任何写工具，也不给 memory 工具（指令不注入
>   长期记忆节）。persona 指令 = 追问式面试官（每轮 1 主问题 + 0~2 追问、答完必追问一层、
>   口径贴 JD 与定制稿）+ 每次 send 重算的实时进度（已记录轮次列表 / 设定轮次 / 记满后的
>   收束提示）——「指令 + runtime 侧硬约束」的另一半在 store 写入口校验里。
> - 已落地（渲染层）：InterviewPage（左 = 面试列表，进行中置顶，行 = 岗位/时间/轮次/模式/
>   总评分徽标，悬停删除带确认；中 = `interview:<id>` 会话（复用 ChatPanel +
>   use-module-chat），头部轮次进度条 + 「结束并出总评」；右 = 已结束才出现的点评卡：
>   总评 Markdown（DocumentPreview 文档纸面）+ 亮点/风险/建议 + 逐轮时间线
>   （问题/追问/回答/小结））。发起链路：JobsPage 行菜单「模拟面试」点亮 → 弹窗（轮次
>   3/5/8/10、文本可用、语音置灰「待接入语音供应商」；无定制稿 → 引导去二级页生成，
>   无 JD → 引导去编辑补齐）→ `interviews.create` → 跳面试模块并选中该场。空会话且模型
>   可用时自动发开场指令（机制同二级页 autoPrompt）；无模型时不伪造开场（界面给引导），
>   「开始面试」「结束并出总评」过 ModelGateDialog。modules.tsx 的 interview 模块去掉
>   planned 占位；切换工作区时面试定位一并清空。
> - 开放决策采纳值：一轮 = 主问题 + 0~2 个追问（追问不计入用户设定的轮次，弹窗说明与
>   指令里都写明）；总评四维 = 表达/深度/结构/岗位匹配 + 亮点与风险 + 逐条可执行建议；
>   语音入口置灰提示（M2 等厂商清单，本轮不实现语音）。
> - 偏差：① 总评加了 `score`（0–100 整数）字段——计划的 review 结构没有，但列表
>   「总评分」列需要数字（对齐 JobMatchReport.score 的先例）。② 逐轮记录加了可选
>   `note`（表现小结）：点评卡「每轮表现小结」需要落点，由总评的 roundNotes 按轮补写。
>   ③ 「总评写回记录文件」用 interview_submit_review 工具实现（同一会话内生成并落回），
>   不做 main 侧消息解析——解析不可靠，工具落账与轮次落账是同一机制。④ 实施记录日期
>   按实际完成日记为 2026-10-25。
> - 验证：`pnpm typecheck` / `pnpm build` 通过；`node scripts/p3-interviews-store-smoke.mjs`
>   （jiti 直跑 src 源码）覆盖发起校验 / 轮次幂等 / 总评收束 / 磁盘复活 / 0600 权限 /
>   会话连带删除 / runtime 工具白名单与指令注入；CDP 驱动隔离实例（自建 .tmp/p3-smoke-home，
>   已清理）：发起弹窗（语音置灰 / 文本选中 / 开始可点）→ 模型门 → 建场 → 面试页（进行中
>   徽标 / 第 1/5 轮 / 结束按钮 / 无模型不自动开场）→ 删除确认 → 已结束场次的点评卡与
>   逐轮时间线（含会话历史回看），浅 + 深两态截图核对。
> - 未做（M1 出口判据中需要真实模型的部分）：一场完整面试的端到端（真实模型多轮追问 →
>   总评生成 → 重启恢复）——测试实例无模型，待编排层 / 用户侧联调；M2 语音（等厂商
>   清单）；M3 通知（可顺延批）。
>
> **实施记录（2026-10-25 · M3 通知与界面审批）**：
> - 已落地（主进程）：`src/main/stores/notify.ts`（`notifications.json`，0600 跟随工作区：
>   SMTP / IMAP 账户 + safeStorage 密文密码 + 日报 / 周报调度与记账日；密码三态语义与
>   models.json 的 API Key 一致——省略保持、null 清除、字符串替换）与
>   `src/main/services/notify.ts`：nodemailer 发送 + imapflow 收信监控（连接空闲自动进
>   IDLE，新邮件 `exists` 事件即查回信，tick 每分钟兜底轮询——各家 IDLE 兼容性见
>   ARCHITECTURE §9）；确认门状态机 `sent → waiting(≤10min) → reminded → approved |
>   timeout`，token 同时写 Message-ID 与 Subject，回信按 In-Reply-To / References /
>   Subject 匹配、任何内容都算放行，寄给自己的原信按 Message-ID 排除（收件人就是
>   用户自己的邮箱，原信会落 INBOX）；调度 = main 内分钟级 tick，不引 cron 依赖。
> - 已落地（AgentRuntime）：notify / request_confirmation 两个工具挂在 applications
>   会话（投递模块最贴近外发场景；P4 自动投递接入时在 job 会话扩展）；`notify` 挂
>   toolApproval `user-approval`（P1 预留位兑现），`request_confirmation` 本身就是门、
>   不再二次审批。两者都是长时 async 且可 abort（确认门挂 10 分钟级，停止 run 即取消）。
>   日报 / 周报 = NotifyService 调度到点调 `AgentRuntime.runDigest`（generateText +
>   notify 工具，无 UI 流；快照全空时如实说「还没有记录」；到点即记账、当日不重试，
>   失败 / 未配模型用设置里的「立即生成」补发）。
> - 已落地（渲染层）：useModuleChat 接 `sendAutomaticallyWhen:
>   lastAssistantMessageIsCompleteWithApprovalResponses` + `addToolApprovalResponse`，
>   回填后完整历史经 IPC transport 自动续跑（工具在第二个 run 里真正执行）；
>   ChatPanel 工具条「等待批准」态升级为批准 / 拒绝按钮（不收进折叠区），拒绝显示
>   「已拒绝」、批准显示「已批准，执行中」；六个模块页统一传 `onApprovalResponse`。
>   设置窗新增「通知」节：SMTP / IMAP 表单（密码不回显、留空保持、可清除）+ 逐项
>   「测试连接」（SMTP `transport.verify()`、IMAP `verifyOnly` 连接，测的是表单当前值、
>   密码省略时用已存的）+ 日报 / 周报开关与时刻（周报选星期）+「立即生成」。
> - IPC：`notify:get / notify:save / notify:test / notify:digest-run`（shared 与 preload
>   同步）。凭据只在 main 解密，渲染层只见 `hasPassword`；设置页「测试连接」允许用
>   未保存的表单密码直测。切换工作区 `notify.stopAll()`（等待中的确认门按取消处理）
>   后换文件重读并重启调度；before-quit 同样 stopAll。
> - 偏差：① 确认工具对模型命名 `request_confirmation`（snake_case 与既有工具一致；
>   计划文本写作 requestConfirmation）。② 日报失败当日不自动重试（到点即记账）——
>   避免未配模型时每分钟重试风暴，补发走设置页手动按钮。③ notify 工具只进了
>   applications 会话（计划未指定会话归属），P4 扩展到 job 会话。④ 新增 devDependency
>   `@types/nodemailer`（nodemailer 10 不自带类型）。⑤ `scripts/p3-smoke-electron-stub.mjs`
>   增补 safeStorage 恒等编解码桩（stores/notify.ts 冒烟需要；对既有 smoke 是纯增量）。
> - 验证：`pnpm typecheck` / `pnpm build` 通过（无警告级错误）；
>   `node scripts/p3-notify-service-smoke.mjs`（jiti 直跑 src 源码，假 mailer / 假 IMAP /
>   假时钟注入，全程无网络）覆盖配置读写 / 0600 / 密文落盘搜不到明文 / 未配置不伪造 /
>   确认门 approved·reminded·timeout·abort / 自邮件排除 / 日报到点一次与失败记账 /
>   stopAll；`node scripts/p3-interviews-store-smoke.mjs` 回归通过。
> - 未做：真邮箱联调（SMTP 发送、IMAP IDLE 收信、确认门两条分支的端到端）——无凭据，
>   连接逻辑与逐项「测试连接」已就绪，待用户提供邮箱后验证；浅色 / 深色下审批按钮与
>   通知设置页的人工核对随编排层统一跑 start-test 时确认。
>
> **已拍板决策（2026-10-25）**：
> 1. 面试由用户**手动发起**，与通知机制无关（不做定时 / 提醒式发起）。
> 2. **轮次由用户在开启面试时设定**；轮次走完自动进入总评，用户也可提前结束并出总评。
> 3. 结束后给出**整体表现评议 + 改进建议**。
> 4. **每一轮记录都保存**（问题、追问、回答）。
> 5. 面试**绑定岗位 JD 与对应定制简历**（P2 的 1:1 关系），**从岗位页直接发起**；
>    「通用面试（仅主简历）」不再单列，无定制稿的岗位引导先生成。
> 6. **语音面试并入本期**（原 P5-A）：打字和口述体验完全不同，语音是面试本体的一部分，
>    不做成后置增强。ASR / TTS 先接国内常见厂商，**等用户提供厂商清单后定接入方案**。
> 7. 通知模块保留在本期，但切为独立批、**可顺延**（它的消费方自动投递在 P4，且 P4 选型重开中）。

## 分批

| 批 | 内容 | 出口判据 |
| --- | --- | --- |
| M1 文本面试 | 岗位页发起 → 自定轮次 → 追问式问答 → 总评 | 一场完整面试可跑通、可恢复、可回看逐轮记录 |
| M2 语音 | 按住说话 ASR + 面试官回复 TTS 朗读 | 语音模式一场面试跑通；与文本模式同一份记录结构 |
| M3 通知（可顺延） | NotifyService + 日报 / 周报 + 确认门 + `toolApproval` UI | ✅ 2026-10-25（真邮箱联调待凭据：连接逻辑与逐项测试就绪） |

## M1/M2：模拟面试

### 数据模型与目录

```
workspaces/<id>/
  interviews/<id>.json   一场面试一条记录：jobId（必有）、resumeRef（该岗位定制稿）、
                         config { rounds, mode: "text" | "voice" }、逐轮记录
                         [{ no, question, followUps?, answer, audioMark? }]、
                         review { overall, strengths, weaknesses, suggestions }、
                         status: "running" | "finished"、createdAt / finishedAt
```

- 逐轮消息复用 UIMessage 结构（与会话同构，同一渲染管线）；`interviews/` 登记 `paths.ts`。
- 一场面试 = 一个会话 key `interview:<id>`（面试记录列表是领域对象列表，
  不违背「无聊天会话列表」的产品原则）。

### 主进程

1. **`src/main/stores/domain/interviews.ts`**：CRUD + 列表（按岗位 / 日期 / 总评分排序供渲染层用）。
2. **面试运行**：AgentRuntime 支持复合 key（`interview:<id>`），工具集 = 只读（主简历 / 该岗位
   定制稿 / 话术 / JD），不给写工具；轮次计数与「该结束了」的判断写在指令 + runtime 侧硬约束
   （达到设定轮次且用户无追问诉求 → 引导结束并触发总评）。
3. **面试官 persona**：指令组装（追问式：每轮围绕一个考察点、答完必追问一层、不一次问完；
   口径贴 JD 与定制稿）；结束后同一会话生成总评（整体表现 / 亮点 / 风险 / 改进建议，
   建议逐条可执行），结果写回 `interviews/<id>.json`。
4. **发起链路**：岗位页「模拟面试」→ 选轮次与模式 → 建 record → 进面试页。
   无定制稿时引导先在岗位二级页生成。

### 渲染层

1. **InterviewPage**：左内容卡 = 面试列表（岗位 / 日期 / 轮次 / 模式 / 总评分）+ 进行中的置顶；
   右 Chat = 当前面试（复用 ChatPanel；轮次进度条 + 「结束并出总评」按钮）。
2. **点评卡**：结束后渲染 Markdown 总评 + 逐轮时间线（每轮问题 / 回答 / 表现小结）。
3. **语音模式 UI（M2）**：输入区切「按住说话」键（录音态波形 / 计时）、面试官回复自动朗读
   开关、朗读可被新输入打断；`data-audio` part 标记语音轮次（不存音频本体）。

### 语音接入（M2，待外部输入）

- 调用面固定走 AI SDK：ASR = `experimental_transcribe`，TTS = `experimental_generateSpeech`
  （`ai@7` 现成导出，已核对本地类型）。
- **供应商接入等用户收集的厂商清单**（协议 / baseURL / 模型名 / 鉴权）。设计预案：
  1. 优先走 **OpenAI 兼容音频端点**（多数国内厂商提供），配置形态复用 `models.json` 的
     supplier preset 模式，加「语音」用途标记；
  2. 无兼容端点的厂商，用 `@ai-sdk/provider` 写自定义 provider 适配进 AI SDK 调用面
     （仍满足硬约束 8：不自拼 HTTP 客户端散落各处，适配收敛在 provider 包内）。
- 采集 / 播放：渲染层 `getUserMedia`（主窗口放行 mic 权限）+ WebAudio 切片经 IPC 送 main
  （音频不进模型上下文，ASR 得文字后走既有会话）；播放队列支持打断。
- 不支持语音的供应商：语音按钮隐藏或置灰提示（见开放决策 3）。

## M3：通知（可顺延批）

- `src/main/services/notify.ts`（ARCHITECTURE §6）：`nodemailer` SMTP + `imapflow` IMAP IDLE +
  分钟级 tick；`notifications.json`（密码 safeStorage 密文，跟随工作区）；
  日报 / 周报 = 调度器到点发起一次 Agent 运行（汇总 P2 实体数据，无内容时如实说）→ `notify`。
- 确认门状态机 `sent → waiting(≤10min) → reminded → approved | timeout`，token 匹配
  In-Reply-To / References；对模型只暴露 `notify` / `requestConfirmation` 两个工具。
- `toolApproval` 界面审批：ChatPanel 工具条「等待批准」态升级为可操作（批准 / 拒绝），
  走 `@ai-sdk/react` 的 `addToolApprovalResponse`（P1 预留位兑现）。
- 设置窗「通知」节：SMTP / IMAP 表单 + 逐项「测试连接」（各家 IDLE 兼容性风险见
  ARCHITECTURE §9）+ 日报开关与时刻。

## 文档同步

AGENTS.md（目录 / 工作区树加 interviews、notifications.json；工具注册表）、
ARCHITECTURE §6（落地为已实现）、PRODUCT.md §2 §5（面试改岗位绑定 + 手动发起 + 自定轮次 +
语音并入；通知与面试解耦）、STACK.md（nodemailer / imapflow；语音供应商 preset）。

## 验证

1. `./start-test.command --check`；浅色 + 深色（面试页、点评卡、录音态、审批按钮）。
2. M1 剧本：岗位页发起（设 5 轮）→ 多轮追问 → 提前结束 / 轮次走完自动总评 → 重启恢复 →
   列表与逐轮记录完整；换一场语音模式同剧本再跑（M2）。
3. 语音：真麦克风按住说话 → 文字入会话 → TTS 朗读可打断；不支持音频的供应商降级路径。
4. M3（若本期做）：真邮箱连通性测试、日报手动触发、确认门 approved / timeout 两分支、
   密文落盘与日志无明文。

## 开放决策点（开工前拍板 / 待外部输入）

1. **每轮结构**：建议「主问题 + 0~2 个追问」算一轮，追问不计入用户设定的轮次。
2. **总评维度**：建议 表达 / 深度 / 结构 / 岗位匹配 四维 + 亮点与风险 + 逐条改进建议。
3. **语音降级**：供应商不支持音频时隐藏按钮还是置灰提示。
4. **【待外部输入】ASR / TTS 厂商清单**：用户收集后定 preset 列表与协议映射（M2 的开工条件）。
5. **通知批去留**：M1 / M2 完成后与用户确认当期做还是顺延到 P4 开工前。

## 明确不做（P3）

自动发起 / 定时面试；面试音视频录制存档（只存文字与标记）；通用面试（无岗位绑定）；
实时流式语音对话（逐轮即可）；自动投递（P4）。
