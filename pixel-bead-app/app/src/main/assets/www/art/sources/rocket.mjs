/**
 * 火箭发射 —— 44×58（大尺寸）
 *
 * 几何型题材：箭体（矩形+圆头）、头锥（三角）、尾翼（三角）、舷窗（圆）、尾焰（不规则三角）。
 * 部件都是直线和圆，落色干净。
 */
export default function ({ cr }) {
  const WHITE = '#FFFFFF';
  const BODY = '#F2F2F2';
  const BODY_D = '#9B9B9B';
  const RED = '#E8352B';
  const RED_D = '#B01722';
  const WINDOW = '#2AA8E0';
  const WINDOW_L = '#A8E4F0';
  const EDGE = '#3E2A20';
  const METAL = '#4A4A4A';

  const cx = 22;
  const bodyTop = 16, bodyBot = 46;
  const bodyW = 16;
  const bx0 = cx - bodyW / 2, bx1 = cx + bodyW / 2;

  /* ================= 尾焰（先画，被箭体压住上端） ================= */
  const flameTop = bodyBot - 1;
  cr.poly([
    [cx - 6, flameTop], [cx + 6, flameTop], [cx + 3.5, flameTop + 6],
    [cx + 2, flameTop + 10], [cx, flameTop + 6.5],
    [cx - 2, flameTop + 10], [cx - 3.5, flameTop + 6],
  ], { fill: '#FF6A00' });
  cr.poly([
    [cx - 3.5, flameTop], [cx + 3.5, flameTop], [cx + 1.5, flameTop + 7.5],
    [cx, flameTop + 4.5], [cx - 1.5, flameTop + 7.5],
  ], { fill: '#FFD400' });

  /* ================= 尾翼（左右各一片） ================= */
  for (const side of [-1, 1]) {
    cr.poly([
      [cx + side * (bodyW / 2 - 1), bodyBot - 14],
      [cx + side * (bodyW / 2 + 11), bodyBot + 1],
      [cx + side * (bodyW / 2 - 1), bodyBot + 1],
    ], { fill: RED });
    cr.poly([
      [cx + side * (bodyW / 2 - 1), bodyBot - 14],
      [cx + side * (bodyW / 2 + 11), bodyBot + 1],
      [cx + side * (bodyW / 2 - 1), bodyBot + 1],
    ], { stroke: EDGE, strokeWidth: 0.8 });
  }

  /* ================= 头锥 ================= */
  cr.poly([[cx, 2], [cx + bodyW / 2, bodyTop + 1], [cx - bodyW / 2, bodyTop + 1]], { fill: RED });
  cr.poly([[cx, 2], [cx + bodyW / 2, bodyTop + 1], [cx - bodyW / 2, bodyTop + 1]], { stroke: EDGE, strokeWidth: 0.8 });
  // 头锥受光侧
  cr.poly([[cx, 4], [cx - bodyW / 2 + 1.5, bodyTop], [cx - 1, bodyTop]], { fill: '#FF6A00' });

  /* ================= 箭体 ================= */
  cr.rect(bx0, bodyTop, bodyW, bodyBot - bodyTop, { fill: BODY });
  cr.rect(bx0, bodyTop, bodyW, bodyBot - bodyTop, { stroke: EDGE, strokeWidth: 0.9 });
  // 左侧受光
  cr.rect(bx0 + 1.2, bodyTop + 1, 3.5, bodyBot - bodyTop - 2, { fill: WHITE });
  // 右侧暗面
  cr.rect(bx1 - 4.2, bodyTop + 1, 3, bodyBot - bodyTop - 2, { fill: BODY_D });
  // 红色环带
  cr.rect(bx0, bodyTop + 5, bodyW, 3.5, { fill: RED });
  cr.rect(bx0, bodyBot - 8, bodyW, 3, { fill: RED_D });

  /* ================= 舷窗 ================= */
  const wy = bodyTop + 16;
  cr.circle(cx, wy, 5.2, { fill: METAL });
  cr.circle(cx, wy, 4.0, { fill: WINDOW });
  cr.circle(cx - 1.3, wy - 1.3, 1.5, { fill: WINDOW_L });

  /* ================= 铆钉（细节，用深色小方块） ================= */
  for (const y of [bodyTop + 2.5, bodyBot - 2.5]) {
    for (const x of [bx0 + 2.5, bx1 - 2.5]) {
      cr.rect(x, y, 1.2, 1.2, { fill: METAL });
    }
  }

  /* ================= 喷射烟雾（两侧小云） ================= */
  cr.circle(cx - 15, bodyBot + 4, 4.2, { fill: '#C4C4C4' });
  cr.circle(cx + 15, bodyBot + 5, 3.6, { fill: '#C4C4C4' });
  cr.circle(cx - 18, bodyBot + 8, 3.0, { fill: BODY_D });
  cr.circle(cx + 18, bodyBot + 9, 2.6, { fill: BODY_D });
}
