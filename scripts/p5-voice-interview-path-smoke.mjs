/**
 * P5 语音面试「没有旁路」冒烟（jiti 直跑 src/main 的真实 store）：
 *
 * 语音模式只是发起参数，轮次与总评仍走 `interviews/<id>.json` 这一套记录：
 * - `create({ mode: "voice" })` 落盘 mode=voice，校验规则与文本一致；
 * - `logRound` 分配轮次、同主问题覆盖、不同主问题追加；
 * - `finish` 写总评（分数夹在 0–100）、状态变 finished、二次 finish 幂等；
 * - 新建 store 实例读回同一份记录（重启语义）。
 *
 * 运行：node scripts/p5-voice-interview-path-smoke.mjs
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

const { InterviewsStore } = await jiti.import("../src/main/stores/domain/interviews.ts");
const { CompaniesStore } = await jiti.import("../src/main/stores/domain/companies.ts");
const { JobsStore } = await jiti.import("../src/main/stores/domain/jobs.ts");
const { PipelineStore } = await jiti.import("../src/main/stores/domain/pipeline.ts");
const { ResumeStore } = await jiti.import("../src/main/stores/resumes.ts");
const { ensureWorkspaceDirs, workspacePaths } = await jiti.import(
  "../src/main/workspace/paths.ts",
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-voice-interview-"));
const paths = workspacePaths(tmp, "ws_voicesmoke");
ensureWorkspaceDirs(paths);

const companies = new CompaniesStore(paths);
const pipeline = new PipelineStore(paths);
const jobs = new JobsStore(paths, companies, pipeline);
const resumes = new ResumeStore(paths, () => {});
const interviews = new InterviewsStore(paths, jobs, resumes);

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ✓ ${name}`);
}

console.log("语音面试记录冒烟");

const job = jobs.create({ title: "AI 产品经理（TO B）" });
assert.throws(() => interviews.create({ jobId: job.id, rounds: 5, mode: "voice" }), /JD/);
jobs.update(job.id, { jd: "# JD\n\n- B 端产品\n- 大模型" });
assert.throws(() => interviews.create({ jobId: job.id, rounds: 5, mode: "voice" }), /定制简历/);
resumes.writeTailored(job.id, "# 定制简历\n\n- 企业知识库");

const interview = interviews.create({ jobId: job.id, rounds: 3, mode: "voice" });
check("发起：mode=voice 落盘，绑定 JD + 定制稿", () => {
  assert.equal(interview.config.mode, "voice");
  assert.equal(interview.config.rounds, 3);
  assert.equal(interview.resumeRef, `tailored/${job.id}.md`);
  assert.equal(interview.status, "running");
  assert.equal(interview.rounds.length, 0);
});

interviews.logRound(interview.id, {
  question: "介绍一下你做过的最拿得出手的 B 端产品。",
  followUps: [" 指标是什么？ "],
  answer: "企业知识库，覆盖 3 万员工。",
});
interviews.logRound(interview.id, {
  question: "介绍一下你做过的最拿得出手的 B 端产品。",
  followUps: ["指标是什么？", "怎么衡量成功？"],
  answer: "企业知识库，覆盖 3 万员工，检索命中率 82%。",
});
interviews.logRound(interview.id, {
  question: "你怎么判断一个 AI 需求该不该做？",
  answer: "先看场景价值，再看模型能力边界。",
});
const logged = interviews.get(interview.id);
check("轮次：同主问题覆盖、不同主问题追加、序号由 store 分配", () => {
  assert.equal(logged.rounds.length, 2);
  assert.deepEqual(logged.rounds[0].followUps, ["指标是什么？", "怎么衡量成功？"]);
  assert.equal(logged.rounds[0].no, 1);
  assert.equal(logged.rounds[1].no, 2);
});

const finished = interviews.finish(
  interview.id,
  {
    score: 88,
    overall: "## 总评\n\n表达清楚，能落到指标。",
    strengths: ["有具体数字"],
    weaknesses: ["缺少失败复盘"],
    suggestions: ["补一个失败案例"],
  },
  ["第 1 轮不错", "第 2 轮略泛"],
);
check("总评：状态 finished、分数与逐轮小结落账", () => {
  assert.equal(finished.status, "finished");
  assert.equal(finished.review.score, 88);
  assert.equal(finished.review.overall.includes("总评"), true);
  assert.equal(finished.rounds[0].note, "第 1 轮不错");
  assert.equal(finished.rounds[1].note, "第 2 轮略泛");
  assert.equal(typeof finished.finishedAt, "string");
});

assert.throws(
  () =>
    interviews.finish(interview.id, {
      score: 10,
      overall: "第二次不应覆盖",
      strengths: [],
      weaknesses: [],
      suggestions: [],
    }),
  /已经有总评/,
);
check("总评幂等：二次 finish 被拒绝，已存总评不变", () => {
  const stored = interviews.get(interview.id);
  assert.equal(stored.review.score, 88);
  assert.equal(stored.review.overall.includes("第二次不应覆盖"), false);
});

const reopened = new InterviewsStore(paths, jobs, resumes);
const readBack = reopened.get(interview.id);
check("重启语义：新 store 实例读回 voice 模式、轮次与总评", () => {
  assert.equal(readBack.config.mode, "voice");
  assert.equal(readBack.rounds.length, 2);
  assert.equal(readBack.review.score, 88);
  assert.equal(readBack.status, "finished");
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过：${checks} 项检查。`);
// ResumeStore 的 fs.watch 会留住事件循环：冒烟结束显式退出（不影响断言结果）。
process.exit(0);
