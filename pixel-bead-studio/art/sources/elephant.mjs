/**
 * 大象 —— 大尺寸 48×44，正面头像
 *
 * 失败 6 次后的定稿思路（每条都是踩出来的）：
 *
 * ① 【不要"白色"大象】白色主体在浅色拼豆板上没有对比，为了让它可见我加灰底、
 *    灰描边、灰暗面，结果整体发灰反而更糊。用灰色主体，层次天然成立。
 * ② 【正面头像比侧身像容易成】侧身要同时处理背弧、腹线、四条腿的透视，一个参数错就散架。
 *    正面只有"头 + 两耳 + 鼻子 + 象牙"，对称、部件少。
 * ③ 【内部不要逐个描边】第一版给每个椭圆都加了 stroke，暗灰占了 19%，
 *    五官全被淹掉。**只在整体剪影上加一圈描边**（交给 generate.mjs --outline），
 *    内部靠明暗区分就够了。
 * ④ 【象牙要够大】第一版象牙只占 8 颗豆，等于没有。
 */
export default function ({ cr }) {
  const GREY = '#9B9B9B';    // 主体
  const GREY_D = '#6E6E6E';  // 暗面（耳朵内侧、脸颊）
  const GREY_L = '#C4C4C4';  // 受光面（额头、鼻梁）
  const EYE = '#1A1A1A';
  const IVORY = '#FFF3C4';   // 象牙
  const PINK = '#F062A8';    // 耳内衬（大象耳朵内侧偏粉，也是辨识特征）

  const faceCx = 24, faceCy = 16;

  /* ================= 耳朵（缩小到不贴边；内侧用粉色做区分） ================= */
  for (const side of [-1, 1]) {
    const ex = faceCx + side * 14.0, ey = 19;
    cr.ellipse(ex, ey, 8.2, 11.5, { fill: GREY });
    cr.ellipse(ex + side * -1.0, ey + 0.5, 5.6, 8.2, { fill: PINK });
    cr.ellipse(ex + side * -1.8, ey + 1.2, 3.6, 5.6, { fill: GREY_D });
  }

  /* ================= 头 ================= */
  cr.ellipse(faceCx, faceCy, 11.0, 12.0, { fill: GREY });
  // 额头受光
  cr.ellipse(faceCx, faceCy - 6, 7.0, 4.5, { fill: GREY_L });
  // 脸颊两侧稍暗
  for (const side of [-1, 1]) {
    cr.ellipse(faceCx + side * 8.0, faceCy + 3.5, 3.2, 6.0, { fill: GREY_D });
  }

  /* ================= 眼睛（放大到看不清都难） ================= */
  for (const side of [-1, 1]) {
    const ex = faceCx + side * 5.8, ey = faceCy - 2.0;
    cr.ellipse(ex, ey, 2.8, 3.1, { fill: EYE });
    cr.circle(ex - side * 0.8, ey - 1.1, 1.0, { fill: '#FFFFFF' });
  }

  /* ================= 象牙（大幅放大，是辨识关键） ================= */
  for (const side of [-1, 1]) {
    const bx = faceCx + side * 5.0, by = faceCy + 8.5;
    cr.poly([
      [bx, by],
      [bx + side * 4.0, by + 1.0],
      [bx + side * 6.5, by + 10.0],
      [bx + side * 2.2, by + 7.5],
    ], { fill: IVORY });
  }

  /* ================= 鼻子（由粗到细垂下，末端右卷） ================= */
  const segs = 34;
  const noseTop = faceCy + 9, noseBot = 41;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = noseTop + (noseBot - noseTop) * t;
    const curl = t > 0.68 ? Math.sin(((t - 0.68) / 0.32) * Math.PI * 0.7) * 7.0 : 0;
    pts.push([faceCx + curl, y]);
  }
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    cr.circle(pts[i][0], pts[i][1], 5.0 * (1 - t * 0.56), { fill: GREY });
  }
  // 鼻梁受光 + 背光侧
  for (let i = 0; i < pts.length - 2; i++) {
    const t = i / (pts.length - 1);
    if (t > 0.88) break;
    const r = 5.0 * (1 - t * 0.56);
    cr.circle(pts[i][0] - r * 0.36, pts[i][1], r * 0.32, { fill: GREY_L });
    cr.circle(pts[i][0] + r * 0.44, pts[i][1], r * 0.30, { fill: GREY_D });
  }
  // 鼻端横纹 + 鼻孔
  const tip = pts[segs];
  cr.ellipse(tip[0], tip[1] - 1.6, 2.4, 1.7, { fill: GREY_D });
  cr.circle(tip[0] - 1.1, tip[1] - 1.6, 0.8, { fill: EYE });
  cr.circle(tip[0] + 1.1, tip[1] - 1.6, 0.8, { fill: EYE });
}
