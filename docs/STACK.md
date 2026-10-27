# 技术栈定案

> 最后核对：2026-10-27（目录重构后的路径与模块落点）。改动这里之前先确认是否仍与代码一致。

## 定案

| 层 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| 桌面外壳 | Electron | 44.x | 必须有内嵌浏览器能力 |
| 构建 | electron-vite + electron-builder | 6.x / 26.x | dev、build、打包 |
| 语言 | TypeScript | 5.9 | 三个进程统一 |
| UI 框架 | React | 19.x | |
| UI 组件库 | shadcn/ui（Radix 原语，源码入库） | radix-rhea 风格 | 组件在 `src/renderer/src/components/ui/` |
| 样式 | Tailwind CSS | 4.x | 只挂 renderer；token 全在 `globals.css` |
| AI 对话 UI | AI Elements patterns | shadcn 版 | 源码在 `components/ui/ai-elements/`，按 pattern 组合 message / bubble / message-scroller / input-group |
| Markdown | Streamdown | 2.x | 流式增量解析 + 代码块 / 表格（对话区用） |
| 简历编辑 | CodeMirror 6（`@uiw/react-codemirror` + `@codemirror/lang-markdown`） | 6.x | 编辑模式：Markdown 源码 + 高亮 |
| 简历预览 | marked + DOMPurify + 模板 CSS | 18.x / 3.x | 预览模式：通用文档预览组件 `DocumentPreview`（`src/renderer/src/components/document/`），扩展语法 `==高亮==`、`#### A \| B \| C`、`左:::右`、`icon:name`、`photo:`；外观由模板决定，一个 CSS 文件一套主题（`templates/*.css`） |
| 文档图标 | lucide-react + simple-icons | 1.x / 16.x | 通用图标走 lucide（已装）；品牌图标走 simple-icons（CC0），`icon:name` 注册表在 `components/document/icons.ts`，按需导入、单图标渲染缓存 |
| React AI 钩子 | @ai-sdk/react | 4.x | `useChat` + 自定义 `ChatTransport`（IPC 桥），与 `ai@7` 成对 |
| 文档抽取 | unpdf / mammoth | 1.x / 1.x | 上传旧简历抽正文（PDF / DOCX），只跑在 main |
| 分栏 | react-resizable-panels | 4.x | 经 `components/ui/resizable` |
| 模型调用 | Vercel AI SDK（`ai` + `@ai-sdk/anthropic` / `@ai-sdk/google` / `@ai-sdk/openai`） | 7.x / 4.x | 跑在 main 进程 |
| 邮件通知 | nodemailer + imapflow | 10.x / 2.x | SMTP 发送 + IMAP 收信监控（连接空闲自动进 IDLE）；纯 JS、无构建脚本，不占 `allowBuilds`；只跑在 main |
| 包管理 | pnpm | 11.x | 构建脚本白名单已写入 `pnpm-workspace.yaml` |
| 浏览器控制 | agent-browser（Rust CLI 二进制） | 锁 0.39.x | **已接入（P4）**；通过 `--cdp` 附着内嵌面板，详见 `docs/BROWSER-AGENT.md` |

## 为什么是 Electron 而不是 Tauri

- 内嵌第三方页面只能靠 iframe 或真正的浏览器内核。主流招聘站点都带
  `X-Frame-Options` / `frame-ancestors`，iframe 直接白屏。
- Tauri 2 的 webview 能显示网页，但会话分区、CDP 调试协议、请求拦截、下载与
  权限策略要么缺失、要么随 WKWebView / WebView2 / WebKitGTK 表现不一致。
- Electron 的 `WebContents` 自带 session/partition、preload、`debugger`（CDP），
  这正是"让 agent 读页面、填表单、截图"需要的底座。
- 代价：安装包 ~100MB 起、内存占用高、macOS 需签名公证。

## 进程职责

```
main     窗口、WebContentsView、AI SDK 调用、配置与凭据、IPC 路由
preload  contextBridge 暴露 window.goodjob（只做窄接口转发）
renderer shadcn/ui + Tailwind 界面，不接触 node / 凭据
```

