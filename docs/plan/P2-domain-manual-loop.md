# P2 实施计划：领域实体 + 手动闭环（表格优先）

> **目录说明（2026-10-27）**：代码已按职责重组，本文路径已同步为当前结构——
> main 的持久化在 `src/main/stores/`，LLM Agent 在 `src/main/agent/`，
> 浏览器面板与自动化在 `src/main/browser/`。

> 状态：2026-10-25 批准开工，**主进程底座与渲染层已于同日全部落地**（实施记录见下）。
> 对应 `docs/PRODUCT.md` §7 P2 行、`docs/ARCHITECTURE.md` §8。
>
> **实施记录（2026-10-25 · 渲染层部分）**：
> - 已落地：`ui/table` + `ui/checkbox` 源码入库（radix-rhea registry，import 按惯例修正）；
>   CompaniesPage / JobsPage / ApplicationsPage 替换占位页（modules.tsx 去 planned），
>   三页沿用「Chat | 内容」Resizable 结构 + 中间 1px 可拖拽线；列头点击内存排序
>   （`table-bits.tsx`：useTableSort / SortableHead / cmpText·cmpNumber·cmpTime，null 恒排尾）；
>   行内编辑 / 删除确认弹层全部经 `onOverlayChange` 让位 WebContentsView（硬约束 5）。
>   岗位行操作：生成简历（无定制稿 → 进二级页并自动带起草指令；有 → 直接进）、
>   简历评估（后台任务，行内「评估中 → 分数」徽标，点分数开评分卡）、话术管理
>   （ScriptDialog：DocumentPreview 预览 / 源码编辑 / 定稿 sidecar / 待重新定稿徽标）、
>   编辑 / 删除；「模拟面试」占位禁用（P3 点亮）。岗位二级工作台 JobWorkbenchPage
>   （会话 key=`job:<jobId>`，ResumeEditorCard 按 ResumeDocTarget 参数化复用，顶部返回岗位表）。
>   ApplicationsPage：推进状态（只顺流下拉 + 备注）、pipeline 设置弹窗（增删 / 改名 /
>   排序 / 终态）、Offer 编辑、勾选 ≥2 条含 Offer 投递出对比表。panes.tsx 加「评分卡」，
>   `agent:pane-open` IPC 兑现（main 在评分类任务 finish 时带 ScorecardTarget 推送；
>   PaneKey 真值移入 shared/types.ts）；右栏 TasksBadge 汇总后台任务进度 / 重跑。
>   PDF 导出：`main.tsx` 按 hash 分流挂 ExportRoute（注册 `window.__goodjobRenderExport`，
>   导出窗无 preload 不挂 App），主简历 / 定制稿编辑器工具条加「PDF」按钮走 `pdf:export`。
>   未配置模型：ModelGateDialog 统一引导（含 tasks.run 的 llm_not_configured 错误回显），不伪造。
> - 开放决策采纳值：排序字段按建议清单（岗位：标题/公司/薪资带/匹配度/话术/更新时间；
>   投递：岗位/公司/状态/最近推进/Offer；公司：名称/行业/城市/更新时间）；二级页会话 key
>   = `job:<jobId>`；话术定稿 = sidecar 锁版本、编辑后「待重新定稿」；Offer 对比本期做。
> - 偏差：① 「生成简历」的初稿生成按主进程偏差 ③ 收敛为二级页会话起草（autoPrompt
>   一次性发给 `job:<jobId>` 会话），不做独立后台任务类型；已有定制稿时进入二级页
>   不要求模型（看稿免模型），起草才过模型门。② 匹配度 / 话术徽标本身可点（开评分卡 /
>   话术管理），比纯展示多一步直达。③ 删除确认用 AlertDialog 并 `preventDefault` 等
>   IPC 成功后再收口，避免「先关弹窗后失败」的假成功。④ ScriptDialog 的「标记定稿」
>   会先把本地未保存修改落盘再 finalize，保证定稿指纹与用户所见一致。
> - 验证：`pnpm typecheck` / `pnpm build` 通过；CDP 驱动隔离实例冒烟（浅 + 深两态）：
>   三张表造数 / 排序 / 行菜单 / 编辑弹窗 / 推进弹窗 / 流水线设置 / Offer 对比 /
>   话术弹窗（已定稿态）/ 二级工作台（返回岗位表）/ 评分卡（表格徽标入口）/
>   `#export` 路由契约（`__goodjobRenderExport` resolve、不挂 App、纸面渲染）/
>   模型门（未配置时点「生成简历」出引导，`tasks.run` 回 llm_not_configured）。
>   **未验证**（需要真实模型，见 notDone）：后台任务端到端出分、评估中→分数徽标的
>   实时翻转、agent:pane-open 由 main 推送的真实触发（发送端代码已就位且与表格
>   徽标入口共用同一 openPane 路径）、autoPrompt 起草的真实生成。
>
> **实施记录（2026-10-25 · 主进程部分）**：
> - 已落地：`src/main/stores/json-collection.ts`（通用底座）+ `src/main/stores/domain/`（companies / jobs / applications
>   三薄 store + `pipeline.json` 读写校验）；`src/main/services/tasks.ts` 后台任务管理器
>   （`job-match` 简历评估 → 写回岗位匹配度报告；`resume-integrity` 完整性评分 →
>   `resumes/<id>/reports/`；`task:event` 推送；同 type+target 去重；退出 / 切工作区即停）；
>   `src/main/agent/tools/index.ts` 的 `toolsFor(key)` 按会话分发 + companies / jobs / applications 三条
>   模块指令 + 岗位二级工作台（`job:<jobId>`）指令与锁定工具；定制稿工具迁移 jobId 键
>   （旧 name 文件兼容读取，`resume_tailored_write` 的 `migrateFrom` 参数一次性迁移）；
>   话术 `scripts/<jobId>.md` + 定稿 sidecar（final / finalizedAt / sha 指纹）+
>   `scripts/history/` 版本快照；`src/main/services/pdf-export.ts`（隐藏窗口 → 渲染层 `#export`
>   路由 → printToPDF → 另存为，main 侧完成，渲染层路由下一期）。
> - 开放决策采纳值：排序在渲染层做（store 只给确定性顺序）；二级页会话 key = `job:<jobId>`；
>   话术定稿 = sidecar `final:true` + 定稿时间，锁定「供引用的版本」，编辑后按指纹标记
>   「待重新定稿」，旧定稿进 history；Offer 对比本期做（渲染层）。
> - 偏差：① resume 会话为评分技能补了一个**只读** `job_list` 工具（把用户口语里的岗位
>   对应到 jobId，否则工具没法填参数）；② 话术 / 完整性报告 / pipeline 一并给了 IPC
>   （渲染层下一期直接用，避免二次动 main）；③ 话术初稿不做独立任务类型——由会话工具
>   / 二级页直接 `script_write` 生成（计划里「生成初稿（后台任务）」收敛为共编写入）；
>   ④ `ResumeDocTarget.tailored` 的字段名仍是 `name`（编辑器线协议不动，语义 = 文件名
>   key，现在传 jobId，旧 name 文件同样可读）。实施记录日期按实际完成日记为 2026-10-25。
> - 未做（属渲染层，下一期）：三张表格页、岗位二级页、评分卡 pane、`agent:pane-open`
>   链路、设置区流水线 UI、渲染层 `#export` 路由（main 侧契约已写死在
>   `src/main/services/pdf-export.ts` 文件头注释）。
>
> **已拍板决策（2026-10-25）**：
> 1. 模块主体是**表格**：公司 / 岗位 / 投递三个模块页都是表格化列表，岗位表是操作枢纽；
>    看板后置（把「当前状态」做成可分组字段，日后表格转看板零重构）。
> 2. **状态枚举支持手动增删**：不同公司有二面 / 三面 / 四面等不同环节，流水线是工作区级
>    可配置数据，不是写死的枚举。
> 3. 表格**先做基础排序**（状态、更新时间、公司、薪资带等），客户端内存排序即可（定案 4 的量级）。
> 4. 岗位行操作：编辑 / 删除等基础数据管理之外，还有**生成简历（二级页，复用主简历页面）、
>    简历评估（Agent 后台任务）、话术定稿、话术管理**。
> 5. **一个岗位 ↔ 一份定制简历**（1:1，`tailored/<jobId>.md`），重复生成即覆盖（进 history）。
> 6. **简历 PDF 导出并入本期**（原 P5-B：投递必须能导出 PDF；printToPDF 复用预览管线，零新依赖）。
> 7. 岗位表预留「模拟面试」入口，由 P3 接管点亮。

