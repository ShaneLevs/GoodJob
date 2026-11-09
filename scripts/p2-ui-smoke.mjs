/*
 * P2 渲染层冒烟测试（一次性脚本，不入构建）：
 * 通过 CDP（--remote-debugging-port=9223，仅隔离测试实例）驱动 UI：
 * 截图各模块页（浅 / 深两态）、用 preload API 造数、点开弹窗。
 * 用法：node scripts/p2-ui-smoke.mjs <mode light|dark> <tag>
 */
import { writeFileSync } from "node:fs";

const PORT = 9223;
const mode = process.argv[2] ?? "light";
const tag = process.argv[3] ?? mode;

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
  writeFileSync(`/tmp/p2ui-${tag}-${name}.png`, Buffer.from(data.data, "base64"));
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

const TAP_SETUP = `(() => {
  window.__tap = (el) => {
    // Radix 触发器吃 pointerdown，普通按钮吃 click：补全一整套指针序列。
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  };
  return "tap ready";
})()`;

await evaluate(TAP_SETUP);

/** 打开行菜单（触发器吃 pointerdown）；pickMenuItem 再点具体项。 */
async function openRowMenu(rowLabel) {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button[aria-label*="的操作"]')]
      .find((n) => n.getAttribute("aria-label").includes(${JSON.stringify(rowLabel)}));
    if (!button) throw new Error("row menu trigger not found: " + ${JSON.stringify(rowLabel)});
    window.__tap(button);
    return true;
  })()`);
  await sleep(350);
}

async function pickMenuItem(itemText) {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('div[role="menuitem"]')]
      .find((n) => n.textContent.includes(${JSON.stringify(itemText)}));
    if (!item) throw new Error("menu item not found: " + ${JSON.stringify(itemText)});
    window.__tap(item);
    return true;
  })()`);
}

await send("Runtime.enable");
await send("Page.enable");
await sleep(1200);

// 0. 首页（简历模块，回归）
await shot("0-resume");

// 1. 造数（走 preload API，与真实用户操作同一通道）
const seed = await evaluate(`(async () => {
  const g = window.goodjob;
  if ((await g.companies.list()).some((c) => c.name === "字节跳动")) return "already seeded";
  const co = await g.companies.create({ name: "字节跳动", industry: "互联网", city: "北京", scale: "10000+ 人", source: "官网" });
  const co2 = await g.companies.create({ name: "蔚来汽车", industry: "智能汽车", city: "上海", scale: "20000+ 人", source: "招聘平台" });
  await g.companies.update(co.id, { research: "## 调研\\n- 视频化业务为主，海外增长快（来源：官网，2026-10）" });
  const job = await g.jobs.create({ title: "资深前端工程师", companyId: co.id, salaryBand: "35-60k·15薪", jd: "## 职责\\n- 负责跨端编辑器\\n## 要求\\n- 5 年以上前端经验", note: "官网投递" });
  const job2 = await g.jobs.create({ title: "前端架构师", companyId: co2.id, salaryBand: "45-70k", jd: "负责基础设施", note: "内推" });
  await g.jobs.advance(job.id, "已投递", "官网");
  await g.jobs.advance(job.id, "简历通过", "HR 电话");
  await g.jobs.advance(job2.id, "已投递", "内推人小王");
  await g.jobs.update(job2.id, { offer: { salary: "50k·16薪", equity: "RSU $120k", note: "月底给答复" } });
  await g.resume.scripts.save(job.id, "# 自我介绍\\n五年前端，做过编辑器。");
  await g.resume.scripts.finalize(job.id);
  return "seeded";
})()`);
console.log(seed);

// 2. 公司页
await clickByText("button", "公司");
await shot("1-companies");
// 编辑弹窗
await clickByText("button", "新建公司");
await shot("2-company-dialog");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(400);
// 行菜单
await openRowMenu("字节跳动");
await shot("3-company-rowmenu");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

// 3. 岗位页（有数据 + 排序）
await clickByText("button", "岗位");
await sleep(400);
await evaluate(`[...document.querySelectorAll("button[aria-label='按公司排序']")][0].click()`);
await shot("4-jobs");
// 话术管理弹窗（资深前端那条话术已定稿）
await openRowMenu("资深前端");
await shot("4a-job-rowmenu");
await pickMenuItem("话术管理");
await shot("4b-script");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

// 4. 岗位页 + 推进弹窗 + 流水线设置
await openRowMenu("资深前端");
await shot("5-job-rowmenu");
await pickMenuItem("推进状态");
await shot("6-advance");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(300);
await clickByText("button", "流水线");
await shot("7-pipeline");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

// 5. Offer 勾选 + 对比：再补一条 Offer，重载后两条都可勾选
await evaluate(`(async () => {
  const jobs = await window.goodjob.jobs.list();
  const first = jobs.find((j) => j.offer === null);
  if (first) await window.goodjob.jobs.update(first.id, { offer: { salary: "38k·16薪", equity: "签字费 5 万", note: "要求两周内答复" } });
  return "ok";
})()`);
await send("Page.reload");
await sleep(1800);
await evaluate(TAP_SETUP);
await clickByText("button", "岗位");
await sleep(500);
await evaluate(`(() => {
  const boxes = [...document.querySelectorAll('[role="checkbox"]')];
  if (boxes.length < 2) throw new Error("expected 2 checkboxes, got " + boxes.length);
  for (const box of boxes) window.__tap(box);
  return true;
})()`);
await sleep(300);
await clickByText("button", "对比 Offer");
await shot("8-offer-compare");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

// 6. 岗位编辑弹窗（含投递备注 / Offer）
await clickByText("button", "岗位");
await sleep(400);
await openRowMenu("资深前端");
await pickMenuItem("编辑");
await shot("9-job-edit");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);

console.log("done", tag);
ws.close();
process.exit(0);
