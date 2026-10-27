# P4 实施计划：浏览器自动化（已实现）

> **目录说明（2026-10-27）**：代码已按职责重组，本文路径已同步为当前结构——
> main 的持久化在 `src/main/stores/`，LLM Agent 在 `src/main/agent/`，
> 浏览器面板与自动化在 `src/main/browser/`。

> 状态：**M1 基座 + M2/M3 场景工具面 + M4 门控与限速已实现（2026-10-25）**；选型维持
> agent-browser（开工前核对：npm 0.39.2 为 0.39.x 最新版，`--cdp <port>` 与 `--pin-tab`
> 粘性绑定、`batch --json` stdin 数组入参、`tab list --json` 含 CDP targetId 均实测可用；
> 守护进程有 `~/.agent-browser/<session>.pid` 可按 pid 兜底清理，browser-use 不启用）。
>
> **实施记录（2026-10-25）——采纳的开放决策值**
> 1. 投递平台范围：不定（模板化）——`<workspace>/browser-playbooks.md` 默认模板带
>    BOSS / 猎聘 / LinkedIn 占位小节与通用安全规则，用户手编，Agent 投递前读进指令。
> 2. 在场 vs 离场：`browser_submit` 默认 `mode=interactive` 走 `toolApproval` 界面审批
>    （审批条上直接展示模型给的「将要提交的内容摘要」）；`mode=offline` 才走
>    request_confirmation 邮件门，且 runtime 侧硬校验「用户 10 分钟内有操作就不允许
>    offline」（发消息 / 点停止都会刷新在场时刻）。
> 3. 限速默认：单站每日 ≤10 单、单间 ≥90s + 0–30s 随机抖动；记账存
>    `<workspace>/agent-browser.json`（按本地日历日重置，重启不清零），设置页「浏览器」节可调。
> 4. agent-browser：锁 `0.39.2`（devDependencies 精确版本；pnpm-workspace.yaml
>    allowBuilds 放行其 postinstall——它负责给二进制 +x）。
> 5. 版权提醒：随导出功能一并推后（未做）。
>
> **与计划的偏差**
> - runner 不用 `batch --json` 一次送多步：模型在环逐步决策，预脚本化的批量无从谈起，
>   改为「每步一条短命进程 + 常驻 daemon（--session goodjob）」；batch 保留给
>   将来固定序列。单步进程开销实测可接受（daemon 持有 CDP 连接）。
> - 工具面是 BROWSER-AGENT §3 允许清单的子集映射：`screenshot` 保留在 actions 白名单
>   （落盘路径由 main 指定到工作区 cache/）但本轮没有工具入口；`tab` 仅 target.ts 内部使用。
> - 「让 Agent 接管」按钮只在 companies / jobs / applications 三个会话（挂了
>   useBrowserTakeover）显示，避免点了没反应；岗位二级工作台（job:<id>）不注册浏览器工具。
> - 单步重放拒绝 `browser_submit` 步骤（重放会绕过双重门），只读 / 已审批写动作可重放。
>
> **未做（按计划明确不做或移交走查）**
> - 真实平台演练、CDP 实弹全流程（连真站点跑 tab 锁定 → snapshot → 动作）由走查阶段
>   与用户手测覆盖；本轮冒烟只验了版本探测、CDP 端口绑定、`/json/list` 目标形态与退出无残留。
> - macOS 公证 / 强制重签（electron-builder identity: null 本地构建未签）按 BROWSER-AGENT
>   §4 留给分发阶段。
> - 白名单拒绝目前是类型层保证（discriminatedUnion 枚举外构造不出命令），没有独立运行时测试用例。

> 选型记录：2026-10-25 复核 browser-use 与 agent-browser，维持 agent-browser。
> 安全边界、白名单、打包与公证、退路方案见 `docs/BROWSER-AGENT.md`（AGENTS 硬约束 7）。
> 对应 `docs/PRODUCT.md` §2 §7 P4 行。

## 目标与范围

在内嵌浏览器（WebContentsView）上接入 agent-browser，交付四个能力，按风险从低到高分三批：

1. **公司调研**：导航到公司官网 / 公开页，snapshot → 摘要整理进 Company 调研快照（只读 + 落库）。
2. **链接抓 JD**：岗位 URL → 打开、滚动读取 → 整理成 Job 的 JD 原文（只读 + 落库）。
3. **自动搜索**：在招聘站按条件搜索 → 结果列表回填候选 Job（写库，不动平台状态）。
4. **自动填表投递**：填写 + 提交投递表单——**每单过 P3 的邮件确认门 + 限速**（AGENTS 硬约束 7；
   提交动作本身还应在 `toolApproval` 在场审批可用时优先走界面审批，离场才走邮件门）。

## 分批与里程碑

| 批 | 内容 | 出口判据 |
| --- | --- | --- |
| M1 基座 | 端口、spawn、tab 锁定、白名单动作、审计、工具条运行态、中止 | 手动触发一条只读动作，审计逐步出现，UI target 永不被操作 |
| M2 只读场景 | 公司调研 + 抓 JD（会话内工具触发） | 两个真实站点跑通，落库数据结构正确 |
| M3 搜索 | 搜索岗位列表 → 候选 Job | 结果去重入库，不误触投递按钮 |
| M4 副作用 | 填表投递（确认门 + 限速 + 逐单审计） | 测试站全流程 + 确认门两条分支实测 |

