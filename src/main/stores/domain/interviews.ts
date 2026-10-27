import { randomUUID } from "node:crypto";

import type {
  Interview,
  InterviewCreateInput,
  InterviewMode,
  InterviewReview,
  InterviewRound,
} from "@shared/types";

import { JsonCollectionStore } from "../json-collection";
import type { ResumeStore } from "../resumes";
import type { JobsStore } from "./jobs";
import type { WorkspacePaths } from "../../workspace/paths";

/*
 * 模拟面试记录（P3 M1）：一场面试一个 `interviews/<id>.json`，复用 stores/domain
 * 的 JSON 集合底座。记录里存的是结构化轮次与总评；逐轮问答的消息本体在
 * `interview:<id>` 会话里（ConversationsStore，UIMessage），两边各司其职：
 * 会话给渲染管线与重启恢复，记录给列表 / 逐轮时间线 / 总评。
 *
 * 写入口只有两条：AgentRuntime 的 interview_round_log / interview_submit_review
 * 工具（面试官模型在面试中调用）与 create/remove（渲染层发起 / 删除）。
 * 轮次序号由这里分配，模型不能指定；结束只允许一次。
 */

/** 轮次硬上限：指令要求模型按设定轮次走，这里挡住失控的重复记录。 */
const MAX_ROUNDS = 24;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 要点数组清洗：去空、去重不必要——只 trim，保持模型给的顺序。 */
function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = str(item).trim();
    return text === "" ? [] : [text];
  });
}

export class InterviewsStore {
  private readonly store: JsonCollectionStore<Interview>;

  constructor(
    workspace: WorkspacePaths,
    private readonly jobs: JobsStore,
    private readonly resumes: ResumeStore,
  ) {
    this.store = new JsonCollectionStore(workspace, "interviews", "iv_", reviveInterview);
  }

  useWorkspace(workspace: WorkspacePaths): void {
    this.store.useWorkspace(workspace);
  }

  list(): Interview[] {
    return this.store.list();
  }

  get(id: string): Interview | null {
    return this.store.get(id);
  }

