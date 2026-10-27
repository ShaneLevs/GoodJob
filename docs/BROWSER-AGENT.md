# 浏览器控制方案：agent-browser

> 状态：**已接入（P4，2026-10-25）；多标签改造（2026-10-26）**。定稿 2026-10-19，实现
> 2026-10-25（agent-browser 0.39.2，锁精确版本；`--cdp` / `--pin-tab` / `batch --json` /
> `tab list --json` 均实测可用）。
> 实现落点 `src/main/browser/`：`panel.ts`（多标签 WebContentsView 池）与
> `automation/`（cli.ts / actions.ts / target.ts / runner.ts / settings-store.ts）；
> 偏差与未做项见 `docs/plan/P4-browser-agent.md` 头部实施记录。
> 本文的"安全边界"与"验收清单"仍是实现与走查的准绳。

## 1. 结论

用 `agent-browser`（`vercel-labs/agent-browser`）驱动内嵌的 `WebContentsView`，而不是引入 Python 的 browser-use。

- 它是 **Rust 原生二进制 + CLI**，不是 JS 库；npm 包内每个平台一个可执行文件（darwin-arm64 ≈ 9MB，整包 72MB 装了 7 个平台）。
- 通过 `--cdp <port>` 附着到**已经在跑的** Chromium，因此不需要下载 Chrome for Testing，也不会多开一个浏览器。
- 自带官方 `electron` skill，明确支持"连正在运行的 Electron 应用"。
- 定稿时已在本项目手工实测通过：`connect 9222` → `tab t2` → `snapshot -i --json` → `fill` / `click` / `open` / `batch --json` 全部有效。

被否掉的选项：

| 选项 | 否决原因 |
| --- | --- |
| browser-use（Python） | 需打包 Python 3.10+ 运行时（数百 MB）、PyInstaller、额外公证，崩溃要单独守护 |
| browser-use-sdk（TS） | 只对接 Cloud，页面内容出本机，且看不到内嵌浏览器 |
| 自己在 `webContents.debugger` 上实现 | 可行但 200–300 行动作空间要长期维护；保留为退路（见 §8） |

## 2. 运行时架构

```
renderer ──IPC──> main
                   ├── BrowserPanel（WebContentsView，分区 persist:browser）
                   └── BrowserAgent（spawn agent-browser）
                            │  --cdp 127.0.0.1:<随机端口> --session goodjob --json
                            └──> Rust 守护进程 ──CDP──> 面板的 webContents
```

**端口必须在 `app.ready` 之前确定**（`app.commandLine.appendSwitch("remote-debugging-port", String(port))`），所以做不到"任务期间才开"。定案：**启动时取一个空闲端口，常开，只监听 127.0.0.1**。

取端口的方式：先 `net.createServer().listen(0)` 拿到系统分配的空闲端口再关闭，然后写入 switch。不要硬编码 9222。

推荐的 spawn 形态：

```ts
spawn(agentBrowserPath, [
  "--session", "goodjob",
  "--cdp", String(port),
  "batch", "--json",
], { stdio: ["pipe", "pipe", "pipe"] })
```

- 单次任务用 `batch --json` 一次送多步，避免每条命令起一次进程。
- 输出是 `[{ command, success, result, error }]`，直接映射成审计日志（`logs/agent.log`）里的步骤。
- 常驻清单：`--session` 固定，避免多实例互相抢 tab。

## 2.5 多标签（2026-10-26）

面板是**完整的标签式浏览器**，用户与 Agent 共用同一套标签。

```
BrowserPanel          一个 Map<tabId, WebContentsView>，只有 active 那个挂到窗口上
  ├─ 标签条           渲染层 DOM：切换 / 关闭 / 新建（+）
  ├─ 工具条           后退 / 前进 / 刷新 / 地址栏 —— 只作用于活动标签
  └─ target=_blank    开成新标签（不再是「顶掉当前页」）
```

关键约定，改动时别踩：

1. **只有活动标签的 view 挂在窗口上**，其余 detach 但 webContents 活着（页面状态保留）。
   所以 `setBounds` / `setVisible` 只作用于活动那个，浮层让位依旧靠 `setVisible(false)`。
2. **Agent 的 `tab new` / `tab close` 绝不直接调 CLI**。CLI 的 `tab new` 会在同一个
   Chromium 里造一个我们拿不到 `WebContentsView` 的页面——用户看不见，等于 Agent 在
   隐形页面里点按钮。所有标签动作都过 `PanelDescriptor`（`target.ts` 头部注释），
   与用户操作的是同一组标签。`click newTab=true` 同理：先 `get attr href` 读出链接，
   再在我们的面板里开新标签。
