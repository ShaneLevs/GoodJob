import fs from "node:fs";
import path from "node:path";

import { nativeImage } from "electron";

import {
  conversationScope,
  interviewKeyTarget,
  isImageUploadName,
  jobKeyTarget,
  type ConversationKey,
  type UploadedFileMeta,
} from "@shared/types";

import { ensureDir, type WorkspacePaths } from "./paths";

/** 单个上传文件的大小上限：参考文件用不着更大，挡住误选的安装包/视频。 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 工具读取上传文件时的文本上限，防止巨型文本撑爆上下文。 */
const READ_TEXT_LIMIT = 300_000;
/** 图片解码上限：超过就不读进内存，避免原图撑爆主进程。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 会话 → 上传目录（每个模块自己的目录，互不串）：
 *   resume         → 由 ResumeStore 给的当前简历 upload/（resumes/<当前简历>/upload/）
 *   companies      → companies/upload/
 *   jobs           → jobs/upload/
 *   applications   → applications/upload/
 *   job:<jobId>    → jobs/upload/<jobId>/
 *   interview:<id> → interviews/upload/<id>/
 *
 * 上传只落盘、不解析：正文留给 Agent 用 upload_list / upload_read 按需读
 * （对话里只出现文件名，不塞全文）。图片（png / jpg / jpeg）额外提供
 * 缩略图与视觉模型的读取入口，原文件同样只落盘、不预先解析。
 */
export function uploadDirFor(
  workspace: WorkspacePaths,
  key: ConversationKey,
  resumeUploadDir: string | null,
): string {
  // 上传目录跟着场景走，不跟着具体对话走：同一模块的多个对话共享参考文件。
  const scope = conversationScope(key);
  const jobId = jobKeyTarget(scope);
  if (jobId !== null) return path.join(workspace.jobsUpload, safeSegment(jobId));
  const interviewId = interviewKeyTarget(scope);
  if (interviewId !== null) return path.join(workspace.interviewsUpload, safeSegment(interviewId));
  switch (scope) {
    case "companies":
      return workspace.companiesUpload;
    case "jobs":
      return workspace.jobsUpload;
    case "applications":
      return workspace.applicationsUpload;
    default:
      // 简历会话的路径由 ResumeStore 拼（它才知道哪份是当前简历）。
      if (resumeUploadDir === null) throw new Error("还没有简历，先建一份简历再上传参考文件");
      return resumeUploadDir;
  }
}

