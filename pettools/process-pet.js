'use strict';
/**
 * 桌宠素材流水线
 *
 * 输入：生成模型画了"假透明"（浅灰棋盘格 + 白）的 JPEG
 * 输出：抠掉背景、裁到内容包围盒、底部居中对齐到统一画布的透明 PNG
 *
 * 关键点：角色的白贝雷帽/白外套虽然也是浅色，但被深色描边完全包围，
 * 所以「从四边洪泛填充」的浅色判定碰不到它们，不会误删。
 */

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const FEATHER = 1;       // 边缘羽化半径

const TOL = 42;   // 与背景色的每通道容差

/** 从四边采样，聚类出可能的背景色（可能不止一种，比如棋盘格双色） */
function sampleBackgroundColors(data, w, h) {
  const seen = new Map();
  const B = 4;
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 60) return; // 带明显色彩的先排除
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (!seen.has(key)) seen.set(key, { n: 0, r: 0, g: 0, b: 0 });
    const s = seen.get(key);
    s.n++; s.r += r; s.g += g; s.b += b;
  };
  for (let x = 0; x < w; x++) {
    for (let k = 0; k < B; k++) { add(x, k); add(x, h - 1 - k); }
  }
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < B; k++) { add(k, y); add(w - 1 - k, y); }
  }
  return [...seen.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((s) => [s.r / s.n, s.g / s.n, s.b / s.n]);
}

function nearAny(r, g, b, colors) {
  for (const c of colors) {
    if (Math.abs(r - c[0]) <= TOL && Math.abs(g - c[1]) <= TOL && Math.abs(b - c[2]) <= TOL) {
      return true;
    }
  }
  return false;
}

/** 从四条边洪泛填充背景 */
function floodBackground(data, w, h) {
  const bgColors = sampleBackgroundColors(data, w, h);
  const isBg = new Uint8Array(w * h);
  const stack = [];

  const push = (x, y) => {
    const i = y * w + x;
    if (isBg[i]) return;
    const o = i * 4;
    if (!nearAny(data[o], data[o + 1], data[o + 2], bgColors)) return;
    isBg[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return isBg;
}

/** 由背景掩膜生成 alpha，并做轻微羽化消 JPEG 锯齿边 */
function buildAlpha(data, isBg, w, h) {
  const a = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = isBg[i] ? 0 : 255;

  if (FEATHER > 0) {
    const soft = new Uint8Array(a);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (a[i] !== 0) continue;
        // 紧邻主体的背景像素给一点半透明，压掉白边
        let near = 0;
        if (a[i - 1]) near++;
        if (a[i + 1]) near++;
        if (a[i - w]) near++;
        if (a[i + w]) near++;
        if (near) soft[i] = 70;
      }
    }
    a.set(soft);
  }
  return a;
}

function bbox(alpha, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 处理单张：抠背景 -> 返回 { rgba, alpha, bbox }
 * 扩展名不可信，按魔数自动识别 JPEG / PNG。
 */
function decodeAny(file) {
  const buf = fs.readFileSync(file);
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (isJpeg) {
    return jpeg.decode(buf, { useTArray: true });
  }
  if (isPng) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Uint8Array.from(png.data) };
  }
  throw new Error(`无法识别的图片格式: ${file}`);
}

function processFile(inputPath) {
  const raw = decodeAny(inputPath);
  const { width: w, height: h, data } = raw;
  // 预乘 alpha 的 PNG 需要把透明像素的颜色也纳入背景判定，否则黑边会被误留
  const isBg = floodBackground(data, w, h);
  const alpha = buildAlpha(data, isBg, w, h);
  const box = bbox(alpha, w, h);
  return { w, h, data, alpha, box, src: raw, inputPath };
}

