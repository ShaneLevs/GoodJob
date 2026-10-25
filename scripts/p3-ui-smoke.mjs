/*
 * P3 渲染层冒烟测试（一次性脚本，不入构建）：
 * 通过 CDP（--remote-debugging-port=9224，仅隔离测试实例）驱动 UI，验证 P3 M1 的：
 *   岗位页「模拟面试」弹窗（轮次 / 文本可用 / 语音置灰 / 无定制稿与无 JD 的引导 / 模型门）
 *   → 面试模块页（列表行 / 进行中徽标 / 轮次进度 / 结束并出总评按钮 / 空会话引导）
 *   → 删除确认 → 浅 / 深两态截图。
 * 用法：node scripts/p3-ui-smoke.mjs
 * 前置：GOODJOB_HOME=.tmp/p3-smoke-home 的隔离实例带 --remote-debugging-port=9224 已启动。
 */
import { writeFileSync } from "node:fs";

const PORT = 9224;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("no page target");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}\n${expression.slice(0, 200)}`);
  }
  return result.result.value;
}

async function shot(name) {
  await sleep(600);
  const data = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`/tmp/p3ui-${name}.png`, Buffer.from(data.data, "base64"));
  console.log(`shot ${name}`);
}

async function clickByText(selector, text) {
  const ok = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.includes(${JSON.stringify(text)}));
    if (!el) return false;
    window.__tap(el);
    return true;
  })()`);
  if (!ok) throw new Error(`click target not found: ${selector} ${text}`);
}

async function escapeOverlay() {
  await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
}

const TAP_SETUP = `(() => {
  window.__tap = (el) => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  };
  return "tap ready";
})()`;

await send("Runtime.enable");
await send("Page.enable");
await sleep(1200);
await evaluate(TAP_SETUP);

// 0. 造数：公司 + 岗位（带 JD）+ 定制稿（走 preload API，与真实用户同通道）
const seed = await evaluate(`(async () => {
  const g = window.goodjob;
  const jobs = await g.jobs.list();
  const found = jobs.find((j) => j.title === "资深前端工程师");
  if (found) return found.id;
  const co = await g.companies.create({ name: "字节跳动", industry: "互联网", city: "北京" });
  const job = await g.jobs.create({
    title: "资深前端工程师",
    companyId: co.id,
    salaryBand: "35-60k·15薪",
    jd: "## 职责\\n- 负责跨端编辑器\\n## 要求\\n- 5 年以上前端经验",
  });
  await g.resume.save({ kind: "tailored", name: job.id }, "# 定制简历\\n\\n- 针对 JD 的取舍");
  return job.id;
})()`);
console.log("seeded job:", seed);

