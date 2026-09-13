/**
 * 渲染层：把算法的结果画出来
 *
 * 三个视图：
 *   final      最终成像（原图 × 背光补偿后）
 *   backlight  背光场（灰度）—— 分区调光的"幕后"，最值得看的一张
 *   zoneGrid   分区亮度网格（每格标出亮度值）
 *
 * 画布一律按 MAX_W 渲染再靠 CSS 放大：算法在低分辨率跑（快），
 * 观感靠硬件双线性放大（这跟真实面板的物理扩散其实是一回事，反而更真）。
 */

const MAX_W = 360;   // 内部计算宽度上限

export function computeLayout(srcW, srcH, maxW = MAX_W) {
  const scale = Math.min(1, maxW / srcW);
  return { w: Math.max(8, Math.round(srcW * scale)), h: Math.max(8, Math.round(srcH * scale)) };
}

/** 把 Float32Array 的 RGB 画到 canvas（最近邻，保持像素感） */
export function paintRGB(canvas, rgb, w, h) {
  const ctx = canvas.getContext('2d');
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = clamp255(rgb[i * 3] * 255);
    d[i * 4 + 1] = clamp255(rgb[i * 3 + 1] * 255);
    d[i * 4 + 2] = clamp255(rgb[i * 3 + 2] * 255);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 灰度场 → canvas（热力图，用于看背光分布） */
export function paintField(canvas, field, w, h, { heat = false } = {}) {
  const ctx = canvas.getContext('2d');
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = Math.min(1, Math.max(0, field[i]));
    let r, g, b;
    if (heat) {
      // 黑 → 蓝 → 青 → 黄 → 白（看清暗部的细微差别）
      const t = v;
      r = clamp255(Math.max(0, Math.min(1, (t - 0.55) * 2.2)) * 255);
      g = clamp255(Math.max(0, Math.min(1, (t - 0.2) * 1.6)) * 255);
      b = clamp255(Math.max(0, Math.min(1, t * 2.4)) * 255);
    } else {
      r = g = b = clamp255(v * 255);
    }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 在成像画布上叠分区网格（标出每个分区的亮度） */
export function paintZoneOverlay(canvas, zones, zoneCols, zoneRows, w, h, { showValues = true, threshold = 0.75 } = {}) {
  const ctx = canvas.getContext('2d');
  const zx = w / zoneCols, zy = h / zoneRows;

  ctx.save();
  ctx.lineWidth = 1;

  for (let zr = 0; zr < zoneRows; zr++) {
    for (let zc = 0; zc < zoneCols; zc++) {
      const v = zones[zr * zoneCols + zc];
      const x = zc * zx, y = zr * zy;

      // 网格线：越亮的分区线越明显（方便看"哪块背光被点亮了"）
      ctx.strokeStyle = `rgba(255,120,0,${0.18 + v * 0.5})`;
      ctx.strokeRect(x + 0.5, y + 0.5, zx - 1, zy - 1);

      // 数字：只标够亮的分区，不然满屏字看不见
      if (showValues && v >= threshold && zx > 16) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x + 1, y + 1, 17, 9);
        ctx.fillStyle = '#ffcc66';
        ctx.font = '8px ui-monospace, monospace';
        ctx.fillText(v.toFixed(2), x + 2, y + 9);
      }
    }
  }
  ctx.restore();
}

/** 在画布上画一个"背光分区"的独立性示意：每个分区被点亮成它的亮度 */
export function paintZoneCells(canvas, zones, zoneCols, zoneRows, { cellPx = 12 } = {}) {
  const w = zoneCols * cellPx, h = zoneRows * cellPx;
  const ctx = canvas.getContext('2d');
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  for (let zr = 0; zr < zoneRows; zr++) {
    for (let zc = 0; zc < zoneCols; zc++) {
      const v = zones[zr * zoneCols + zc];
      const g = Math.round(v * 255);
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(zc * cellPx, zr * cellPx, cellPx - 1, cellPx - 1);
    }
  }
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * 统计"光晕量"：
 * 对每个原本应该是黑的像素（原图亮度≈0），看最终成像被背光抬亮了多少。
 * 这个数字直接对应肉眼看到的 blooming 程度。
 *
 * 注意：要用"亮块周围全是暗"的画面测才有意义 —— 如果暗区离亮区很远，
 * 扩散根本传不过去，测出来永远是 0（我在测试里踩过这个坑）。
 */
export function measureBlooming(src, rgb, w, h, darkThreshold = 0.04) {
  let darkCount = 0, liftSum = 0, maxLift = 0;
  for (let i = 0; i < w * h; i++) {
    const srcL = 0.2126 * src[i * 3] + 0.7152 * src[i * 3 + 1] + 0.0722 * src[i * 3 + 2];
    if (srcL > darkThreshold) continue;
    const outL = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
    darkCount++;
    liftSum += outL;
    if (outL > maxLift) maxLift = outL;
  }
  return {
    darkPixels: darkCount,
    avgLift: darkCount ? liftSum / darkCount : 0,
    maxLift,
  };
}

/**
 * 统计"格子感"（grid artifact）—— 分区边界被看出来的程度。
 *
 * 这是分区调光最容易被忽略的副作用：每个分区是一个亮度台阶，
 * 在纯色渐变画面上，分区边界会露出方格子。
 * 分区越多 → 格子越小越不明显；扩散越大 → 边界越柔和。
 *
 * 指标用**边界上的绝对梯度均值**（不是"边界/内部"的比值 ——
 * 因为模糊会同时降低两者，比值反而不变，我一开始就是被这个坑到了）。
 *
 * @returns {{edgeGrad: number, interiorGrad: number, maxGrad: number}}
 */
export function measureGridArtifact(backlight, w, h, zoneCols, zoneRows) {
  let edgeSum = 0, edgeCount = 0, interiorSum = 0, interiorCount = 0, maxGrad = 0;

  // 分区边界像素（相对容差，避免宽高比差异导致漏判）
  const bw = w / zoneCols, bh = h / zoneRows;
  const isBoundary = (x, y) => {
    const fx = (x % bw) / bw;          // 0..1 表示在分区内的横向位置
    const fy = (y % bh) / bh;
    return fx < 0.12 || fx > 0.88 || fy < 0.12 || fy > 0.88;
  };

  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const g = Math.abs(backlight[y * w + x] - backlight[y * w + x + 1])
        + Math.abs(backlight[y * w + x] - backlight[(y + 1) * w + x]);
      if (g > maxGrad) maxGrad = g;
      if (isBoundary(x, y)) { edgeSum += g; edgeCount++; }
      else { interiorSum += g; interiorCount++; }
    }
  }
  return {
    edgeGrad: edgeCount ? edgeSum / edgeCount : 0,
    interiorGrad: interiorCount ? interiorSum / interiorCount : 0,
    maxGrad,
  };
}

/**
 * 估算背光功耗（相对值）。
 * LED 背光功耗 ≈ 各分区亮度的平均（PWM 调光下近似线性）。
 * 这是 Mini-LED 除了对比度之外的第二个卖点：省电。
 */
export function estimatePower(backlight) {
  let sum = 0;
  for (let i = 0; i < backlight.length; i++) sum += backlight[i];
  return backlight.length ? sum / backlight.length : 0;
}
