/**
 * 测试图案：专门挑"能暴露分区调光差异"的画面
 *
 * 选图原则 —— 要能一眼看出 Mini-LED 的好坏：
 *   1. 黑底 + 小面积高光 → 最能体现暗场压得下去，也最容易看出光晕
 *   2. 高对比交界 → 光晕最明显的地方
 *   3. 星空 → 检验小高光会不会被平均掉（mean 算法的死穴）
 *   4. 灰阶渐变 → 检验分区边界会不会出现"格子感"
 *   5. 彩色高饱和 → 看颜色会不会被背光带偏
 */
export const PATTERNS = [
  { id: 'starfield', name: '星空（黑底小高光）', desc: '最能体现暗场优势，也最容易暴露光晕' },
  { id: 'brightspot', name: '黑底单个亮斑', desc: '看光晕范围的最直接测试' },
  { id: 'split', name: '明暗对半', desc: '分区边界的"格子感"会在这里露馅' },
  { id: 'gradient', name: '灰阶渐变', desc: '检验分区调光会不会破坏平滑渐变' },
  { id: 'colorful', name: '彩色高饱和', desc: '看背光补偿会不会让颜色偏掉' },
  { id: 'text', name: '白字黑底', desc: '字幕场景：字边缘的光晕最刺眼' },
  { id: 'window', name: '夜景窗户', desc: '真实场景：暗房间里的亮窗' },
];

/**
 * 生成图案
 * @returns {Float32Array} 逐像素 RGB（0..1），长度 w*h*3
 */
export function makePattern(id, w, h) {
  const buf = new Float32Array(w * h * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  };

  switch (id) {
    case 'starfield': {
      // 纯黑背景 + 随机星点（大小不一，有几颗亮星）
      buf.fill(0);
      let seed = 20250913;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i < Math.round(w * h * 0.004); i++) {
        const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
        const v = 0.25 + rnd() * 0.75;
        set(x, y, v, v, v);
      }
      // 几颗亮星 + 十字光芒
      for (const [cx, cy, s] of [[w * 0.2, h * 0.3, 1], [w * 0.72, h * 0.62, 1.4], [w * 0.48, h * 0.18, 0.8]]) {
        const ix = Math.round(cx), iy = Math.round(cy);
        set(ix, iy, 1, 1, 1);
        for (let d = 1; d <= Math.round(3 * s); d++) {
          const v = 0.85 / d;
          set(ix + d, iy, v, v, v); set(ix - d, iy, v, v, v);
          set(ix, iy + d, v, v, v); set(ix, iy - d, v, v, v);
        }
      }
      break;
    }

    case 'brightspot': {
      buf.fill(0);
      const cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.09;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= rad) set(x, y, 1, 1, 1);
          else if (d <= rad * 2.2) {
            const v = Math.max(0, 1 - (d - rad) / (rad * 1.2)) * 0.5;
            set(x, y, v, v, v);
          }
        }
      }
      break;
    }

    case 'split': {
      // 左半白、右半黑 —— 分区边界最容易看出来的地方
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = x < w / 2 ? 1 : 0;
          set(x, y, v, v, v);
        }
      }
      break;
    }

    case 'gradient': {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = x / (w - 1);
          set(x, y, v, v, v);
        }
      }
      break;
    }

    case 'colorful': {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const hh = x / w;
          const [r, g, b] = hsv(hh, 0.95, 1);
          set(x, y, r, g, b);
        }
      }
      // 中间放一条黑带，看彩色旁边压暗的效果
      for (let y = Math.round(h * 0.42); y < Math.round(h * 0.58); y++) {
        for (let x = 0; x < w; x++) set(x, y, 0, 0, 0);
      }
      break;
    }

    case 'text': {
      buf.fill(0);
      // 用 5×7 点阵字画一行字（不引外部字体）
      const F = {
        M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], I: [0x00, 0x41, 0x7f, 0x41, 0x00],
        N: [0x7f, 0x04, 0x08, 0x10, 0x7f], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
        E: [0x7f, 0x49, 0x49, 0x49, 0x41], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
      };
      const word = 'MINILED';
      const scale = Math.max(2, Math.floor(h / 24));
      const textW = word.length * 6 * scale;
      let cx = Math.floor((w - textW) / 2);
      const cy = Math.floor((h - 7 * scale) / 2);
      for (const ch of word) {
        const g = F[ch];
        for (let c = 0; c < 5; c++) {
          for (let r = 0; r < 7; r++) {
            if (!(g[c] & (1 << r))) continue;
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) set(cx + c * scale + sx, cy + r * scale + sy, 1, 1, 1);
            }
          }
        }
        cx += 6 * scale;
      }
      break;
    }

    case 'window': {
      // 暗房间 + 一扇亮窗（带窗格），最贴近真实使用场景
      const room = 0.03;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, room, room * 1.05, room * 1.2);
      const wx0 = Math.round(w * 0.3), wx1 = Math.round(w * 0.7);
      const wy0 = Math.round(h * 0.18), wy1 = Math.round(h * 0.78);
      for (let y = wy0; y < wy1; y++) {
        for (let x = wx0; x < wx1; x++) {
          // 窗外是渐变的暖色天空
          const t = (y - wy0) / (wy1 - wy0);
          set(x, y, 1.0, 0.82 - t * 0.35, 0.55 - t * 0.3);
        }
      }
      // 窗框
      const mull = Math.max(1, Math.round(w * 0.008));
      for (let y = wy0; y < wy1; y++) {
        for (let d = 0; d < mull; d++) {
          set(Math.round((wx0 + wx1) / 2) + d, y, 0.02, 0.02, 0.02);
        }
      }
      for (let x = wx0; x < wx1; x++) {
        for (let d = 0; d < mull; d++) {
          set(x, Math.round((wy0 + wy1) / 2) + d, 0.02, 0.02, 0.02);
        }
      }
      break;
    }

    default:
      throw new Error('未知图案 ' + id);
  }
  return buf;
}

function hsv(hh, s, v) {
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
