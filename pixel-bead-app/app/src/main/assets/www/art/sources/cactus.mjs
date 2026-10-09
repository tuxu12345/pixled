/**
 * 仙人掌 —— 50×54（大尺寸）
 *
 * 为什么这个我能做好：仙人掌是"几何形状型"题材（主干 + 两条手臂 + 花盆），
 * 部件少、都接近规则矩形/圆弧，和我验证过的那朵花同类。
 * 动物那种有机形态才是难点。
 *
 * 配色用真实豆色：三档绿色做体积，陶土色做花盆。
 */
export default function ({ cr }) {
  const GREEN = '#4CAF50';    // 主体
  const GREEN_D = '#2E7D5B';  // 暗面（右侧背光）
  const GREEN_L = '#A5D63F';  // 受光面（左侧）
  const SOIL = '#6B4A2F';     // 土
  const POT = '#C98B4B';      // 花盆
  const POT_D = '#8B5A2B';    // 花盆暗面 / 盆口
  const EDGE = '#3E2A20';
  const FLOWER = '#F062A8';   // 顶上小花

  /* ================= 花盆（先画，被主干盖住上缘） ================= */
  const potTop = 44, potBot = 53, potCx = 25;
  cr.poly([[15, potTop], [35, potTop], [32, potBot], [18, potBot]], { fill: POT });
  // 盆口一圈
  cr.rect(14, potTop - 3, 22, 3.5, { fill: POT_D });
  // 盆身暗面
  cr.poly([[30, potTop + 1], [34.5, potTop + 1], [31.8, potBot - 1], [28, potBot - 1]], { fill: POT_D });

  /* ================= 土 ================= */
  cr.rect(16, potTop - 1, 18, 2.5, { fill: SOIL });

  /* ================= 主干 ================= */
  // ★ 主干下缘要停在盆口**上方**（potTop-3 是盆口顶），否则会插进花盆里
  const trunkX = 21, trunkW = 9, trunkTop = 8;
  const trunkBot = potTop - 3;
  cr.rect(trunkX, trunkTop, trunkW, trunkBot - trunkTop, { fill: GREEN, rx: 4 });
  // 左侧受光
  cr.rect(trunkX + 1, trunkTop + 1, 3, trunkBot - trunkTop - 2, { fill: GREEN_L, rx: 1.5 });
  // 右侧暗面
  cr.rect(trunkX + trunkW - 3.5, trunkTop + 1, 2.5, trunkBot - trunkTop - 2, { fill: GREEN_D, rx: 1.2 });

  /* ================= 左手臂（先横后竖，圆头） ================= */
  const armL_y = 24;
  cr.capsule(trunkX + 1, armL_y, trunkX - 8, armL_y, 6.5, { stroke: GREEN });
  cr.capsule(trunkX - 6, armL_y, trunkX - 6, armL_y - 12, 6.5, { stroke: GREEN });
  // 左臂受光/暗面
  cr.capsule(trunkX - 1, armL_y - 1, trunkX - 8, armL_y - 1, 2.2, { stroke: GREEN_L });
  cr.capsule(trunkX - 3.5, armL_y - 2, trunkX - 3.5, armL_y - 12, 2.2, { stroke: GREEN_L });

  /* ================= 右手臂（比左臂短、位置低，避免和主干分家） ================= */
  // ★ 关键：右臂要从主干**内部**长出来（起点 x 用主干右缘 -1），
  //   否则横向胶囊会悬在主干外面，看起来像贴了一块。
  const armR_y = 26;
  const armR_end = trunkX + trunkW + 5;          // 只比主干右缘多出 5 格
  cr.capsule(trunkX + trunkW - 1, armR_y, armR_end, armR_y, 6.0, { stroke: GREEN });
  cr.capsule(armR_end - 1, armR_y, armR_end - 1, armR_y - 8, 6.0, { stroke: GREEN });
  cr.capsule(trunkX + trunkW + 1, armR_y + 1.5, armR_end, armR_y + 1.5, 2.0, { stroke: GREEN_D });
  cr.capsule(armR_end + 0.5, armR_y - 1, armR_end + 0.5, armR_y - 8, 2.0, { stroke: GREEN_D });

  /* ================= 棱线（仙人掌的竖纹） ================= */
  for (const dx of [trunkX + 3.2, trunkX + trunkW - 3.2]) {
    cr.line(dx, trunkTop + 3, dx, trunkBot - 3, { stroke: GREEN_D, strokeWidth: 0.6 });
  }

  /* ================= 刺（短横线，稀疏几根） ================= */
  for (const [sx, sy] of [[trunkX - 0.5, 14], [trunkX + trunkW + 0.5, 18], [trunkX - 0.5, 34],
    [trunkX + trunkW + 0.5, 38], [trunkX - 10, armL_y - 6], [trunkX + trunkW + 10, armR_y - 4]]) {
    cr.line(sx - 1.4, sy, sx + 1.4, sy, { stroke: GREEN_D, strokeWidth: 0.7 });
  }

  /* ================= 顶上的花 ================= */
  cr.circle(trunkX + trunkW / 2, trunkTop - 2.5, 3.4, { fill: FLOWER });
  cr.circle(trunkX + trunkW / 2, trunkTop - 2.5, 1.5, { fill: '#FFF3C4' });
}
