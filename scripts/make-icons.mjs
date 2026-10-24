// 产出应用图标：build/icon.png（1024 主图）+ build/icon.icns（macOS）。
// 用法：node scripts/make-icons.mjs
//
// 图标源文件是 build/icon-drafts/logo.svg；渲染走 scripts/render-svg.mjs
// （Electron 离屏渲染，理由见该文件头注释），缩放与打包用系统自带的
// sips / iconutil，所以只在 macOS 上出 icns。
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const electron = path.join(root, "node_modules/.bin/electron");
const logoSvg = path.join(root, "build/icon-drafts/logo.svg");
const master = path.join(root, "build/icon.png");

execFileSync(electron, [path.join(root, "scripts/render-svg.mjs"), logoSvg, master, "1024"], {
  stdio: "inherit",
});

if (process.platform === "darwin") {
  // iconutil 只认 .iconset 结尾的目录名。
  const tmp = path.join(os.tmpdir(), `goodjob-icons-${process.pid}.iconset`);
  rmSync(tmp, { recursive: true, force: true });
  execFileSync("mkdir", ["-p", tmp]);
  // iconutil 要求 iconset 里的文件名严格对齐这套约定。
  const entries = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of entries) {
    execFileSync("sips", ["-z", String(size), String(size), master, "--out", path.join(tmp, name)], {
      stdio: "ignore",
    });
  }
  execFileSync("iconutil", ["-c", "icns", tmp, "-o", path.join(root, "build/icon.icns")]);
  rmSync(tmp, { recursive: true, force: true });
  console.log("✓ build/icon.icns");
}
