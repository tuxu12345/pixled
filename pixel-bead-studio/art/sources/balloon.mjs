/**
 * 热气球 —— 46×56（大尺寸）
 *
 * 几何型题材：一个球体 + 条纹 + 吊篮 + 绳索。
 * 条纹是在圆内按列填色实现（每列只有落在圆内才画），这样条纹边界天然跟着球面走。
 */
export default function ({ cr }) {
  const SKY = '#A8E4F0';
  const RED = '#E8352B';
  const ORANGE = '#FFA300';
  const YELLOW = '#FFD400';
  const BLUE = '#2AA8E0';
  const EDGE = '#3E2A20';
  const BASKET = '#C98B4B';
  const BASKET_D = '#8B5A2B';
  const ROPE = '#6B4A2F';
  const CLOUD = '#FFFFFF';

  const cx = 23, cy = 22, R = 19;
  const stripeCols = 8;
  const stripeColors = [RED, ORANGE, YELLOW, ORANGE, BLUE, ORANGE, YELLOW, RED];

  /* ================= 云（背景点缀，用白圆拼） ================= */
  cr.circle(7, 47, 5.5, { fill: CLOUD });
  cr.circle(13, 49, 4.5, { fill: CLOUD });
  cr.circle(38, 50, 5.0, { fill: CLOUD });
  cr.circle(43, 48, 4.0, { fill: CLOUD });

  /* ================= 球体：按列填条纹 ================= */
  for (let x = 0; x < 46; x++) {
    const dx = x + 0.5 - cx;
    const half = Math.sqrt(Math.max(0, R * R - dx * dx));
    if (half < 0.5) continue;
    // 这一列属于哪条条纹
    const si = Math.min(stripeCols - 1, Math.floor((x / 46) * stripeCols));
    cr.rect(x, cy - half, 1, half * 2, { fill: stripeColors[si] });
  }
  // 球体整体描边（用圆环实现：画一个大圆描边）
  cr.circle(cx, cy, R, { stroke: EDGE, strokeWidth: 0.9 });

  /* ================= 球底收口（气球的脖子） ================= */
  cr.poly([[cx - 5, cy + R - 2], [cx + 5, cy + R - 2], [cx + 3, cy + R + 3], [cx - 3, cy + R + 3]],
    { fill: BASKET_D });

  /* ================= 绳索（四根，从球底到吊篮四角） ================= */
  const basketTop = 48, basketBot = 55;
  const bx0 = cx - 7, bx1 = cx + 7;
  for (const [x0, x1] of [[cx - 3, bx0], [cx + 3, bx1], [cx - 2, bx0 + 1], [cx + 2, bx1 - 1]]) {
    cr.line(x0, cy + R + 2, x1, basketTop, { stroke: ROPE, strokeWidth: 0.8 });
  }

  /* ================= 吊篮 ================= */
  cr.poly([[bx0, basketTop], [bx1, basketTop], [bx1 - 1.5, basketBot], [bx0 + 1.5, basketBot]],
    { fill: BASKET });
  cr.rect(bx0 - 0.5, basketTop - 1.5, 15, 2, { fill: BASKET_D });   // 篮口
  cr.poly([[bx1 - 4, basketTop + 1], [bx1 - 1, basketTop + 1], [bx1 - 2.2, basketBot - 0.5], [bx1 - 4.5, basketBot - 0.5]],
    { fill: BASKET_D });   // 篮身暗面
  // 编织纹
  for (const y of [basketTop + 3, basketTop + 5.5]) {
    cr.line(bx0 + 1, y, bx1 - 1, y, { stroke: BASKET_D, strokeWidth: 0.6 });
  }
}