  /** 发起面试：岗位必须存在且已有定制稿（面试绑定 JD 与定制简历，见 P3 拍板 5）。 */
  create(input: InterviewCreateInput): Interview {
    const jobId = input.jobId.trim();
    const job = this.jobs.get(jobId);
    if (job === null) throw new Error(`岗位不存在：${jobId}（先用 job_list 或岗位表查 id）`);
    if (job.jd.trim() === "") throw new Error("这个岗位还没有 JD，先在岗位表里补上再发起面试。");
    if (this.resumes.readTailored(jobId) === null) {
      throw new Error("这个岗位还没有定制简历，先生成一份再发起面试。");
    }
    const rounds = Math.round(input.rounds);
    if (!Number.isFinite(rounds) || rounds < 1 || rounds > 12) {
      throw new Error("轮次必须是 1–12 的整数。");
    }
    const mode: InterviewMode = input.mode === "voice" ? "voice" : "text";
    const now = nowIso();
    const interview: Interview = {
      id: `iv_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      jobId,
      resumeRef: `tailored/${jobId}.md`,
      config: { rounds, mode },
      rounds: [],
      review: null,
      status: "running",
      createdAt: now,
      finishedAt: null,
    };
    this.store.put(interview);
    return interview;
  }

  /**
   * 记录 / 刷新一轮（面试官工具 interview_round_log 的落点）。
   * 序号按记录顺序分配；模型把同一轮补记（追问记全了再记一次）时按主问题
   * 匹配最后一轮整体覆盖，不产生重复轮次。
   */
  logRound(
    id: string,
    entry: { question: string; followUps?: string[]; answer?: string; note?: string },
  ): Interview {
    const interview = this.mustGet(id);
    if (interview.status === "finished") {
      throw new Error("这场面试已经结束了，不能再记录轮次。");
    }
    if (interview.rounds.length >= Math.max(MAX_ROUNDS, interview.config.rounds)) {
      throw new Error(
        `轮次记录已达上限（设定 ${interview.config.rounds} 轮）。该收束面试并出总评了（interview_submit_review）。`,
      );
    }
    const question = entry.question.trim();
    if (question === "") throw new Error("question（本轮主问题）不能为空。");
    const round: InterviewRound = {
      no: interview.rounds.length + 1,
      question,
      followUps: strList(entry.followUps),
      answer: entry.answer?.trim() ?? "",
    };
    const note = entry.note?.trim();
    if (note !== undefined && note !== "") round.note = note;
    const last = interview.rounds.at(-1);
    const rounds =
      last !== undefined && last.question === question
        ? [...interview.rounds.slice(0, -1), { ...last, ...round, no: last.no }]
        : [...interview.rounds, round];
    const next: Interview = { ...interview, rounds };
    this.store.put(next);
    return next;
  }

  /**
   * 结束并写回总评（面试官工具 interview_submit_review 的落点）：幂等保护——
   * 已有总评的面试不再改写。roundNotes 与已记录轮次按序对齐，补写每轮表现小结。
   */
  finish(id: string, review: InterviewReview, roundNotes?: string[]): Interview {
    const interview = this.mustGet(id);
    if (interview.review !== null || interview.status === "finished") {
      throw new Error("这场面试已经有总评了。");
    }
    const score = Math.round(review.score);
    const normalized: InterviewReview = {
      score: Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0,
      overall: review.overall.trim(),
      strengths: strList(review.strengths),
      weaknesses: strList(review.weaknesses),
      suggestions: strList(review.suggestions),
    };
    if (normalized.overall === "") throw new Error("overall（总评正文）不能为空。");
    const notes = strList(roundNotes);
    const rounds = interview.rounds.map((round, index) =>
      notes[index] === undefined ? round : { ...round, note: notes[index] },
    );
    const next: Interview = {
      ...interview,
      rounds,
      review: normalized,
      status: "finished",
      finishedAt: nowIso(),
    };
    this.store.put(next);
    return next;
  }

  remove(id: string): void {
    if (!this.store.remove(id)) throw new Error(`面试不存在：${id}`);
    // 不级联：岗位不受影响；对应的 interview:<id> 会话由 IPC 层一并清理。
  }

  private mustGet(id: string): Interview {
    const interview = this.store.get(id);
    if (interview === null) throw new Error(`面试不存在：${id}`);
    return interview;
  }
}

/** 磁盘记录 → 实体：字段缺省 / 坏值给默认，单个坏文件不拖垮集合（底座已兜底）。 */
function reviveInterview(raw: unknown, file: string): Interview | null {
  if (!isRecord(raw)) return null;
  const id = file.slice(0, -".json".length);
  const now = nowIso();
  const config = isRecord(raw.config) ? raw.config : {};
  const roundsInput = Math.round(Number(config.rounds));
  const rounds: InterviewRound[] = Array.isArray(raw.rounds)
    ? raw.rounds.flatMap((item, index): InterviewRound[] => {
        if (!isRecord(item) || str(item.question).trim() === "") return [];
        const round: InterviewRound = {
          no: typeof item.no === "number" ? item.no : index + 1,
          question: str(item.question).trim(),
          followUps: strList(item.followUps),
          answer: str(item.answer),
        };
        const note = nullableStr(item.note);
        if (note !== null) round.note = note;
        const audioMark = nullableStr(item.audioMark);
        if (audioMark !== null) round.audioMark = audioMark;
        return [round];
      })
    : [];
  const review = isRecord(raw.review) && str(raw.review.overall).trim() !== ""
    ? {
        score: typeof raw.review.score === "number" ? Math.round(raw.review.score) : 0,
        overall: str(raw.review.overall),
        strengths: strList(raw.review.strengths),
        weaknesses: strList(raw.review.weaknesses),
        suggestions: strList(raw.review.suggestions),
      }
    : null;
  const status = raw.status === "finished" || review !== null ? "finished" : "running";
  return {
    id,
    jobId: str(raw.jobId),
    resumeRef: str(raw.resumeRef),
    config: {
      rounds: Number.isFinite(roundsInput) && roundsInput >= 1 ? roundsInput : 5,
      mode: config.mode === "voice" ? "voice" : "text",
    },
    rounds,
    review,
    status,
    createdAt: str(raw.createdAt) || now,
    finishedAt: nullableStr(raw.finishedAt),
  };
}