- 渲染层：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`。
- preload 因沙箱限制必须打成 CommonJS，产物是 `out/preload/index.cjs`
  （即使 `package.json` 是 `"type": "module"`）。
- 内嵌浏览器使用独立分区 `persist:browser`，与 UI 会话的 cookie/storage 完全隔离。
- AI 调用固定在 main：API Key 经 `safeStorage`（macOS 走钥匙串）加密后存
  当前工作区的 `models.json`（目录 0700、文件 0600），渲染层拿不到明文。

## WebContentsView 的硬约束（务必记住）

它是原生子视图，不是 DOM 节点：

1. **永远画在 UI 之上**：shadcn/ui 的 Dialog / DropdownMenu / Popover 都盖不住它。
   打开任何浮层前必须 `window.goodjob.browser.setVisible(false)`（`BrowserPanel` 的
   `suspended` prop 就是干这个的）。
2. **不能靠 CSS 裁剪**：圆角、透明、滚动容器都无效。布局必须给浏览器留一块矩形区域。
3. **位置由渲染层上报**：`BrowserPanel` 用 `ResizeObserver` 量出占位 div 的矩形，
   通过 `browser:set-bounds` 同步；窗口缩放、分栏拖动都会触发。
4. 多标签页 = 多个 view 各自管理显隐，没有现成 tab 容器；目前只有浏览器一个原生视图。

## 数据与凭据

- 一切运行时数据在 `~/.goodjob/`，不写 Application Support。根目录只放索引与机器级偏好，
  其余都跟着工作区走：
  `workspaces.json`（工作区索引）、`preferences.json`（主题/字号）、
  `workspaces/<workspaceId>/`（`models.json`、`conversations/`、`cache/`、`logs/`）。
  目录名一律是 `ws_` 前缀的 ID，人类可读的名字只存在索引里，所以改名不用动磁盘。
- 启动时 `process.umask(0o077)`；目录 `0700`，JSON 文件 `0600`。新增持久化路径先登记到
  `src/main/workspace/paths.ts` 的 `WorkspacePaths`，再由 `ensureWorkspaceDirs()` 建目录。
- `models.json` 属于工作区，切换工作区等于换一整套模型配置。它支持多供应商 / 多模型 /
  默认模型选择，字段对齐 AI SDK 适配器的 `baseURL` / `apiKey` 配置；`protocol` 决定用哪个适配器
  （`openai-chat` / `openai-responses` / `anthropic-messages` / `google-generative-ai`）：

  ```json
  {
    "version": 1,
    "defaultModel": { "providerId": "p1", "modelId": "gpt-4o" },
    "providers": [
      {
        "id": "p1",
        "name": "外网中转",
        "protocol": "anthropic-messages",
        "baseURL": "https://example.com",
        "enabled": true,
        "apiKeyEncrypted": "<base64(safeStorage)> 或 null",
        "models": [
          { "id": "claude-sonnet-4-5", "name": "claude-sonnet-4-5", "enabled": true,
            "contextWindow": 200000, "vision": true, "reasoning": true }
        ]
      }
    ]
  }
  ```
- 渲染层看到的是去掉 Key 的投影（只有 `hasApiKey`），保存时按供应商 id 合并旧密文。
- 设置页只维护供应商与模型清单；`defaultModel` 由对话区的模型下拉写入（`models:select`）。
- 未配置模型时后端返回 `llm_not_configured`，**不生成任何假回复**。
- 本地 OpenAI 兼容服务（如 Ollama）可只填 Base URL 与模型，key 用占位符。

## 命令

```bash
pnpm dev        # electron-vite dev（Vite 8，端口 1420）
pnpm build      # 产物写入 out/
pnpm typecheck  # node + web 两份 tsconfig
pnpm dist:mac   # electron-builder 打 dmg/zip（当前为未签名本地构建）
./dev.sh        # 带残留进程清理的 dev 入口

