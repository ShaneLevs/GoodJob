/**
 * P3 M3 通知冒烟（jiti 直跑 src/main TS 源码，不启动 Electron 窗口，全程无网络）：
 * - NotifyStore：notifications.json 读写（0600 / 密码密文落盘搜不到明文 / undefined 保持
 *   / null 清除 / 校验错误 / 工作区切换重读）与 resolveTestAccount 的密码合成。
 * - NotifyService 确认门状态机（假 mailer + 假时钟 + 假 IMAP 客户端）：
 *   sent →（回信 In-Reply-To / Subject token 匹配，内容不限）⇒ approved；
 *   10min 无回信 ⇒ reminded（提醒邮件）→ 再 10min ⇒ timeout；abort 立即取消；
 *   寄给自己的原信（自带我们的 Message-ID）不会被当成回信。
 * - 分钟级 tick 的日报调度：到点发起一次 Agent 运行、当日不重发、失败也记账。
 *
 * 运行：node scripts/p3-notify-service-smoke.mjs
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

const { NotifyStore } = await jiti.import("../src/main/stores/notify.ts");
const { NotifyService, isDigestDue } = await jiti.import("../src/main/services/notify.ts");
const { ensureWorkspaceDirs, workspacePaths } = await jiti.import("../src/main/workspace/paths.ts");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-notify-smoke-"));
const paths = workspacePaths(tmp, "ws_smoke0000");
ensureWorkspaceDirs(paths);

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const MINUTE = 60_000;
const WINDOW = 10 * MINUTE;

// ———————————————— NotifyStore：默认配置 ————————————————

const store = new NotifyStore(paths);
const initial = store.toPublic();
assert.equal(initial.canStorePassword, true);
assert.equal(initial.smtp.port, 465);
assert.equal(initial.smtp.hasPassword, false);
assert.equal(initial.imap.port, 993);
assert.equal(initial.digest.daily.enabled, false);
assert.equal(initial.digest.weekly.weekday, 1);

// ———————————————— NotifyService：未配置即报错，不伪造 ————————————————

// 假 mailer + 假 IMAP 客户端从构造注入，全程无网络。
function fakeMailer() {
  const sent = [];
  return {
    sent,
    async sendMail(options) {
      sent.push(options);
      return { messageId: options.messageId ?? `<fake-${sent.length}@goodjob.local>` };
    },
  };
}
const mailer = fakeMailer();

let nowMs = Date.now();
const service = new NotifyService({ store, now: () => nowMs, mailer });
// 确认门会尝试接 IMAP：给个空壳客户端，fetch 不产出任何邮件（回信直接走 matchReplies）。
// 门结算后服务会收掉长连接（closeImap），所以每个新门之前要重新装上。
const stubImap = {
  usable: true,
  async *fetch() {},
  async logout() {},
  close() {},
};
const rearmImap = () => {
  service.imapClient = stubImap;
};
rearmImap();

await assert.rejects(service.sendNotification("hi"), /SMTP/, "未配置 SMTP 不伪造发送");
await assert.rejects(
  service.requestConfirmation("主题", "正文"),
  /SMTP/,
  "确认门同样要求先配置",
);

// 只配 SMTP 不配 IMAP：确认门收不了回信，必须拒绝。
store.save({
  fromAddress: "me@example.com",
  smtp: { host: "smtp.example.com", port: 587, secure: false, user: "me@example.com", password: "s3cret-密码" },
});
await assert.rejects(
  service.requestConfirmation("主题", "正文"),
  /IMAP/,
  "确认门还需要 IMAP 收信配置",
);

store.save({
  imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "imap-密码" },
  digest: { daily: { enabled: true, time: "09:30" } },
});

// ———————————————— 配置落盘：0600 / 密文 / 三态密码 ————————————————

const file = paths.notifications;
assert.equal(fs.statSync(file).mode & 0o777, 0o600, "notifications.json 必须 0600");
const raw = fs.readFileSync(file, "utf8");
assert.ok(!raw.includes("s3cret-密码"), "明文密码不得落盘");
assert.ok(!raw.includes("imap-密码"), "明文密码不得落盘");
assert.ok(raw.includes("passwordEncrypted"), "密码以密文字段保存");

const publicNow = store.toPublic();
assert.equal(publicNow.smtp.hasPassword, true);
assert.equal(publicNow.smtp.port, 587);
assert.equal(publicNow.smtp.secure, false);
assert.equal(publicNow.digest.daily.enabled, true);
assert.equal(publicNow.digest.daily.time, "09:30");

// 已解密配置只在 main 侧可见。
const smtp = store.resolveSmtp();
assert.equal(smtp.host, "smtp.example.com");
assert.equal(smtp.password, "s3cret-密码");
assert.equal(store.resolveImap().password, "imap-密码");

// 省略 password = 保持；null = 清除；坏端口 / 坏时刻要抛错。
store.save({ smtp: { host: "smtp.example.com", port: 587, secure: false, user: "me@example.com" } });
assert.equal(store.toPublic().smtp.hasPassword, true, "省略密码应保持已存密码");
store.save({ imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: null } });
assert.equal(store.toPublic().imap.hasPassword, false, "null 应清除密码");
store.save({ imap: { host: "imap.example.com", port: 993, secure: true, user: "me@example.com", password: "imap-密码" } });
assert.throws(
  () => store.save({ smtp: { host: "h", port: 70000, secure: true, user: "u" } }),
  /端口/,
);
assert.throws(() => store.save({ digest: { daily: { time: "25:00" } } }), /时刻/);

// resolveTestAccount：表单密码三态（undefined 用已存 / null 空 / 字符串用新值）。
assert.equal(store.resolveTestAccount("smtp", { host: "h", port: 465, secure: true, user: "u" }).password, "s3cret-密码");
assert.equal(store.resolveTestAccount("smtp", { host: "h", port: 465, secure: true, user: "u", password: null }).password, null);
assert.equal(
  store.resolveTestAccount("smtp", { host: "h", port: 465, secure: true, user: "u", password: " pending " }).password,
  "pending",
);
assert.equal(store.resolveTestAccount("imap", { host: "", port: 993, secure: true, user: "" }), null, "没填 host 不可测");

// 工作区切换：换目录重读 = 全新默认配置。
const paths2 = workspacePaths(tmp, "ws_other00000");
ensureWorkspaceDirs(paths2);
store.useWorkspace(paths2);
assert.equal(store.toPublic().smtp.host, "");
assert.equal(store.toPublic().smtp.hasPassword, false);
store.useWorkspace(paths);

// 关掉日报再跑确认门：gate 的 tick 会顺带跑 digestTick，别让它在门测试期间记账。
store.save({ digest: { daily: { enabled: false } } });

// ———————————————— 确认门：token 落 Message-ID / Subject，回信即放行 ————————————————

const gateA = service.requestConfirmation("自动投递确认", "准备投递「前端工程师」，回复即同意。");
await flush();
assert.equal(mailer.sent.length, 1);
assert.match(mailer.sent[0].subject, /自动投递确认/);
assert.match(mailer.sent[0].subject, /【确认码 [0-9A-F]{12}】/, "Subject 必须带唯一 token");
assert.match(mailer.sent[0].messageId, /^<gj-confirm-[0-9a-f]{12}@goodjob\.local>$/, "Message-ID 必须带唯一 token");
assert.equal(service.gates.size, 1);

const gateAToken = mailer.sent[0].subject.match(/【确认码 ([0-9A-F]{12})】/)[1];

// 寄给自己的原信落进 INBOX：Message-ID 是我们自己的 → 不算回信。
service.matchReplies({
  messageId: mailer.sent[0].messageId,
  inReplyTo: null,
  references: null,
  subject: mailer.sent[0].subject,
});
await flush();
assert.equal(service.gates.size, 1, "原信不得被当成回信");

// 不相关的邮件也不放行。
service.matchReplies({ messageId: "<other@a.b>", inReplyTo: null, references: null, subject: "双十一大促" });
await flush();
assert.equal(service.gates.size, 1);

// 用户回信（In-Reply-To 指向我们的确认邮件）：任何内容都算放行。
service.matchReplies({
  messageId: "<reply-1@user.example.com>",
  inReplyTo: mailer.sent[0].messageId,
  references: mailer.sent[0].messageId,
  subject: "Re: 自动投递确认",
});
assert.equal(await gateA, "approved", "回信即 approved");
assert.equal(service.gates.size, 0);

// Subject token 也能匹配（客户端丢了 In-Reply-To 的兜底）。
rearmImap();
const gateB = service.requestConfirmation("查询授权", "允许读取招聘平台消息吗？");
await flush();
const gateBToken = mailer.sent.at(-1).subject.match(/【确认码 ([0-9A-F]{12})】/)[1];
service.matchReplies({
  messageId: "<reply-2@user.example.com>",
  inReplyTo: null,
  references: null,
  subject: `re: 查询授权【确认码 ${gateBToken}】`,
});
assert.equal(await gateB, "approved", "Subject 里的 token 也能放行");

// ———————————————— 确认门：sent → reminded → timeout ————————————————

rearmImap();
const gateC = service.requestConfirmation("第三封确认", "正文 C");
await flush();
const cBase = mailer.sent.length;
assert.equal(service.gates.size, 1);

nowMs += WINDOW - 1;
await service.tick();
assert.equal(mailer.sent.length, cBase, "10 分钟内不发提醒");

nowMs += 1;
await service.tick();
assert.equal(mailer.sent.length, cBase + 1, "到 10 分钟发提醒");
assert.match(mailer.sent.at(-1).subject, /【提醒】/);
assert.ok(service.gates.size === 1, "提醒后仍等待回信");

// 提醒邮件本身也是「我们的原信」，落 INBOX 不算回信。
service.matchReplies({
  messageId: mailer.sent.at(-1).messageId,
  inReplyTo: null,
  references: null,
  subject: mailer.sent.at(-1).subject,
});
await flush();
assert.equal(service.gates.size, 1);

nowMs += WINDOW - 1;
await service.tick();
assert.ok(service.gates.size === 1, "第二窗口内不判超时");
nowMs += 1;
await service.tick();
assert.equal(await gateC, "timeout", "两个窗口无回信 ⇒ timeout（未放行）");
assert.equal(service.gates.size, 0);

// ———————————————— 确认门：abort 立即取消 ————————————————

rearmImap();
const controller = new AbortController();
const gateD = service.requestConfirmation("会被取消的确认", "正文 D", controller.signal);
await flush();
assert.equal(service.gates.size, 1);
controller.abort();
await assert.rejects(gateD, /取消/, "abort 后确认门立即拒绝");
assert.equal(service.gates.size, 0);

// ———————————————— 日报 / 周报调度：到点一次，当日不重发 ————————————————

store.save({ digest: { daily: { enabled: true, time: "00:00" } } });
const digestRuns = [];
service.setDigestRunner(async (kind) => {
  digestRuns.push(kind);
});

// 今天 12:00：00:00 已过 → 到点。
const noon = new Date();
noon.setHours(12, 0, 0, 0);
nowMs = noon.getTime();
await service.tick();
assert.deepEqual(digestRuns, ["daily"], "到点发起一次日报运行");
await service.tick();
assert.deepEqual(digestRuns, ["daily"], "当日不重发（到点即记账）");

// runDigest 失败也记账：不让一次失败变成整点风暴。
service.setDigestRunner(async () => {
  digestRuns.push("daily");
  throw new Error("模型没配");
});
store.markDigestRun("daily", "2000-01-01"); // 重置记账日，模拟第二天
await service.tick();
assert.equal(digestRuns.length, 2, "失败后当日不再自动重试");

// isDigestDue 单元：weekly 的星期不对不到点；时刻未到不到点。
const today = new Date(nowMs);
const wrongWeekday = (today.getDay() + 2) % 7;
assert.equal(isDigestDue({ enabled: true, time: "00:00", weekday: wrongWeekday }, "weekly", nowMs), false);
assert.equal(isDigestDue({ enabled: true, time: "00:00", weekday: today.getDay() }, "weekly", nowMs), true);
assert.equal(isDigestDue({ enabled: true, time: "23:59" }, "daily", nowMs), false, "时刻未到");
assert.equal(isDigestDue({ enabled: false, time: "00:00" }, "daily", nowMs), false);

// stopAll：等待中的门按取消处理。
rearmImap();
const gateE = service.requestConfirmation("停止时的确认", "正文 E");
await flush();
assert.equal(service.gates.size, 1);
service.stopAll();
await assert.rejects(gateE, /停止/, "stopAll 取消所有等待中的门");
assert.equal(service.gates.size, 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  "notify-service smoke OK（配置读写 / 密文落盘 / 确认门 approved·reminded·timeout·abort / 自邮件排除 / 日报调度 / stopAll）",
);
process.exit(0);