## 目标与范围

1. Company / Job / Application 实体 store 与 CRUD（JSON 文件），三张表格页替换占位页。
2. 岗位二级工作台：生成 / 共编该岗位的定制简历（复用简历页「Chat | 编辑器」结构）。
3. Agent 技能以**后台任务**形态运行（简历评估 = JD 匹配度评分），不阻塞对话。
4. 话术：按岗位生成、可编辑、**定稿**标记与版本管理。
5. 简历（主简历 / 定制稿）一键导出 PDF。
6. `ConversationKey` 从 `"resume"` 扩展出 `"companies" | "jobs" | "applications"`。

## 数据模型与目录

```
workspaces/<id>/
  companies/<id>.json      公司：名称、行业、规模、城市、官网、来源、调研快照（Markdown + 时间）
  jobs/<id>.json           岗位：companyId、标题、JD 原文（Markdown）、链接、薪资带、
                           匹配度报告（评分 + 维度 + 结论 + 评分任务时间）、话术定稿指针
  applications/<id>.json   投递：jobId、状态时间线 [{stage, at, note}]、
                           所用定制稿 / 话术（引用 jobId 推导）、Offer 字段（薪资 / 期权 / 备注）
  applications/pipeline.json   状态流水线定义：有序阶段名列表 + 终态标记（可手动增删改名排序）
  resumes/<resumeId>/
    tailored/<jobId>.md    岗位定制简历（1:1；同名 .meta.json sidecar：基于的主简历快照、生成思路）
    tailored/history/      定制稿覆盖写入前的快照
    scripts/<jobId>.md     岗位话术当前版（含定稿标记的 sidecar）+ scripts/history/ 版本快照
    reports/<ts>-integrity.json   主简历完整性报告（可再生成，保留历史）
```