3. **`--pin-tab` 的第一条命令不能带 pin**。会话尚未绑定标签时，`--pin-tab` 会尝试
   `Target.createTarget` 开新标签，而 **Electron 不支持这个 CDP 命令**，会直接报
   `CDP error (Target.createTarget): Not supported`。所以首次 `tab list` 走
   `AgentBrowserCli.run(args, signal, timeout, { pin: false })`，随后显式
   `tab <targetId>` 绑定，之后才是严格语义（绑定标签被关 → `tab_gone`，绝不回退）。
4. **同站多标签靠 targetId 分辨，不靠 URL**。旧的 URL/title 匹配在两个标签开同一个站时
   会串；`targetIdOf(webContents)` 是确定性的，URL 匹配只作为 DevTools 占着 debugger
   时的回退。
5. 标签上限 `MAX_TABS = 20`，关掉最后一个自动补一个 `about:blank`，面板不会空掉。
6. 登录态靠分区 `persist:browser` 持久保留：**用户手动登录一次，之后 Agent 就是已登录
   状态**，这是「用户先登录、Agent 再操控」这条产品路径的基础，不要改成临时分区。

## 3. 安全边界（这一节最重要）

### 威胁模型

CDP 端口是**本机任意进程都能连**的。开了它，等于把「我们这个 Electron 应用的全部 webContents」交给本机任何程序，包括：

- 面板里的第三方招聘页（`persist:browser` 分区，隔离了 cookie，但仍是活跃页面）；
- **我们自己的 UI 窗口**（实测 `tab` 列表里的 `t1` 就是 GoodJob 界面）。

也就是说：不设限的话，agent（或本机任何进程）可以点我们自己的「设置」「清除 Key」按钮。

### 缓解措施

| # | 措施 | 说明 |
| --- | --- | --- |
| M1 | 随机端口 + 仅 127.0.0.1 | Chromium 默认只绑定回环地址；不要加 `--remote-debugging-address` |
| M2 | **tab 锁定** | 每次任务先 `tab list`，按应用自身窗口（`BrowserWindow.getAllWindows()`）的 URL/title 建排除集滤掉 UI target；面板的每个标签都是一个 `WebContentsView`，用 `debugger` + `Target.getTargetInfo` 拿到它**自己的** CDP targetId（实测与 `tab list --json` 完全一致、跨导航稳定），从而确定性对账「我们的标签 ↔ agent 的 tab」。任务期间只能在**我们自己的标签集合**内切换。禁止"用当前默认 tab" |
| M3 | **命令白名单** | 模型永远不能直接拼 CLI 字符串；输出必须解析成受控动作枚举，再由 main 组装 argv |
| M4 | 审计 | 每条命令与结果摘要写入 `<workspace>/logs/agent.log`（**不记录页面正文**） |
| M5 | 终止开关 | 用户中止 → 杀子进程（`SIGTERM`，必要时 `SIGKILL`），并清理守护进程 |
| M6 | 退出清理 | `before-quit` 调 `agent-browser --session goodjob close`，再按 pid 兜底 kill |

命令白名单：

**允许**：`open` `back` `forward` `reload` `tab` `snapshot` `click` `dblclick` `fill` `type` `press` `hover` `focus` `check` `uncheck` `select` `scroll` `scrollintoview` `wait` `get` `is` `find` `screenshot` `keyboard` `mouse`

**禁止**（无论模型怎么说）：

- `network route` / `unroute` —— 可篡改页面请求，等于 MITM 用户自己
- `cookies` / `storage` / `state` —— 导出登录态，属于凭据外泄
- `eval` / `pdf` / `trace` / `profiler` / `dashboard` / `install` / `upgrade` / `close --all`
- 任何 `--profile` / `--executable-path` / `--extension` / `--init-script` —— 越过面板分区
- `--allowed-domains` 在 `--cdp` 模式下会被拒绝，不能用来当白名单

> `tab` 的四个子命令（`list` / `new` / `switch` / `close`）对模型开放，但只接受
> **我们自己标签的 id**（`tab_<hex>`），不接受 CDP targetId；`new` / `close` 的落点是
> `PanelDescriptor`，不是 CLI。模型构造不出 `tab close --all` 之类的东西（枚举之外无命令）。

> 如果将来确实需要 `eval`（例如读取 SPA 的 JSON 数据），必须限定在面板 tab、且结果只回传给 main 做结构化解析，不能原样回灌给模型。

### 数据落盘

agent-browser 自己的状态目录是 `~/.agent-browser`，**不在 `~/.goodjob` 里**。这是我们既有约定的一处偏离，需要在设置页里如实告知用户；不要尝试改 `HOME`，会破坏它自己的会话恢复。

## 4. 打包

### 只带当前平台的二进制

不要把 `agent-browser` 列为运行时 `dependency`（会把 7 个平台的二进制塞进 `app.asar`，+72MB）。做法：