/** 双线性采样。src 为 RGBA 字节数组，(sw, sh) 为源尺寸。 */
function sampleBilinear(src, sw, sh, sx, sy) {
  const x0 = Math.max(0, Math.min(sw - 1, sx | 0));
  const y0 = Math.max(0, Math.min(sh - 1, sy | 0));
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
  const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
    const b = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return out;
}

/** 单通道（掩膜）双线性采样 */
function sampleMask(mask, sw, sh, sx, sy) {
  const x0 = Math.max(0, Math.min(sw - 1, sx | 0));
  const y0 = Math.max(0, Math.min(sh - 1, sy | 0));
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const a = mask[y0 * sw + x0] * (1 - fx) + mask[y0 * sw + x1] * fx;
  const b = mask[y1 * sw + x0] * (1 - fx) + mask[y1 * sw + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * 多图统一处理：
 *  - 共用同一个缩放比例（按最大包围盒高度定）
 *  - 脚底对齐到同一条基线，水平居中
 *  - 输出尺寸完全一致，这样桌宠切表情时不会跳动、不会忽大忽小
 */
function composeAll(items, targetH, pad) {
  const boxes = items.map((it) => it.box);
  const sizes = boxes.map((b) => ({ w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 }));

  const maxH = Math.max(...sizes.map((s) => s.h));
  const scale = targetH / maxH;

  const dw = sizes.map((s) => Math.round(s.w * scale));
  const dh = sizes.map((s) => Math.round(s.h * scale));
  const canvasW = Math.max(...dw) + pad * 2;
  const canvasH = Math.max(...dh) + pad * 2;

  return items.map((it, k) => {
    const png = new PNG({ width: canvasW, height: canvasH });
    png.data.fill(0);
    const b = boxes[k];
    // 目标坐标里的左上角：水平居中 + 脚底对齐到同一条基线
    const ox = Math.round((canvasW - dw[k]) / 2);
    const oy = canvasH - pad - dh[k];

    for (let y = 0; y < dh[k]; y++) {
      const sy = b.minY + (y + 0.5) / scale - 0.5;
      const ty = oy + y;
      if (ty < 0 || ty >= canvasH) continue;
      for (let x = 0; x < dw[k]; x++) {
        const sx = b.minX + (x + 0.5) / scale - 0.5;
        const a = sampleMask(it.alpha, it.w, it.h, sx, sy);
        if (a < 8) continue;
        const tx = ox + x;
        if (tx < 0 || tx >= canvasW) continue;
        // 颜色直接取源图 RGB（半透明羽化环里是背景色，但 alpha 只有 70，肉眼无感）
        const p = sampleBilinear(it.data, it.w, it.h, sx, sy);
        const ti = ty * canvasW + tx;
        png.data[ti * 4] = p[0];
        png.data[ti * 4 + 1] = p[1];
        png.data[ti * 4 + 2] = p[2];
        png.data[ti * 4 + 3] = a;
      }
    }
    return png;
  });
}

module.exports = { processFile, composeAll };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('用法: node process-pet.js <输出目录> <in1.jpg> [in2.jpg ...]');
    process.exit(1);
  }
  const outDir = argv[0];
  const names = argv.slice(1);
  const ins = names.map((p) => processFile(p));

  ins.forEach((it, i) => {
    const b = it.box;
    console.log(`${names[i]}  ${it.w}x${it.h}  bbox=${b.minX},${b.minY}-${b.maxX},${b.maxY}`);
  });

  const TARGET_H = Number(process.env.PET_H || 560);
  const PAD = Number(process.env.PET_PAD || 12);
  fs.mkdirSync(outDir, { recursive: true });
  const pngs = composeAll(ins, TARGET_H, PAD);
  pngs.forEach((png, i) => {
    const base = path.basename(names[i]).replace(/\.[^.]+$/, '');
    const out = path.join(outDir, base + '.png');
    fs.writeFileSync(out, PNG.sync.write(png));
    console.log(`  -> ${out}  ${png.width}x${png.height}`);
  });
}