- ID 沿用惯例：`co_` / `job_` / `app_` + 12 位 hex。新路径先登记 `src/main/workspace/paths.ts`。
- 引用存名不存内容：岗位 / 投递被删时相关文件保留（显示为悬空引用并提示），不级联删。

## 一、主进程

1. **`src/main/stores/json-collection.ts` + `src/main/stores/domain/`**：JSON 集合通用底座（list / get / create / update / delete /
   排序过滤在渲染层做），companies / jobs / applications 三个薄 store 共享，模式对齐
   ResumeStore（全量载内存、写回 0600、`useWorkspace()` 跟随切换）。
2. **流水线配置**：`pipeline.json` 读写 + 校验（至少一个终态、阶段名唯一）；投递状态推进
   只允许「顺流到任一阶段 / 标记终止」，阶段本身由用户在设置区维护。
3. **后台任务 `src/main/services/tasks.ts`**：轻量任务管理器——`run(type, target)` 起 main 侧 Agent
   运行（`ToolLoopAgent` / `generateText` + 结构化输出），注册表 `{id, type, target, status,
   progress?, error?}`，事件 `task:event` 推渲染层；同 type 同 target 去重（运行中再点=提示）；
   应用退出即停，不做断点续跑（结果已落库，重启可重跑）。**简历评估（JD 匹配度）是第一个
   任务类型**；主简历完整性评分同一机制。
4. **工具注册表按 key 分发**（`toolsFor(key)`）：companies / jobs / applications 各给类型化
   CRUD 工具（写操作做枚举与引用校验，错误带回模型）；resume 会话追加评分技能工具。
   P1 的定制稿工具从「name 命名」迁移到 **jobId 键**（`resume_tailored_write` 语义改为
   按 jobId 读写，旧 name 版兼容读取后迁移）。
5. **PDF 导出 `src/main/services/pdf-export.ts`**：隐藏 offscreen `BrowserWindow` 加载渲染入口的导出路由
   → `DocumentPreview` + 指定模板渲染 → `webContents.printToPDF({ pageSize: "A4",
   printBackground: true, margins })` → `dialog.showSaveDialog` 存用户自选目录。
   模板补 `@page` 与分页避规（scoped 在模板 CSS 内，不进 globals.css）。
6. **IPC**：三实体 CRUD、pipeline 读写、`task:event` 订阅、`tasks:rerun`、`pdf:export(target)`。
   同步 `src/shared/types/` 与 `src/preload/index.ts`（硬约束）。

## 二、渲染层

1. **表格基建**：shadcn `table` 组件源码入库（registry 取，import 按惯例改）；排序不引
   TanStack——列头点击切换 asc/desc，内存排序；「当前状态」列实现为可分组字段（看板预留）。