1. 放 `devDependencies`，锁精确版本；
2. 打包前跑一次 staging 脚本，把**当前平台**的二进制复制到 `resources/agent-browser`；
3. `electron-builder.yml` 用 `extraResources` 带进去。

```yaml
extraResources:
  - from: resources/agent-browser
    to: agent-browser
```

运行时路径：`process.resourcesPath + "/agent-browser"`（打包后）／仓库内 `resources/agent-browser`（开发时）。

### 签名与公证

嵌套的原生可执行文件是 macOS 公证最常见的失败点：

- `@electron/osx-sign` 会遍历 app bundle 内的 Mach-O 一并签名，但 npm 上的二进制可能带 ad-hoc 签名，需要**强制重签**（`sign` 阶段加 `--force`，必要时先 `codesign --remove-signature`）；
- `hardenedRuntime: true` 保持开启；Rust 二进制不需要 `allow-jit` 之类额外 entitlement；
- 交付前必须验证：

```bash
codesign -dv --verbose=4 "GoodJob.app/Contents/Resources/agent-browser"
codesign --verify --deep --strict --verbose=2 "GoodJob.app"
spctl -a -vvv -t install "GoodJob.app"
```

- 首次 `spawn` 若被杀，先怀疑 Gatekeeper 而不是路径写错；`log stream --predicate 'process == "amfid"'` 能看到原因。

### 版本

固定 `agent-browser@0.39.x`（定稿时本机装的是 0.27，缺 `tab --url` 与 `--pin-tab`）。启动时执行 `agent-browser --version` 记进日志，避免"用了新命令但二进制没升级"。

## 5. 已知行为坑

1. **视口外的元素点不中**：实测 `click @ref` 在元素 `y` 超出视口时会落到 `<html>`（坐标 434/728，视口高 727）。动作序列必须 `scrollintoview` → `snapshot`（ref 可能变） → `click`。
2. **导航后 ref 失效**：`open` 之后旧 ref 全部作废（报 `Unknown ref`），必须重新 snapshot。
3. **多个 target**：UI 窗口与面板同时在列，必须显式锁 tab（M2）。
4. **守护进程残留**：应用崩溃后 daemon 可能活着，退出钩子要兜底清理。

## 6. 与现有代码的接口

```
src/main/browser/panel.ts                多标签 WebContentsView 池 + 标签状态
src/main/browser/automation/cli.ts       定位二进制、探测版本、spawn/batch、解析 JSON
src/main/browser/automation/actions.ts   受控动作枚举 + 白名单校验 + argv 组装
src/main/browser/automation/runner.ts    任务循环：snapshot → 决策 → 动作 → 审计
src/main/browser/automation/target.ts    tab 解析与锁定（面板 target id）
src/main/browser/automation/settings-store.ts  开关 / 限速 / 提交记账
src/shared/types/                        AgentStep / AgentStepEvent 类型 + IPC 频道名
src/preload/index.ts                     agent 事件订阅（窄接口）
src/renderer/src/components/browser/     BrowserPanel 工具条 + App 顶栏开关（agent:pane-open）
```

`BrowserPanel` 通过 `agentTabs()` / `createAgentTab()` 暴露受控标签接口，UI 与 Agent 共享同一组标签；
其余标签池细节留在 main。

渲染层没有独立的审计面板：`agent:step` 事件只驱动工具条的运行态，完整步骤落在
`logs/agent.log`（JSONL）。

## 7. 打包后验收清单

- [ ] `app.isPackaged` 下能解析到 `process.resourcesPath/agent-browser`
- [ ] `--version` 与锁定版本一致
- [ ] `codesign --verify --deep --strict` 通过，`spctl` 通过
- [ ] 冷启动 → 面板加载站点 → agent 能 `tab` 到面板并 snapshot
- [ ] UI 窗口不在任务动作范围内（日志里能看到锁定的 target id）
- [ ] 中止任务后子进程与 daemon 都不残留（`pgrep -fl agent-browser`）
- [ ] 安装包体积增量 ≈ 9–10MB（不是 72MB）

## 8. 退路：自研 `webContents.debugger` 实现

如果公证或端口不可接受，按同一套接口换实现：

- `debugger.attach("1.3")` 后调 `Accessibility.getFullAXTree` + `DOM.describeNode` 生成 ref 表；
- 点击用 `DOM.getBoxModel` + `Input.dispatchMouseEvent`（记得先滚动到视口内）；
- 输入用 `Input.insertText`；
- 截图用 `webContents.capturePage()`（注意窗口的 `capturePage` 拍不到子视图）。

上层 `BrowserAgent` 接口与 `AgentStep` 类型不变，只需替换 `agent-browser.ts`。

## 9. 相关

- 选型总表：`docs/STACK.md`
- 硬约束：`AGENTS.md`