/** 把所选文件原样复制进上传目录，返回落盘回执（同名不覆盖）。 */
export function saveUploadFile(dir: string, srcPath: string): UploadedFileMeta {
  const size = fs.statSync(srcPath).size;
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`);
  }

  ensureDir(dir);
  const fileName = dedupeFileName(dir, sanitizeUploadName(path.basename(srcPath)));
  const dest = path.join(dir, fileName);
  fs.copyFileSync(srcPath, dest);
  fs.chmodSync(dest, 0o600);
  return { fileName, size: fs.statSync(dest).size };
}

/**
 * 上传目录里的图片 → data URL（对话缩略图与视觉模型共用）。
 * 只认上传目录内的 png / jpg / jpeg；realpath 防越界，超过 maxWidth 时等比缩小。
 * 文件不存在、越界、过大或解不出来时返回 null。
 */
export function readUploadImageDataUrl(
  dir: string,
  fileName: string,
  maxWidth: number,
): string | null {
  let safe: string;
  try {
    safe = sanitizeUploadName(fileName);
  } catch {
    return null;
  }
  if (!isImageUploadName(safe)) return null;

  let realDir: string;
  let realFile: string;
  let stat: fs.Stats;
  try {
    realDir = fs.realpathSync(dir);
    realFile = fs.realpathSync(path.join(dir, safe));
    stat = fs.statSync(realFile);
  } catch {
    return null;
  }
  if (!realFile.startsWith(`${realDir}${path.sep}`)) return null;
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;

  const image = nativeImage.createFromPath(realFile);
  if (image.isEmpty()) return null;
  const scaled =
    image.getSize().width > maxWidth
      ? image.resize({ width: maxWidth, quality: "good" })
      : image;
  const isPng = path.extname(realFile).toLowerCase() === ".png";
  const bytes = isPng ? scaled.toPNG() : scaled.toJPEG(85);
  return `data:image/${isPng ? "png" : "jpeg"};base64,${bytes.toString("base64")}`;
}

/** 上传目录里的文件清单，最近上传的排前面。 */
export function listUploadFiles(dir: string): UploadedFileMeta[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      let size = 0;
      let mtime = 0;
      try {
        const stat = fs.statSync(path.join(dir, entry.name));
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {
        // 文件刚好被删掉：保底还能展示名字。
      }
      return { fileName: entry.name, size, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ fileName, size }) => ({ fileName, size }));
}

/** Agent 的读取工具：PDF / DOCX 抽纯文本，Markdown / 文本文件返回原文。 */
export async function readUploadFile(
  dir: string,
  fileName: string,
): Promise<{ fileName: string; kind: string; text: string }> {
  const safe = sanitizeUploadName(fileName);
  const file = path.join(dir, safe);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`上传目录里没有「${safe}」。可用 upload_list 查看已上传的文件。`);
  }

  const ext = path.extname(safe).toLowerCase();
  // 图片没有可抽取的文本：把二进制按 UTF-8 读出来只会是一串乱码。
  if (isImageUploadName(safe)) {
    const size = fs.statSync(file).size;
    return {
      fileName: safe,
      kind: "image",
      text: `「${safe}」是图片（${Math.max(1, Math.round(size / 1024))} KB），没有可抽取的文字。如果当前模型支持视觉输入，图片会随用户消息一起提供；直接描述你看到的内容即可。`,
    };
  }

  const text = await extractDocumentText(file);
  const kind =
    ext === ".pdf"
      ? "pdf"
      : ext === ".docx"
        ? "docx"
        : ext === ".md" || ext === ".markdown"
          ? "markdown"
          : "text";
  return {
    fileName: safe,
    kind,
    text:
      text.length > READ_TEXT_LIMIT
        ? `${text.slice(0, READ_TEXT_LIMIT)}\n…（内容过长，已截断）`
        : text,
  };
}

/** 实体 id 进路径前的兜底：不合法的段直接抛错，免得拼出目录穿越。 */
function safeSegment(id: string): string {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\")) {
    throw new Error(`不合法的 id：${id}`);
  }
  return id;
}

/**
 * 上传文件名：保留中文/字母/数字/点/连字符/下划线/空格，禁掉路径分隔符、控制字符
 * 和过长的名字；不合法时抛错（上传和工具读取共用同一套规则）。
 */
function sanitizeUploadName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed === "" ||
    trimmed.length > 200 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f]/.test(trimmed)
  ) {
    throw new Error(`不合法的文件名：${name}`);
  }
  return trimmed;
}

/** 同名不覆盖：目录里已有 a.pdf 时，第二次落盘变成 a-2.pdf、第三次 a-3.pdf。 */
function dedupeFileName(dir: string, fileName: string): string {
  if (!fs.existsSync(path.join(dir, fileName))) return fileName;
  const ext = path.extname(fileName);
  const base = ext === "" ? fileName : fileName.slice(0, -ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
}

/** 上传文件 → 抽纯文本。PDF 用 unpdf，DOCX 用 mammoth，其余按 UTF-8 文本读。 */
async function extractDocumentText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(filePath)));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === ".docx") {
    // mammoth 是 CJS：命名导出经 cjs-module-lexer 不一定可见，兜底走 default。
    const module = await import("mammoth");
    const mammoth = module.default ?? module;
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  return fs.readFileSync(filePath, "utf8");
}