2. **CompaniesPage**：表格（名称 / 行业 / 城市 / 更新时间，可排序）+ 行编辑弹窗 / 删除确认；
   调研快照详情用 `DocumentPreview`；「+」上传调研材料走通用附件管线。
3. **JobsPage（核心）**：表格（标题 / 公司 / 薪资带 / 匹配度 / 话术状态 / 更新时间，可排序），
   行操作：
   - 编辑 / 删除：弹窗与确认（弹层让位 WebContentsView，硬约束 5）；
   - **生成简历**：无定制稿则起后台生成（读 JD → 定制初稿落 `tailored/<jobId>.md`），随后进入
     **二级页**；有定制稿直接进二级页；
   - **简历评估**：发起后台任务，行内显示「评估中 → 分数」徽标，完成可开右栏评分卡；
   - **话术定稿 / 话术管理**：生成初稿（后台任务）、编辑（DocumentPreview + 编辑模式）、
     标记定稿（sidecar `final: true`，定稿后仍可重新定稿，旧版进 history）；
   - **模拟面试**：占位禁用，P3 接管。
4. **岗位二级页（定制简历工作台）**：复用简历页组件参数化——左 Chat（该岗位上下文：
   JD + 定制稿工具作用域）+ 右编辑器（加载 `tailored/<jobId>.md`，预览走模板）；顶部返回
   岗位表。会话隔离方式见开放决策 2。
5. **ApplicationsPage**：表格（岗位 / 公司 / 当前状态 / 最近推进时间 / Offer，可排序），
   行内状态推进（下拉选阶段 + 备注）、编辑 / 删除；Offer 对比 = 勾选多条含 Offer 的投递出
   对比表（可选项，最后做）。
6. **评分卡 pane**：`panes.tsx` 加评分卡标签；落 `agent:pane-open` 事件链路（BROWSER-AGENT §6
   预留的事件，P2 先兑现）。后台任务进度也汇总进右栏「任务」角标。

## 三、Agent 指令与技能

- companies / jobs / applications 三条模块指令（CRUD 工具用法 + 不编造、标注来源）。
- resume 模块指令追加：完整性评分与话术生成的输出约定（评分维度、话术结构）。
- 技能双入口统一到后台任务：表格按钮与会话内工具触发的是同一个 `tasks.run`，
   结论落库 + 评分卡展示；会话里工具返回「任务已发起 / 结果摘要」。

## 四、文档同步

AGENTS.md（目录 / 工作区树 / 工具注册表）、ARCHITECTURE §3 §4 §7 §8、
PRODUCT.md §2 §7（模块结构改表格优先、定制稿 1:1、PDF 提前到 P2）、STACK.md（无新依赖则不动）。

## 五、验证

1. `./start-test.command --check`；浅色 + 深色各过三张表、二级页、评分卡、弹窗。
2. 剧本：建公司 → 建岗位（粘 JD）→ 生成简历（二级页共编）→ 简历评估（后台任务出分）→
   话术生成 / 定稿 → 建投递并推进状态（含自定义「四面」阶段）→ 导出定制稿 PDF →
   重启全部恢复；排序逐列点一遍。
3. 后台任务：评估运行中关 App 重启（无残留进程、结果态显示可重跑）；同岗位重复点击去重。
4. 未配置模型：表格按钮给出明确引导（不伪造）。

## 开放决策点（开工前拍板）

1. **排序字段的最终清单**：建议岗位表（更新时间 / 匹配度 / 薪资带）、投递表（最近推进 /
   状态 / 公司）、公司表（名称 / 更新时间）。
2. **二级页会话隔离**：建议每岗位独立会话 key（`job:<jobId>`），避免多岗位上下文互串；
   备选是三模块各一条会话（与「每模块一条滚动会话」原则更一致，但岗位多时互相污染）。
3. **话术「定稿」语义**：建议定稿 = 锁定供面试 / 投递引用的版本号（仍可编辑，编辑后提示
   重新定稿）；还是硬锁只读、改动必须复制新版本。
4. **Offer 对比是否本期**：建议作为最后一个切片，赶不上可顺延。

## 明确不做（P2）

看板视图（结构预留）；链接抓 JD / 自动搜索 / 自动投递（P4，且选型重开中）；embedding；
SQLite；多份主简历；通知（P3 可顺延批）；语音（P3）。
