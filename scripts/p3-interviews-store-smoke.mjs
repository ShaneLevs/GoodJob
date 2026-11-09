/**
 * P3 M1 store 冒烟（jiti 直跑 src/main TS 源码，不启动 Electron 窗口）：
 * 覆盖 InterviewsStore 的发起校验 / 轮次落账幂等 / 总评收束 / 复活读取 / 权限位，
 * 以及删除面试时 ConversationsStore 对 `interview:<id>` 会话文件的连带清理。
 *
 * 运行：node scripts/p3-interviews-store-smoke.mjs
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
    // 类型都走 type-only import（编译期擦除），agent/runtime 是第一个运行时
    // require @shared/types 的模块：给 jiti 补上 tsconfig paths 同款别名。
    "@shared": path.join(here, "..", "src", "shared"),
    // Node 26 + jiti 不认 Vite 的 `?raw`：技能正文与面试存储无关，映射成空串。
    "./SKILL.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/interview-strategy.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/section-checklist.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/workflow.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/jd-analysis.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/matching-diagnosis.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/scoring-rubric.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
    "./references/writing-standards.md?raw": path.join(here, "p3-smoke-raw-stub.mjs"),
  },
});

const { InterviewsStore } = await jiti.import("../src/main/stores/domain/interviews.ts");
const { CompaniesStore } = await jiti.import("../src/main/stores/domain/companies.ts");
const { JobsStore } = await jiti.import("../src/main/stores/domain/jobs.ts");
const { PipelineStore } = await jiti.import("../src/main/stores/domain/pipeline.ts");
const { ResumeStore } = await jiti.import("../src/main/stores/resumes.ts");
const { ConversationsStore } = await jiti.import("../src/main/stores/conversations.ts");
const { ensureWorkspaceDirs, rootPaths, workspacePaths } = await jiti.import(
  "../src/main/workspace/paths.ts",
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goodjob-interviews-smoke-"));
const root = rootPaths(tmp);
fs.mkdirSync(root.workspaces, { recursive: true });
const paths = workspacePaths(tmp, "ws_smoke0000");
ensureWorkspaceDirs(paths);

const companies = new CompaniesStore(paths);
const pipeline = new PipelineStore(paths);
const jobs = new JobsStore(paths, companies, pipeline);
const resumes = new ResumeStore(paths, () => {});
const conversations = new ConversationsStore(paths);
const interviews = new InterviewsStore(paths, jobs, resumes);

// —— 发起校验：岗位必须存在、必须有 JD、必须有定制稿；轮次 1–12 ——

assert.throws(
  () => interviews.create({ jobId: "job_missing0000", rounds: 5, mode: "text" }),
  /岗位不存在/,
);

const job = jobs.create({ title: "资深前端工程师" });
assert.throws(
  () => interviews.create({ jobId: job.id, rounds: 5, mode: "text" }),
  /JD/,
);

jobs.update(job.id, { jd: "# JD\n\n- React\n- 三年经验" });
assert.throws(
  () => interviews.create({ jobId: job.id, rounds: 5, mode: "text" }),
  /定制简历/,
);

resumes.writeTailored(job.id, "# 定制简历\n\n- 针对 JD 的取舍");
assert.throws(() => interviews.create({ jobId: job.id, rounds: 0, mode: "text" }), /轮次/);
assert.throws(() => interviews.create({ jobId: job.id, rounds: 99, mode: "text" }), /轮次/);

const interview = interviews.create({ jobId: job.id, rounds: 3, mode: "text" });
assert.match(interview.id, /^iv_[0-9a-f]{12}$/);
assert.equal(interview.resumeRef, `tailored/${job.id}.md`);
assert.equal(interview.status, "running");
assert.equal(interview.rounds.length, 0);
assert.equal(interview.review, null);
assert.equal(interview.finishedAt, null);

// —— 轮次落账：序号由 store 分配；同主问题补记覆盖，不同主问题追加 ——

interviews.logRound(interview.id, { question: "介绍一下最拿得出手的项目", followUps: [" QPS 多少？ "], answer: "做了 X 系统" });
let current = interviews.get(interview.id);
assert.equal(current.rounds.length, 1);
assert.equal(current.rounds[0].no, 1);
assert.deepEqual(current.rounds[0].followUps, ["QPS 多少？"]);

interviews.logRound(interview.id, {
  question: "介绍一下最拿得出手的项目",
  followUps: ["QPS 多少？", "失败怎么兜底？"],
  answer: "做了 X 系统，补充细节",
});
current = interviews.get(interview.id);
assert.equal(current.rounds.length, 1, "同一主问题的补记应整体覆盖而不是新增一轮");
assert.equal(current.rounds[0].followUps.length, 2);

interviews.logRound(interview.id, { question: "第二问", answer: "第二答" });
current = interviews.get(interview.id);
assert.equal(current.rounds.length, 2);
assert.equal(current.rounds[1].no, 2);

// —— 总评收束：一次写回，roundNotes 按轮对齐，重复收束 / 结束后补记被拒 ——

const finished = interviews.finish(
  interview.id,
  { score: 78.4, overall: "# 总评\n\n表达 80…", strengths: ["回答稳"], weaknesses: ["", "量化不足"], suggestions: ["简历补数字"] },
  ["第 1 轮小结", "第 2 轮小结", "多余的小结"],
);
assert.equal(finished.status, "finished");
assert.equal(finished.review.score, 78, "分数取整");
assert.equal(finished.review.weaknesses.length, 1, "空要点被清洗");
assert.equal(finished.rounds[0].note, "第 1 轮小结");
assert.equal(finished.rounds[1].note, "第 2 轮小结");
assert.ok(finished.finishedAt !== null);

assert.throws(
  () => interviews.finish(interview.id, { score: 90, overall: "x", strengths: [], weaknesses: [], suggestions: [] }),
  /已经有总评/,
);
assert.throws(
  () => interviews.logRound(interview.id, { question: "第三问", answer: "第三答" }),
  /已经结束/,
);

// —— 落盘：0600 权限；新 store 实例（重启 / 切工作区语义）从磁盘复活 ——

const file = path.join(paths.interviews, `${interview.id}.json`);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);

const interviews2 = new InterviewsStore(paths, jobs, resumes);
const revived = interviews2.get(interview.id);
assert.equal(revived.status, "finished");
assert.equal(revived.rounds.length, 2);
assert.equal(revived.rounds[0].note, "第 1 轮小结");
assert.equal(revived.review.score, 78);
assert.equal(revived.config.rounds, 3);

assert.equal(interviews2.list().length, 1);

// —— 删除：会话文件一并清掉 ——

const key = `interview:${interview.id}`;
conversations.updateMessages(key, [{ id: "m1", role: "user", parts: [{ type: "text", text: "开场" }] }]);
const convFile = path.join(paths.conversations, `${encodeURIComponent(key)}.json`);
assert.ok(fs.existsSync(convFile));

assert.throws(() => interviews.remove("iv_notexist0000"), /面试不存在/);
interviews2.remove(interview.id);
conversations.remove(key);
assert.ok(!fs.existsSync(file), "面试记录文件应被删除");
assert.ok(!fs.existsSync(convFile), "对应会话文件应被删除");
assert.equal(interviews2.get(interview.id), null);

// —— 会话按复合 key 编码落盘的名字不受影响 ——

assert.equal(encodeURIComponent(key), "interview%3A" + interview.id);

// —— AgentRuntime 的 interview 会话装配：工具白名单 / 指令 / 工具写入口（不调真模型）——

const { AgentRuntime } = await jiti.import("../src/main/agent/runtime.ts");
const { MemoryStore } = await jiti.import("../src/main/stores/memory.ts");
const { ModelsStore } = await jiti.import("../src/main/stores/models.ts");
const { TaskManager } = await jiti.import("../src/main/services/tasks.ts");

const memory = new MemoryStore(paths);
const models = new ModelsStore(root);
const taskManager = new TaskManager({ models, jobs, resumes, emit: () => {} });
const runtime = new AgentRuntime({
  models,
  conversations,
  resumes,
  memory,
  companies,
  jobs,
  pipeline,
  interviews,
  tasks: taskManager,
  // 下面几项是后来加进 AgentDeps 的服务：面试会话不会碰它们，给最小桩即可。
  notify: {},
  browser: {},
  browserSettings: {},
  logsDir: () => paths.logs,
  uploadDir: () => paths.uploads,
  workflow: {},
});

// 发起第二场面试（running），验证会话装配。
const runningInterview = interviews.create({ jobId: job.id, rounds: 5, mode: "text" });
const interviewKey = `interview:${runningInterview.id}`;

// 私有方法冒烟取用（TS 的 private 只是编译期）：JS 侧直接按属性访问。
const tools = runtime.toolsFor(interviewKey);
assert.deepEqual(
  Object.keys(tools).sort(),
  [
    "conversation_read",
    "conversation_search",
    "interview_round_log",
    "interview_submit_review",
    "job_info",
    "job_script_read",
    "job_tailored_read",
    "resume_read",
    "upload_list",
    "upload_read",
  ],
  "面试会话只允许只读材料 / 会话检索 / 上传读取 + 两个面试记录工具，不给任何简历/岗位/话术写工具，也不给 memory 工具",
);

const roundLogResult = await tools.interview_round_log.execute(
  { question: "Q1", followUps: ["F1"], answer: "A1" },
  { toolCallId: "t1", messages: [] },
);
assert.match(String(roundLogResult), /已记录第 1 轮（设定 5 轮）/);
assert.equal(interviews.get(runningInterview.id).rounds.length, 1);

// running 状态的指令：persona + 实时进度（runtime 侧硬约束的一半），且不注入长期记忆节。
const runningInstructions = runtime.buildInstructions(interviewKey, null, "长期记忆内容");
assert.match(runningInstructions, /模拟面试官/);
assert.match(runningInstructions, /面试进度：已完整记录 1 \/ 设定 5 轮/);
assert.match(runningInstructions, /1\. Q1/);
assert.doesNotMatch(runningInstructions, /长期记忆/, "面试会话不注入长期记忆节（也没有 memory 工具）");

const reviewResult = await tools.interview_submit_review.execute(
  { score: 66, overall: "# 总评", strengths: ["稳"], weaknesses: [], suggestions: [] },
  { toolCallId: "t2", messages: [] },
);
assert.match(String(reviewResult), /总评已保存/);
assert.equal(interviews.get(runningInterview.id).status, "finished");

const finishedInstructions = runtime.buildInstructions(interviewKey, null, "记忆");
assert.match(finishedInstructions, /面试状态：已结束（总评 66\/100）/);
assert.doesNotMatch(finishedInstructions, /长期记忆/);

const missingInstructions = runtime.buildInstructions("interview:iv_gone00000000", null, "记忆");
assert.match(missingInstructions, /记录已经不存在/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(
  "interviews-store smoke OK（发起校验 / 轮次幂等 / 总评收束 / 复活 / 0600 / 会话连带删除 / runtime 工具白名单与指令）",
);
process.exit(0);
