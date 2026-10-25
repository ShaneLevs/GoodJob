<p align="center">
  <img src="build/icon.png" width="112" alt="GoodJob" />
</p>

<h1 align="center">GoodJob</h1>

<p align="center">
  本地优先的求职全流程桌面 Agent——简历、岗位、投递、模拟面试与内嵌浏览器自动化,
  数据全部留在你的电脑上。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version" />
  <img src="https://img.shields.io/badge/platform-macOS-black?logo=apple&logoColor=white" alt="platform" />
  <img src="https://img.shields.io/badge/private-仓库暂未公开-orange" alt="visibility" />
  <br />
  <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/Vercel_AI_SDK-7-000000" alt="AI SDK" />
  <img src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white" alt="pnpm" />
</p>

## 这是什么

GoodJob 是一个**带内嵌浏览器的求职助手桌面端**。它不是聊天软件套壳:每个模块内嵌
该模块上下文的对话,Agent 能自主调用工具编辑 Markdown 简历、读写领域数据、发邮件
通知、驱动内嵌浏览器读页面填表单——而一切有副作用的动作都经过人工门控。

核心对象是**主简历**:一份人机共编的 Markdown,其余一切(岗位定制稿、面试话术、
匹配度报告、模拟面试)都从它派生。

```
主简历 resume.md(唯一源,人手编 + Agent 工具改)
  ├─ tailored/<jobId>.md   岗位定制简历(与岗位 1:1,覆盖前快照可回溯)
  ├─ scripts/<jobId>.md    岗位面试话术(支持定稿锁定)
  ├─ reports/              完整性 / JD 匹配度评分报告
  └─ history/              每次写入前的快照

Company 1──N Job 1──1 Application ── Offer / 模拟面试(逐轮记录 + 总评)
```

## 功能特性

| 模块 | 能力 | 自动化程度 |
| --- | --- | --- |
| 简历管理 | Markdown 唯一源人机共编;上传 PDF / DOCX / MD 旧简历解析;岗位定制稿 1:1;一键导出 PDF | 解析 / 定制 / 修改都是 Agent 工具 |
| 岗位与公司 | 公司库(调研快照)+ 岗位表(操作枢纽:定制简历 / 评分 / 话术 / 模拟面试入口)+ 岗位二级工作台 | 手动优先,浏览器 Agent 辅助调研 |
| 投递管理 | 投递记录、可自定义阶段的状态流水线、Offer 横向对比 | 自动投递强门控 |
| 简历评估 | 完整性评分 + JD 匹配度(LLM 直接比对),后台任务出分、评分卡呈现 | Agent 评分 |
| 模拟面试 | 追问式文本面试,绑定岗位(JD + 定制简历),轮次自定,逐轮记录可回看,结束出四维总评 | Agent 对话 |
| 通知 | SMTP 日报 / 周报 / 岗位推荐;关键节点邮件确认(10 分钟回信放行、超时提醒) | 封装为独立工具 |
| 内嵌浏览器 | `WebContentsView` 原生视图多标签页,Agent 经 [agent-browser] 受控驱动:调研抓 JD、自动搜索(只读)、填表投递 | 白名单动作 + 审批门 + 限速 + 审计日志 |

[agent-browser]: https://github.com/langgptai/agent-browser

## 安全与隐私

- **本地优先**:一切数据在 `~/.goodjob/` 工作区(目录 `0700` / 文件 `0600`),
  除你自己配置的模型 API 与 SMTP/IMAP 外不向任何第三方外发数据。
- **凭据不出 main 进程**:模型 API Key、邮箱密码经 Electron `safeStorage`
  加密落盘,渲染层只见"有没有配置",永远拿不到明文。
- **渲染层不碰 Node**:`sandbox: true` + `contextIsolation: true` +
  `nodeIntegration: false`,新能力一律走 main + preload 窄接口。
