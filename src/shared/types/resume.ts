import type { JobMatchDimension } from "./domain";

/** 一份主简历 = resumes/ 下一个文件夹；这里是索引里的元数据。 */
export interface ResumeMeta {
  id: string;
  name: string;
  createdAt: string;
}

export interface ResumeListState {
  items: ResumeMeta[];
  currentId: string | null;
}

/** 编辑器当前打开的文件：主简历正文，或某份岗位定制稿。 */
export type ResumeDocTarget =
  | { kind: "main" }
  | { kind: "tailored"; name: string };

export interface ResumeDoc {
  resumeId: string;
  /** 简历名称（索引里的人类可读名字）。 */
  name: string;
  target: ResumeDocTarget;
  content: string;
}

export interface TailoredDoc {
  /** 文件名（不含扩展名，slug）。 */
  name: string;
  updatedAt: string | null;
}

/** 用户或 Agent 写入简历文件后广播；编辑器据此热更新，或（有未保存修改时）提示冲突。 */
export interface ResumeFileEvent {
  resumeId: string;
  /** "main" 或定制稿文件名（不含扩展名）。 */
  file: string;
}

/** 话术当前版（scripts/<jobId>.md）+ 定稿 sidecar 汇总出的列表项。 */
export interface ScriptDoc {
  /** 岗位 id（文件名即 key，与岗位 1:1）。 */
  jobId: string;
  updatedAt: string | null;
  /** 是否存在定稿。 */
  final: boolean;
  finalizedAt: string | null;
  /** 定稿后又编辑过（内容指纹 != 定稿指纹），提示「待重新定稿」。 */
  modifiedSinceFinal: boolean;
}

/** 主简历完整性报告（resumes/<id>/reports/<ts>-integrity.json）。 */
export interface IntegrityReport {
  /** 文件名（不含路径），按时间排序的键。 */
  file: string;
  score: number;
  dimensions: JobMatchDimension[];
  conclusion: string;
  createdAt: string;
}