## 一、主进程

按 BROWSER-AGENT §6 的文件布局落 `src/main/browser/automation/*`；要点与补充：

1. **端口**：`app.ready` 前取空闲端口写 `remote-debugging-port`，常开、仅 127.0.0.1（M1）。
2. **tab 锁定**：每次任务先 `tab` 列目标，按面板 URL/title 固定 target id；所有动作只在该 tab（M2）。
3. **动作枚举**：`actions.ts` 白名单 = BROWSER-AGENT §3 允许清单；模型工具面就是这份枚举
   （tool 的 inputSchema 只接受枚举值与 ref/文本参数），main 组装 argv——模型永远拼不了 CLI。
4. **工具注册**：`browser_read`（open/snapshot/get 组合的只读动作）、`browser_act`
   （click/fill 等写动作，挂 `toolApproval`）、`browser_submit`（提交类，双重门：在场审批，
   离场邮件确认）。注册到 companies / jobs / applications 三个会话的工具集。
5. **审计**：每步命令与结果摘要（不含页面正文）→ 右栏「工作日志」标签 + `logs/agent.log`（M4）；
   `agent:pane-open` 事件打开右栏与对应标签。
6. **任务循环**：`runner.ts` = snapshot → 模型决策（受控枚举）→ 执行 → 审计 → 循环；
   步数 / 时长 / 频率上限可配；用户中止 → SIGTERM 子进程 + 清 daemon（BROWSER-AGENT M5/M6）。
7. **限速**：投递批次间随机间隔与每日上限（默认值见开放决策 3），设置页明示封号风险。

## 二、打包与分发

BROWSER-AGENT §4 原样执行：`agent-browser` 进 devDependencies 锁精确版本；打包 staging 脚本
拷当前平台二进制到 `resources/agent-browser`；`extraResources`；macOS 强制重签 + 公证验证。
§7 验收清单全项通过才算 M1 完成。

## 三、渲染层

1. 右栏「工作日志」标签：AgentStep 时间线（命令、结果摘要、耗时），可展开单步；
   失败步骤红色、可重试单步（重试也只是重放同一条受控动作）。
2. 浏览器面板工具条加「让 Agent 接管」入口（等于在当前会话发起 browser 工具调用）与
   红色「中止 Agent」按钮（M5 终止开关的 UI 面）。
3. 设置页新增「浏览器自动化」节：启用开关、限速参数、风险告知（含 `~/.agent-browser`
   状态目录偏离 `~/.goodjob` 的如实说明，BROWSER-AGENT §3）。
4. 投递确认门的等待态在 ChatPanel 工具条上展示倒计时与「改为界面审批」快捷方式。

## 四、指令与确认流草案

- companies / jobs / applications 模块指令追加浏览器工具用法：先 snapshot 再动、
  视口外先 scrollintoview、导航后 ref 失效重取（坑清单进指令，降低无效步）。
- 提交前固定话术：Agent 必须先展示「将要提交的内容摘要」再调 `browser_submit`；
  确认门超时走取消分支并在会话里说明。

## 五、验证

1. BROWSER-AGENT §7 全项 + M1–M4 各自出口判据。
2. 安全回归：全量测试里断言「UI 窗口 target 从未被操作」（审计日志核对）；白名单外命令
   （cookies / eval / network route…）在工具层直接拒绝并有测试用例。
3. 中止健壮性：任务中途杀 App、杀 Agent、断网，均不残留子进程 / daemon（`pgrep -fl agent-browser`）。
4. 真实平台演练：M4 只在测试站 / 用户明确授权的账号上做，逐单确认门两条分支 + 限速生效。

## 开放决策点（开工前拍板）

1. **投递平台范围**：首期支持哪几家（BOSS / 猎聘 / 拉勾 / LinkedIn…）——各站表单结构差异大，
   每家都是一份适配指令；建议首期 1 家跑穿。
2. **在场审批 vs 邮件门的优先级**：建议在场必走 `toolApproval`，仅当用户 10 分钟无操作
   （或明确选择「离场模式」）才转邮件确认。
3. **限速默认值**：建议单站每日 ≤10 单、单间 ≥90s 随机抖动；是否可调到多少上限。
4. **agent-browser 版本**：锁 `0.39.x`（定稿要求），开工时核对最新版与 `--pin-tab` 行为。
5. **抓取内容的版权与隐私边界**：JD / 调研快照仅存本机工作区（现状即如此），
   是否需要在导出 / 分享功能里加提醒（导出功能本身还没排期，可一并推后）。

## 明确不做（P4）

不做 `cookies / storage / state / eval / network route / install / upgrade`（硬约束，永不）；
不做无人值守批量投递；不做验证码自动识别（遇到即停，交回用户）；
不把 agent-browser 挂到运行时 dependencies（体积红线）；不支持移动端页面特化。
