// 在 Electron(Chromium) 里把 SVG 渲染成指定尺寸的 PNG（保留透明通道）。
// 用法：electron scripts/render-svg.mjs <input.svg> <output.png> <size> [content]
//
// 可选的 content 是内容边长：SVG 先画成 content×content，再居中放进 size×size
// 的透明画布（size 缺省等于 content，即全出血）。macOS 图标要靠这一步留边——
// 系统不做遮罩也不缩放，画稿铺满画布 Dock 里就会比别的图标大一圈。
//
// 为什么不用 rsvg/sips：logo.svg 用了 feGaussianBlur 滤镜和 mask，Chromium 是
// 与应用内渲染唯一一致的解释器。roundRect 之外的角必须是 alpha=0（macOS 不做遮罩），
// 渲染完会自检第一个像素，透明度不对就换非 offscreen 模式重试。
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";

const [, , inArg, outArg, sizeArg, contentArg] = process.argv;
if (!inArg || !outArg) {
  console.error("用法：electron scripts/render-svg.mjs <input.svg> <output.png> <size> [content]");
  process.exit(1);
}
const size = Number(sizeArg) || 1024;
const content = Math.min(Number(contentArg) || size, size);

// 解析 PNG 第 0 行首像素的 alpha。只处理 Chromium 会产出的 8bit RGBA 非隔行格式。
function cornerAlpha(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return -1;
  let off = 8;
  let width = 0;
  let depth = 0;
  let color = 0;
  const idats = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const start = off + 8;
    if (type === "IHDR") {
      width = png.readUInt32BE(start);
      depth = png[start + 8];
      color = png[start + 9];
    } else if (type === "IDAT") {
      idats.push(png.subarray(start, start + len));
    } else if (type === "IEND") {
      break;
    }
    off = start + len + 4;
  }
  if (depth !== 8 || color !== 6) return -1;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const filter = raw[0];
  const row = raw.subarray(1, 1 + stride);
  // 第 0 行没有上一行，各 filter 退化：1/4 等价于加上左邻，3 是左邻一半，2 不变。
  const out = Buffer.alloc(stride);
  for (let i = 0; i < stride; i++) {
    const left = i >= 4 ? out[i - 4] : 0;
    let x = row[i];
    if (filter === 1 || filter === 4) x += left;
    else if (filter === 3) x += left >> 1;
    out[i] = x & 0xff;
  }
  return out[3];
}

async function capture(offscreen) {
  const tmpDir = path.join(os.tmpdir(), "goodjob-icon-render");
  mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, "render.html");
  const margin = (size - content) / 2;
  // file:// 页面才能引 file:// 图片；body 透明，圆角外保持 alpha=0。
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
      `</style></head><body><img src="${encodeURI("file://" + path.resolve(inArg))}" ` +
      `width="${content}" height="${content}" style="display:block;margin:${margin}px"></body></html>`,
  );
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen, backgroundThrottling: false },
  });
  await win.loadFile(htmlPath);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

app.whenReady().then(async () => {
  let image = null;
  let alpha = -1;
  for (const offscreen of [true, false]) {
    image = await capture(offscreen);
    alpha = cornerAlpha(image.toPNG());
    if (alpha === 0) break;
    console.error(`offscreen=${offscreen}：角落 alpha=${alpha}，换个模式重试`);
  }
  if (alpha !== 0) {
    console.error(`透明自检未通过（alpha=${alpha}），结果可能带黑角，中止`);
    app.quit();
    process.exitCode = 1;
    return;
  }
  const { width: w, height: h } = image.getSize();
  if (w !== size || h !== size) {
    console.error(`渲染尺寸 ${w}x${h} ≠ ${size}x${size}，中止`);
    process.exitCode = 1;
  } else {
    writeFileSync(outArg, image.toPNG());
    console.log(`✓ ${outArg}（${w}x${h}）`);
  }
  app.quit();
});