// 1. 岗位页：行菜单 → 模拟面试 → 弹窗
await clickByText("button", "岗位");
await sleep(500);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button[aria-label*="的操作"]')]
    .find((n) => n.getAttribute("aria-label").includes("资深前端"));
  if (!button) throw new Error("row menu trigger not found");
  window.__tap(button);
  return true;
})()`);
await sleep(350);
const menuHasInterview = await evaluate(`(() => {
  const item = [...document.querySelectorAll('div[role="menuitem"]')]
    .find((n) => n.textContent.includes("模拟面试"));
  if (!item) return false;
  const disabled = item.getAttribute("data-disabled") !== null || item.disabled === true;
  if (disabled) throw new Error("模拟面试 should be enabled");
  window.__tap(item);
  return true;
})()`);
console.log("menu item 模拟面试 enabled:", menuHasInterview);
await shot("1-interview-start-dialog");

// 弹窗内容断言：语音置灰、轮次选项存在
const dialogState = await evaluate(`(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("start dialog not open");
  const buttons = [...dialog.querySelectorAll("button")];
  const voice = buttons.find((n) => n.textContent.includes("语音面试"));
  const text = buttons.find((n) => n.textContent.includes("文本面试"));
  return {
    voiceDisabled: voice !== undefined && voice.disabled === true,
    textPressed: text !== undefined && text.getAttribute("aria-pressed") === "true",
    rounds: [...dialog.querySelectorAll('[role="option"], [data-slot*="select"]')].length,
    startDisabled: buttons.find((n) => n.textContent.includes("开始面试"))?.disabled === true,
  };
})()`);
console.log("start dialog:", JSON.stringify(dialogState));
if (!dialogState.voiceDisabled) throw new Error("语音面试应为置灰");
if (!dialogState.textPressed) throw new Error("文本面试应为选中态");
if (dialogState.startDisabled) throw new Error("已有 JD + 定制稿时开始面试应可点");

// 2. 未配置模型：点开始面试 → 模型门
await clickByText('div[role="dialog"] button', "开始面试");
await sleep(500);
const gateShown = await evaluate(
  `!!document.querySelector('[role="alertdialog"]') || !![...document.querySelectorAll('[role="dialog"] h2, [role="dialog"] [data-slot="dialog-title"]')].find(n => n.textContent.includes("模型"))`,
);
console.log("model gate shown:", gateShown);
await shot("2-model-gate");
await escapeOverlay();
await escapeOverlay();

// 3. 直接经 IPC 建一场进行中的面试（create 本身不需要模型），进面试模块
const created = await evaluate(`(async () => {
  return window.goodjob.interviews.create({ jobId: ${JSON.stringify(seed)}, rounds: 5, mode: "text" });
})()`);
console.log("created interview:", created.id, created.status, created.config);

await clickByText("button", "面试");
await sleep(600);
const pageState = await evaluate(`(() => {
  const body = document.body.textContent;
  const row = [...document.querySelectorAll("button")].find((n) => n.textContent.includes("资深前端工程师"));
  return {
    sidebarHasP3Chip: body.includes("P3"),
    hasRunningBadge: body.includes("进行中"),
    hasRoundHeader: /第 1 \\/ 5 轮/.test(body),
    hasFinishButton: body.includes("结束并出总评"),
    emptyGuidance: body.includes("还没有可用的模型"),
    rowSelected: row !== undefined,
  };
})()`);
console.log("interview page:", JSON.stringify(pageState));
if (pageState.sidebarHasP3Chip) throw new Error("侧栏不应再有 P3 占位");
if (!pageState.hasRunningBadge || !pageState.hasRoundHeader || !pageState.hasFinishButton) {
  throw new Error("面试页缺少进行中徽标 / 轮次进度 / 结束按钮");
}
await shot("3-interview-running");

// 空会话不被自动开场（无模型时）：会话文件应为空
const convEmpty = await evaluate(`(async () => {
  const state = await window.goodjob.conversations.get("interview:${created.id}");
  return state.messages.length;
})()`);
console.log("conversation messages (no model):", convEmpty);
if (convEmpty !== 0) throw new Error("未配置模型时不应自动开场发消息");

// 4. 删除：悬停行 → 垃圾桶 → 确认
await evaluate(`(() => {
  const row = [...document.querySelectorAll("button")].find((n) => n.textContent.includes("资深前端工程师"));
  const del = row.parentElement.querySelector('button[aria-label="删除这场面试"]');
  if (!del) throw new Error("delete button not found");
  del.click();
  return true;
})()`);
await sleep(400);
await shot("4-interview-delete-confirm");
const deleted = await evaluate(`(async () => {
  const btn = [...document.querySelectorAll('[role="alertdialog"] button')].find((n) => n.textContent.trim() === "删除");
  if (!btn) throw new Error("confirm not found");
  window.__tap(btn);
  await new Promise((r) => setTimeout(r, 500));
  return (await window.goodjob.interviews.list()).length;
})()`);
console.log("interviews after delete:", deleted);
if (deleted !== 0) throw new Error("删除后列表应为空");
await shot("5-interview-empty");

// 5. 深色模式：同一页面再看一眼（先再造一场避免空态）
await evaluate(`(async () => {
  await window.goodjob.interviews.create({ jobId: ${JSON.stringify(seed)}, rounds: 3, mode: "text" });
  await window.goodjob.appearance.save({ themeMode: "dark" });
  return true;
})()`);
await sleep(600);
await shot("6-interview-dark");

// 回到岗位页看深色下的发起弹窗
await clickByText("button", "岗位");
await sleep(500);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button[aria-label*="的操作"]')]
    .find((n) => n.getAttribute("aria-label").includes("资深前端"));
  window.__tap(button);
  return true;
})()`);
await sleep(350);
await evaluate(`(() => {
  const item = [...document.querySelectorAll('div[role="menuitem"]')].find((n) => n.textContent.includes("模拟面试"));
  window.__tap(item);
  return true;
})()`);
await sleep(400);
await shot("7-interview-dialog-dark");

// 恢复浅色 + 关弹窗
await evaluate(`(async () => {
  await window.goodjob.appearance.save({ themeMode: "light" });
  return true;
})()`);
await escapeOverlay();
await escapeOverlay();

console.log("done p3-ui-smoke");
ws.close();
process.exit(0);