# 隔离的测试实例（不碰真实 ~/.goodjob，macOS 可双击）
./start-test.command             # 校验 + 构建 + 启动
./start-test.command --fresh     # 先清空 .tmp/test-home
./start-test.command --no-build  # 只启动，跳过校验/构建
./start-test.command --check     # 只校验 + 构建，不启动
```

测试实例靠两个环境变量隔离：`GOODJOB_HOME` 把 Electron 的 userData 换到
`.tmp/test-home/electron-profile`（同时拿到独立的单实例锁），`GOODJOB_DATA_DIR`
把配置换到 `.tmp/test-home/data`。

## 界面结构（顶栏 → 左栏 → 内容卡）

```
┌ 48px 顶栏（pl-[92px] 让出交通灯；左栏开关贴左、任务角标与浏览器开关贴右）─────┐
├ 左栏 248px（铺在 bg-shell 上）┬ 内容卡（白色卡片）────────────────────────┤
│ GoodJob / 工作区菜单 / 设置   │ 模块页：空态 / MessageScroller / 表格 …    │
│                               │ 浏览器打开时作为浮层铺满同一矩形             │
└───────────────────────────────┴───────────────────────────────────────┘
```

- **顶栏是唯一放操作按钮的地方**：它 48px 高、整条是 `drag` 区，按钮自己 `no-drag`；
  左栏开关永远贴左，中间留给以后新加的功能。
- **左栏不是卡片**：直接铺在 `bg-shell` 上，无描边无阴影；选中项用 `bg-foreground/[0.07]`。
- **内容块是白色卡片**：`rounded-2xl bg-card shadow-sm`，不带描边；对话内容列 `max-w-3xl` 居中。
  只有一块——模块页独占它。
- **浏览器是盖在内容块上的浮层**（`absolute inset-0`，默认关闭）：顶栏地球按钮或
  `agent:pane-open` 事件打开，模块页留在下层不卸载（会话与「让 Agent 接管」监听要活着）。
  原生视图必须拿到一块矩形，这是它不能做成并排收窄的唯一原因。
- **评分卡是弹层**（`ScorecardDialog`），不是常驻面板：岗位表的匹配度徽标、
  简历页的完整性按钮各自弹出自己的报告。
- 窗口用 `titleBarStyle: "hiddenInset"`（`trafficLightPosition: { x: 16, y: 18 }`），
  顶栏 `pl-[92px]` 让出交通灯。
- 主题与字号来自机器级 `preferences.json`，由 `ThemeApplier` 写 `.dark` 类与 `--font-base`；
  token 全部在 `src/renderer/src/globals.css`。

## 已知坑

- 退出时不要在 `BrowserPanel.dispose()` 里调 `webContents.close()`：窗口的 `closed` 事件是在
  销毁之后触发的，此时访问 `win.contentView` 会抛 `Object has been destroyed`；而在
  `before-quit` 里调 `contents.close()` 会让 `app.quit()` 挂住不退出（实测）。窗口销毁时
  Electron 会自动回收子视图，dispose 只负责标记状态 + 在窗口尚存时 detach。
- 浏览器控制的安全边界、打包与验收清单单独成文：`docs/BROWSER-AGENT.md`。

- `pnpm install` 需要允许 electron 的构建脚本；配置在 `pnpm-workspace.yaml` 的
  `allowBuilds`（pnpm 11 已不再读取 `package.json` 的 `pnpm` 字段）。
- Electron 二进制走 GitHub Release，Node 的 `fetch` 不认 `~/.npmrc` 里的 proxy，
  需要显式设置 `HTTPS_PROXY` 后再跑 `node node_modules/electron/install.js`。
- 开发期 CSP 含 `unsafe-eval`（Vite 需要），Electron 会打印安全警告；
  打包后使用严格 CSP，警告消失。
- Radix 浮层靠 inline style 定位，CSP 必须保留 `style-src 'unsafe-inline'`
  （见 `src/main/app/security.ts` 的 `PROD_CSP`）。
