/**
 * P4 浏览器自动化护栏冒烟（jiti 直跑 src/main TS 源码，不启动 Electron，全程无网络），
 * 覆盖复审修复的三处行为回归：
 * - tab 锁定（agent/target.ts）：匹配前先按应用自身窗口的 URL / title 排除集滤掉
 *   UI target——dev 态同 URL / title 撞车、CDP 列表顺序无关；撞车时宁可不跑；
 * - keyboard 文本参数（agent/actions.ts）：与其他位置参数一样拒绝以 - 开头
 *   （CLI 解析器会把 -x 当旗标）；wait --text 是旗标值，不受影响；
 * - 审计摘要（agent/runner.ts）：get text / get value 只记字符数，值本体只回
 *   模型，agent.log 与右栏步骤里搜不到；get url 等标量摘要保持原样。
 *
 * 运行：node scripts/p4-agent-guard-smoke.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "../node_modules/.pnpm/jiti@2.7.0/node_modules/jiti/lib/jiti.mjs";

const here = new URL(".", import.meta.url).pathname;
const jiti = createJiti(here, {
  alias: {
    electron: path.join(here, "p3-smoke-electron-stub.mjs"),
    "@shared": path.join(here, "..", "src", "shared"),
  },
});

const { browserActActionSchema, browserReadActionSchema, buildArgv } = await jiti.import("../src/main/agent/actions.ts");
const { parseTabList, pickPanelTarget, lockPanelTarget } = await jiti.import("../src/main/agent/target.ts");
const { BrowserAgentService } = await jiti.import("../src/main/agent/runner.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-agent-guard-smoke-"));

// ———————————————— target.ts：tab 锁定匹配 ————————————————

const UI_TAB = { tabId: "1", targetId: "T_UI", url: "file:///app/out/renderer/index.html", title: "GoodJob", type: "page", active: true };
const DEV_UI_URL = "http://127.0.0.1:1420/";
const OWN_PROD = { urls: new Set([UI_TAB.url]), titles: new Set(["GoodJob"]) };

// parseTabList：形状不符的条目丢弃。
const parsed = parseTabList({ tabs: [UI_TAB, { tabId: 3, targetId: "x" }, null] });
assert.deepEqual(parsed, [UI_TAB], "parseTabList 应丢弃缺字段的条目");

// B1 生产态：UI 是 file://、面板只放行 http(s)，URL 精确匹配命中面板。
const prodTabs = [UI_TAB, { tabId: "2", targetId: "T_PANEL", url: "https://example.com/jobs/1", title: "招聘 - Example", type: "page", active: true }];
assert.equal(
  pickPanelTarget(prodTabs, { url: "https://example.com/jobs/1", title: "招聘 - Example" }, OWN_PROD)?.targetId,
  "T_PANEL",
  "生产态应按 URL 选中面板 target",
);

// B2 dev 态：UI 在 http://127.0.0.1:1420/ 且排在列表第一；面板是另一页。
// 修复前 tabs.find 取第一个同 URL 项可能选中 UI 窗口；现在 UI 被排除集滤掉。
const devTabs = [
  { tabId: "1", targetId: "T_UI", url: DEV_UI_URL, title: "GoodJob", type: "page", active: true },
  { tabId: "2", targetId: "T_PANEL", url: "https://example.com/jobs/1", title: "招聘 - Example", type: "page", active: true },
];
assert.equal(
  pickPanelTarget(devTabs, { url: "https://example.com/jobs/1", title: "招聘 - Example" }, {
    urls: new Set([DEV_UI_URL]),
    titles: new Set(["GoodJob"]),
  })?.targetId,
  "T_PANEL",
  "dev 态 UI 在前也应选中面板 target",
);

// B3 面板被手动指到 dev UI 完全相同的 URL：两个 target 都在排除集里，
// 无法分辨——返回 undefined（宁可不跑），绝不猜一个。
const sameUrlTabs = [
  { tabId: "1", targetId: "T_UI", url: DEV_UI_URL, title: "GoodJob", type: "page", active: true },
  { tabId: "2", targetId: "T_PANEL", url: DEV_UI_URL, title: "GoodJob", type: "page", active: true },
];
assert.equal(
  pickPanelTarget(sameUrlTabs, { url: DEV_UI_URL, title: "GoodJob" }, { urls: new Set([DEV_UI_URL]), titles: new Set(["GoodJob"]) }),
  undefined,
  "URL/title 完全撞车时应放弃匹配而不是猜",
);

// B4 title 回退撞车：面板 URL 因导航瞬态不在列表里，UI 窗口 title 与面板页相同。
// 修复前按 title 回退会取列表第一个 = UI 窗口；现在 UI 被排除，宁可不跑。
const titleClashTabs = [
  UI_TAB,
  { tabId: "2", targetId: "T_PANEL", url: "https://example.com/about", title: "GoodJob", type: "page", active: true },
];
const pickedClash = pickPanelTarget(titleClashTabs, { url: "https://example.com/gone", title: "GoodJob" }, OWN_PROD);
assert.notEqual(pickedClash?.targetId, "T_UI", "title 撞车时绝不能选中 UI 窗口");
assert.equal(pickedClash, undefined, "title 撞车时宁可不跑");

// B5 回归：排除集为空时行为与旧逻辑一致（URL 精确 → title 回退）。
const ownEmpty = { urls: new Set(), titles: new Set() };
assert.equal(pickPanelTarget(prodTabs, { url: "https://example.com/jobs/1", title: "" }, ownEmpty)?.targetId, "T_PANEL");
assert.equal(
  pickPanelTarget([{ tabId: "2", targetId: "T_PANEL", url: "https://x/1", title: "报名", type: "page", active: true }], { url: "", title: "报名" }, ownEmpty)?.targetId,
  "T_PANEL",
  "URL 匹配不上时按 title 回退",
);

// B6 lockPanelTarget 整体：撞车场景直接拒绝（报「没有在浏览器面板里找到」）。
await assert.rejects(
  lockPanelTarget(
    async (args) => {
      assert.deepEqual(args, ["tab", "list"]);
      return { ok: true, data: { tabs: sameUrlTabs }, error: null };
    },
    { getContents: () => ({ isDestroyed: () => false, getURL: () => DEV_UI_URL, getTitle: () => "GoodJob" }) },
    { urls: new Set([DEV_UI_URL]), titles: new Set(["GoodJob"]) },
  ),
  /没有在浏览器面板里找到当前页面/,
  "撞车时 lockPanelTarget 应报错拒绝执行",
);

// ———————————————— actions.ts：keyboard 文本参数 ————————————————

// C1 形如旗标的文本被 schema 拒绝（修复前 z.string() 放行）。
assert.equal(
  browserActActionSchema.safeParse({ kind: "keyboard", op: "inserttext", text: "--session x" }).success,
  false,
  "keyboard.text 不能以 - 开头",
);
// C2 正常文本通过，argv 仍是受控位置参数。
const kb = { kind: "keyboard", op: "inserttext", text: "王小明的求职意向" };
assert.equal(browserActActionSchema.safeParse(kb).success, true);
assert.deepEqual(buildArgv(kb), ["keyboard", "inserttext", "王小明的求职意向"]);
// C3 text 可省（schema optional），但 buildArgv 会要求它。
assert.equal(browserActActionSchema.safeParse({ kind: "keyboard", op: "type" }).success, true);
assert.throws(() => buildArgv({ kind: "keyboard", op: "type" }), /keyboard 需要 text/);
// C4 回归：wait.text 是 --text 旗标值，位置安全，仍接受以 - 开头。
const waitNeg = { kind: "wait", text: "-已报名-" };
assert.equal(browserReadActionSchema.safeParse(waitNeg).success, true);
assert.deepEqual(buildArgv(waitNeg), ["wait", "--text", "-已报名-"]);
// C5 回归：fill 的位置参数文本本来就拒绝以 - 开头。
assert.equal(browserActActionSchema.safeParse({ kind: "fill", ref: "@e1", text: "-x" }).success, false);

// ———————————————— runner.ts：审计摘要真链路 ————————————————

const PANEL_URL = "https://example.com/apply";
const PANEL_TITLE = "职位申请";
const TABS = { tabs: [UI_TAB, { tabId: "2", targetId: "T_PANEL", url: PANEL_URL, title: PANEL_TITLE, type: "page", active: true }] };
const cliRunLog = [];
const cli = {
  async run(args) {
    cliRunLog.push(args);
    if (args[0] === "tab" && args[1] === "list") return { ok: true, data: TABS, error: null };
    if (args[0] === "tab") return { ok: true, data: {}, error: null };
    if (args[0] === "get" && args[1] === "text") {
      return { ok: true, data: { text: "王小明 北京海淀 13800138000" }, error: null };
    }
    if (args[0] === "get" && args[1] === "url") return { ok: true, data: { url: PANEL_URL }, error: null };
    return { ok: true, data: {}, error: null };
  },
  abortCurrent() {},
  close() {},
  killAll() {},
};
const sent = [];
const service = new BrowserAgentService({
  cli,
  panel: () => ({ getContents: () => ({ isDestroyed: () => false, getURL: () => PANEL_URL, getTitle: () => PANEL_TITLE }) }),
  ownWindows: () => ({ urls: new Set([UI_TAB.url]), titles: new Set(["GoodJob"]) }),
  settings: { isEnabled: () => true },
  logsDir: () => tmp,
  cacheDir: () => tmp,
  sendToUi: (channel, payload) => sent.push([channel, payload]),
});

// D1 get text：值本体回模型；审计（右栏 step + agent.log）里只有字符数。
const secret = "王小明 北京海淀 13800138000";
const modelViewText = await service.execute({ tool: "browser_read", action: { kind: "get", what: "text", ref: "@e5" }, key: "jobs" });
assert.equal(modelViewText.text, secret, "值本体应原样回给模型");

const steps = sent.filter(([, payload]) => payload?.type === "step").map(([, payload]) => payload.step);
const textStep = steps.find((step) => step.action === "browser_read.get");
assert.ok(textStep, "get text 应记一步审计");
assert.deepEqual(textStep.command, ["get", "text", "@e5"], "审计应记受控 argv");
assert.equal(textStep.summary, `text=${secret.length} 字符（值不入日志）`, "摘要只记字符数");
assert.ok(!textStep.summary.includes("王小明") && !textStep.summary.includes("13800138000"), "摘要里搜不到值本体");

const logText = fs.readFileSync(path.join(tmp, "agent.log"), "utf8");
assert.ok(!logText.includes("王小明") && !logText.includes("13800138000"), "agent.log 里搜不到值本体");
const lastLine = JSON.parse(logText.trim().split("\n").at(-1));
assert.equal(lastLine.summary, `text=${secret.length} 字符（值不入日志）`);

// D2 get url：标量摘要保持原样（键值对原样记）。
const modelViewUrl = await service.execute({ tool: "browser_read", action: { kind: "get", what: "url" }, key: "jobs" });
assert.equal(modelViewUrl.url, PANEL_URL);
const urlStep = steps.concat(sent.filter(([, payload]) => payload?.type === "step").map(([, payload]) => payload.step))
  .filter((step) => step.action === "browser_read.get").at(-1);
assert.equal(urlStep.summary, `url=${PANEL_URL}`, "get url 标量摘要不受影响");

// D3 tab 锁定走的是面板 target（即便 UI tab 排在列表第一）。
assert.deepEqual(cliRunLog[0], ["tab", "list"]);
assert.deepEqual(cliRunLog[1], ["tab", "T_PANEL"], "应显式锁定面板 target 而不是列表第一个");

console.log("p4-agent-guard-smoke: 全部通过");
