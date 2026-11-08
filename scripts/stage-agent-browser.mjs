#!/usr/bin/env node
//
// 打包前的 agent-browser 二进制 staging（docs/BROWSER-AGENT.md §4）：
// 把 node_modules 里**当前平台**的原生二进制拷到 resources/agent-browser/，
// 供 electron-builder 的 extraResources 带进安装包 —— 只带一个平台（≈9–16MB），
// 不把整包 7 个平台（≈72MB）塞进 asar。
//
//   node scripts/stage-agent-browser.mjs        # 拷贝 + 校验 --version
//
// dist:mac / dist:dir 之前跑一次即可（electron-builder.yml 已配置 extraResources
// 指向 resources/agent-browser；运行时 main 进程从 process.resourcesPath 找它）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 与 main/agent/agent-browser.ts 和 npm 包 postinstall 的 platformKey 规则一致。 */
function binaryName(platform = process.platform, arch = process.arch) {
  const ext = platform === "win32" ? ".exe" : "";
  let isMusl = false;
  if (platform === "linux") {
    try {
      isMusl = fs.readFileSync("/proc/self/maps", "utf8").includes("/ld-musl-");
    } catch {
      isMusl = fs.existsSync("/lib/ld-musl-x86_64.so.1") || fs.existsSync("/lib/ld-musl-aarch64.so.1");
    }
  }
  const osKey = isMusl ? "linux-musl" : platform;
  const effectiveArch = platform === "win32" && arch === "arm64" ? "x64" : arch;
  return `agent-browser-${osKey}-${effectiveArch}${ext}`;
}

/** `--arch arm64` / `--arch x64,arm64`：CI 在一台机器上为两个架构打包时用。 */
function requestedArches() {
  const index = process.argv.indexOf("--arch");
  if (index < 0) return [process.arch];
  const value = process.argv[index + 1] ?? "";
  return value
    .split(",")
    .map((arch) => arch.trim())
    .filter((arch) => arch !== "");
}

const stagedDir = path.join(root, "resources", "agent-browser");
fs.mkdirSync(stagedDir, { recursive: true });

for (const arch of requestedArches()) {
  const name = binaryName(process.platform, arch);
  const source = path.join(root, "node_modules", "agent-browser", "bin", name);
  const staged = path.join(stagedDir, name);

  if (!fs.existsSync(source)) {
    console.error(`[stage-agent-browser] 找不到 ${name}：${source}`);
    console.error("先 pnpm install（agent-browser 是 devDependency，锁精确版本）。");
    process.exit(1);
  }

  fs.copyFileSync(source, staged);
  if (process.platform !== "win32") fs.chmodSync(staged, 0o755);

  // 只有本机架构能直接执行；跨架构打包时只拷贝，安装后冒烟以目标机为准。
  const version =
    arch === process.arch
      ? execFileSync(staged, ["--version"], { encoding: "utf8" }).trim()
      : "（跨架构，跳过运行校验）";

  console.log(`[stage-agent-browser] ${name}`);
  console.log(`  ${source}`);
  console.log(`  → ${staged}`);
  console.log(`  ${version}`);
}
