<p align="center">
  <img src="build/icon.png" width="112" alt="GoodJob" />
</p>

<h1 align="center">GoodJob</h1>

<p align="center">
  本地优先的求职全流程桌面 Agent。<br />
  简历、岗位与投递、模拟面试与内嵌浏览器自动化，数据全部留在你的电脑上。
</p>

<p align="center">
  <a href="https://github.com/ShaneLevs/GoodJob/releases/latest"><img src="https://img.shields.io/github/v/release/ShaneLevs/GoodJob?label=version&color=blue" alt="version" /></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Windows-10%2F11%20x64-0078D4?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Vercel_AI_SDK-7-000000" alt="AI SDK" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
</p>

## 下载安装

当前最新版本：**v0.1.2** · [所有版本与更新日志](https://github.com/ShaneLevs/GoodJob/releases)

| 平台 | 安装包 |
| --- | --- |
| macOS · Apple Silicon（M 系列） | [GoodJob-0.1.2-arm64.dmg](https://github.com/ShaneLevs/GoodJob/releases/download/v0.1.2/GoodJob-0.1.2-arm64.dmg) |
| macOS · Intel | [GoodJob-0.1.2-x64.dmg](https://github.com/ShaneLevs/GoodJob/releases/download/v0.1.2/GoodJob-0.1.2-x64.dmg) |
| Windows · x64 | [GoodJob-0.1.2-x64-setup.exe](https://github.com/ShaneLevs/GoodJob/releases/download/v0.1.2/GoodJob-0.1.2-x64-setup.exe) |

安装包暂未配置 Apple Developer ID 签名。macOS 首次打开如果提示「无法验证开发者」，
在「系统设置 → 隐私与安全性」里选择「仍要打开」，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/GoodJob.app
```

Windows 若出现 SmartScreen 提示，点「更多信息 → 仍要运行」。

### 第一次使用

1. 打开 **设置 → Agent 设置 → 模型设置**，添加一个模型供应商并填入 API Key。
2. 在**简历**页导入旧简历（PDF / DOCX / Markdown），或直接和 Agent 对话，从零起草。
3. 在**岗位**页录入目标岗位，Agent 会基于主简历生成定制稿、匹配度评分和面试话术；
   投递后用行菜单的「标记投递 / 推进状态」维护进度与 Offer。
4. 需要模拟面试时，从岗位页发起，并设置面试轮次；语音面试先在设置 → Agent 设置 →
   语音里配好百炼 Key。

## 这是什么

GoodJob 是一个带内嵌浏览器的桌面求职工作台。左边是 GoodJob 首页与简历、岗位（含投递）、
面试、公司等模块，右边是理解当前模块上下文的 Agent 对话：Agent 能编辑 Markdown 简历、
维护岗位与投递状态、生成面试问题，也能在你批准后驱动内嵌浏览器抓取 JD、填写申请表单。
所有会改变外部状态的动作都经过人工门控。

核心对象是**主简历**：一份人机共编的 Markdown，其余内容都从它派生。

```
主简历 resume.md（唯一源，人手编 + Agent 工具改）
  ├─ tailored/<jobId>.md   岗位定制简历（与岗位 1:1，覆盖前快照可回溯）
  ├─ scripts/<jobId>.md    岗位面试话术（支持定稿锁定）
  ├─ reports/              完整性 / JD 匹配度评分报告
  └─ history/              每次写入前的快照
```

## 功能特性

| 模块 | 能力 | 自动化程度 |
| --- | --- | --- |
| 简历管理 | Markdown 唯一源人机共编；上传 PDF / DOCX / MD 旧简历解析；岗位定制稿 1:1；一键导出 PDF | 解析 / 定制 / 修改都是 Agent 工具 |
| 岗位与投递 | 公司库（调研快照）+ 岗位表（定制简历 / 评分 / 话术 / 模拟面试入口 + 投递状态时间线）+ 岗位二级工作台；可自定义阶段的状态流水线与 Offer 横向对比 | 手动优先，自动投递强门控 |
| 简历评估 | 完整性评分 + JD 匹配度（LLM 直接比对），后台任务出分，评分卡弹层查看 | Agent 评分 |
| 模拟面试 | 追问式文本 / 语音面试，绑定岗位（JD + 定制简历），轮次自定，逐轮记录可回看，结束出四维总评 | Agent 对话 |
| GoodJob 工作流 | 首页把分析、拆分、多角色任务派给子 Agent 或工作流，实时显示任务进度与交付摘要 | Agent 编排 |
| 通知 | SMTP 日报 / 周报 / 岗位推荐；关键节点邮件确认（10 分钟内回信放行，超时提醒） | 封装为独立工具 |
| 内嵌浏览器 | `WebContentsView` 原生视图，多标签，顶栏开关按需铺满内容区；Agent 经 [agent-browser] 受控驱动：调研、抓 JD、自动搜索、填表投递 | 白名单动作 + 审批门 + 限速 + 审计日志 |

[agent-browser]: https://github.com/vercel-labs/agent-browser

## 安全与隐私

- **本地优先**：数据存在 `~/.goodjob/` 工作区（目录 `0700` / 文件 `0600`），除你自己
  配置的模型 API 与 SMTP/IMAP 外，不向其他第三方外发数据。
- **凭据只留在 main 进程**：模型 API Key、邮箱密码经 Electron `safeStorage`
  加密落盘，渲染层只能看到「是否已配置」。
- **渲染层不接触 Node**：`sandbox: true` + `contextIsolation: true` +
  `nodeIntegration: false`，新增能力一律走 main + preload 窄接口。
- **浏览器自动化受约束**：CDP 只对锁定的标签生效；动作白名单（禁用
  `eval` / `cookies` / `storage` / 网络路由等）；副作用动作优先走界面审批，
  离场走邮件确认；单站每日提交限速；逐步审计写入 `logs/agent.log`。
- **不伪造回复**：模型未配置时明确返回 `llm_not_configured` 并引导去设置，
  不内置 mock 供应商。

## 模型配置

模型自备、多供应商：OpenAI 兼容端点（中转站、本地 Ollama 均可）、Anthropic、Google。
在设置页选择协议（`openai-chat` / `openai-responses` / `anthropic-messages` /
`google-generative-ai`），流式、工具循环、结构化输出全部走
[Vercel AI SDK](https://ai-sdk.dev)（`ai@7` + `@ai-sdk/*@4`）。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Electron 44（`WebContentsView` 内嵌浏览器，独立 session 分区） |
| 构建 | electron-vite 6 + electron-builder 26 |
| UI | React 19 + shadcn/ui（Radix 原语，源码入库）+ Tailwind CSS 4 |
| AI 对话 | AI Elements pattern 组装 + Streamdown 流式渲染；`@ai-sdk/react` 的 `useChat` 经 IPC ChatTransport 桥接 |
| 简历编辑 / 预览 | CodeMirror 6 编辑 + marked/DOMPurify 模板化预览 |
| 模型调用 | Vercel AI SDK（`ai` 7.x，跑在 main 进程） |
| 文档抽取 | unpdf / mammoth（PDF / DOCX → Markdown） |
| 邮件 | nodemailer（SMTP 发）+ imapflow（IMAP 收，自动 IDLE） |
| 浏览器控制 | agent-browser 0.39.x（Rust CLI，CDP 附着） |
| 语言 | TypeScript 5.9，三进程统一 |

## 本地开发

```bash
git clone https://github.com/ShaneLevs/GoodJob.git
cd GoodJob
pnpm install
pnpm dev          # electron-vite dev，端口 1420
```

> Electron 二进制走 GitHub Release 下载。若网络受限，先
> `export HTTPS_PROXY=http://127.0.0.1:<端口>` 再
> `node node_modules/electron/install.js`。

```bash
pnpm typecheck    # node + web 两份 tsconfig
pnpm build        # 产物写入 out/
./start-test.command --check   # 类型检查 + 构建
./start-test.command           # 隔离实例，数据在 .tmp/test-home
```

首次启动会自动创建「默认工作区」。开发约定见 [`AGENTS.md`](AGENTS.md)，
技术方案与产品决策见 [`docs/`](docs/)。

## 常见问题

**需要自己准备 API Key 吗？** 是。GoodJob 不代理模型请求，费用按你选择的供应商结算。

**数据存在哪里？** 都在 `~/.goodjob/`，按工作区组织。卸载应用不会删除这些数据，
需要彻底清理时手动删除该目录。

**支持哪些系统？** macOS（Apple Silicon / Intel）与 Windows 10/11 x64。

**浏览器自动化会自动投简历吗？** 所有写动作都要过审批门；提交前会展示将要提交的内容，
离场时改用邮件确认，并按站点限速。

## 反馈

问题、建议和功能请求欢迎提到 [GitHub Issues](https://github.com/ShaneLevs/GoodJob/issues)，
也欢迎提交 Pull Request。

## 许可

本项目基于 [MIT License](LICENSE) 开源。