- **浏览器自动化强约束**:CDP 只对锁定的 tab 生效;动作白名单(禁止
  `eval` / `cookies` / `storage` / 网络路由等);副作用动作界面审批在场优先,
  离场走邮件确认门;单站每日提交限速;逐步审计写 `logs/agent.log`。
- **不伪造回复**:模型未配置就明确报 `llm_not_configured`,不造示例数据。

## 模型配置

模型自备、多供应商:OpenAI 兼容端点(中转 / 本地 Ollama 均可)、Anthropic、
Google。协议在设置页选(`openai-chat` / `openai-responses` /
`anthropic-messages` / `google-generative-ai`),流式、工具循环、结构化输出
全部走 [Vercel AI SDK](https://ai-sdk.dev)(`ai@7` + `@ai-sdk/*@4`)。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Electron 44(`WebContentsView` 内嵌浏览器,独立 session 分区) |
| 构建 | electron-vite 6 + electron-builder 26 |
| UI | React 19 + shadcn/ui(Radix 原语,源码入库)+ Tailwind CSS 4 |
| AI 对话 | AI Elements pattern 组装 + Streamdown 流式渲染;`@ai-sdk/react` 的 `useChat` 经 IPC ChatTransport 桥接 |
| 简历编辑 / 预览 | CodeMirror 6 编辑 + marked/DOMPurify 模板化预览 |
| 模型调用 | Vercel AI SDK(`ai` 7.x,跑在 main 进程) |
| 文档抽取 | unpdf / mammoth(PDF / DOCX → Markdown) |
| 邮件 | nodemailer(SMTP 发)+ imapflow(IMAP 收,自动 IDLE) |
| 浏览器控制 | agent-browser 0.39.x(Rust CLI,CDP 附着) |
| 语言 | TypeScript 5.9,三进程统一 |

## 快速开始

```bash
git clone https://github.com/ShaneLevs/GoodJob.git
cd GoodJob
pnpm install
pnpm dev          # electron-vite dev,端口 1420
```

> Electron 二进制走 GitHub Release 下载。若网络受限,先
> `export HTTPS_PROXY=http://127.0.0.1:<端口>` 再
> `node node_modules/electron/install.js`。

```bash
pnpm typecheck    # node + web 两份 tsconfig
pnpm build        # 产物写入 out/,必须无警告
pnpm dist:mac     # electron-builder 打 dmg / zip(当前为未签名本地构建)
./dev.sh          # 带残留进程清理的 dev 入口

# 隔离测试实例(不碰真实 ~/.goodjob,macOS 可双击)
./start-test.command --fresh
```

首次启动会自动创建「默认工作区」;在设置里配好任意一个模型供应商即可开始。

## 目录结构

```
src/main/        窗口、BrowserPanel、AgentRuntime(工具循环)、各领域 store、
                 通知服务、agent-browser 接入、后台任务、pdf-export、IPC
src/preload/     contextBridge → window.goodjob(产物固定 CommonJS)
src/renderer/    React + shadcn/ui + Tailwind 4
  components/      modules/(简历/岗位/投递/面试/公司五模块页)、chat/、settings/
  markdown/        通用文档渲染(模板 = CSS 串)
src/shared/      三进程共用类型与 IPC 频道名(零依赖)
scripts/         图标管线与各期冒烟脚本
```

## 路线图

- [x] **P1** Agent 运行时内核 + 简历闭环(上传解析 → 人机共编 → 定制稿)
- [x] **P2** 领域实体与手动管理闭环(公司 / 岗位 / 投递三表、岗位工作台、
      后台评分、话术定稿、流水线、Offer 对比、PDF 导出)
- [x] **P3** 模拟面试(文本)+ 通知(日报 / 周报 / 邮件确认门)
- [x] **P4** 浏览器自动化(调研 / 抓 JD / 自动搜索 / 填表投递,强门控)
- [ ] **P5** 语音面试(ASR / TTS)

## 许可

尚未决定(当前为私有仓库)。转公开前会补充正式的开源许可证。
