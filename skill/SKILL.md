---
name: pixel-bead-pattern
description: Generate perler bead / pixel-art patterns (拼豆图案) and convert them into bead grids for real crafting or LED matrix display. Use when asked to 生成拼豆图案, 画像素画, 做图案库, turn a photo or AI image into a beaded pattern, or produce a pixel grid to drive an LED matrix panel. Covers three generation paths (hand-drawn character art, geometric code drawing, photo tracing), bead-color snapping to real purchasable palettes, and PNG/JSON export.
---

# 拼豆图案生成

点阵 LED 和拼豆是同一件事的两面：**离散格子 + 有限色板**。这里的产物两边都能用。

## 做完就装进图案库（默认动作，不要再问）

**每次生成出满意的图案，直接 `install` 进 `pixel-bead-studio` 的图案库，不用征求同意。**
这是这个 skill 的常规收尾步骤。

```bash
node $S/generate.mjs install out.json \
  --id pigs --name "三只小猪" --tags "标准豆,6色,约2小时,故事" --hot
```
- 幂等：同 id 会**替换**而不是重复追加
- 写入后自动 `node --check` 语法自检，**失败会回滚**，不会污染图案库
- `--name` 一定要给中文名 —— 不然图案库标签页会显示成 `three-little-pigs-cutout` 这种机器名

## 最重要的一条：必须看图

**生成 → 渲染 → 看 → 改，这个闭环不能省。**

盲写几何代码改八版都不对，渲染出来看一眼就发现问题 —— 这是这个 skill 存在的全部理由。
所以每次生成**都要带 `--preview`**，然后用图片查看能力打开 PNG 检查。

```bash
S=~/.dsh/skills/pixel-bead-pattern/scripts
node $S/generate.mjs code art.mjs --cols 48 --rows 48 \
  --out out.json --preview out.png    # ← preview 别省
```

看预览时检查这几件事：
- 主体是不是**一眼认得出**？（认不出就重画，别靠调色救）
- 轮廓有没有糊成一团？占比是不是太小（<40% 就该放大）？
- 颜色数超了吗（拼豆超过 12 色就不好拼了）？
- 透明格对不对（背景该透的透了没）？

## 标准流程

```
1. 选路径（下表）→ 写 spec.mjs / art.mjs
2. 生成 + 渲染   --out x.json --preview x.png
3. 打开预览 PNG 看 → 有问题回第 1 步改
4. 满意了 → install 进图案库（默认动作，不用问）
```

复杂形象**先在单张小画布上验证 sprite**（比如只画一个头，20×16），确认"一眼认得出"再组装场景。
跳过这步就会像我一样：直接拼三只猪，连改 7 版都是糊的。

## 三条路径怎么选

| 路径 | 命令 | 什么时候用 |
|---|---|---|
| **A 手绘字符画** | `art <spec.mjs>` | 形象简单明确、需要逐格精确控制（棋子、表情、图标、字母） |
| **B 几何代码** | `code <art.mjs>` | **结构复杂**：有细长线条、曲线、透视、重复元素（车、机器、logo、花、建筑） |
| **C 照片/图片** | `image <photo>` | 有现成图片/AI 生成图要转；**只适合出草稿，几乎一定要人工再修** |

经验：**B 出图质量上限最高**，因为几何是程序化画的，边缘干净、左右天然对称。
A 最适合小尺寸和精确控制。C 最快但最糙 —— 20×20 只有 400 格，照片细节必然丢。

---

## 路径 B：几何代码绘图（推荐主力）

写一个 `.mjs`，默认导出函数，参数里用 `cr`（已建好的画布）：

```js
export default function ({ cr, hsl, shade, mix }) {
  // 逻辑坐标就是格子坐标：0..cols，原点左上
  cr.circle(24, 24, 10, { fill: '#FFD400' });          // 圆（圆心 + 半径）
  cr.ellipse(12, 18, 6, 4, { fill: '#4CAF50' });        // 椭圆
  cr.rect(4, 4, 10, 8, { fill: '#3A6FD8', rx: 2 });     // 矩形（rx = 圆角）
  cr.poly([[4,4],[20,6],[18,20]], { fill: '#E8352B' }); // 多边形（自动闭合）
  cr.path([[4,4],[10,10],[20,8]], { stroke:'#1A1A1A', strokeWidth:1 }); // 折线
  cr.line(2, 30, 46, 30, { stroke: '#9B9B9B', strokeWidth: 0.8 });
  cr.capsule(20, 20, 20, 34, 1.6, { stroke: '#2E7D5B' }); // 粗线段（带圆头）
  cr.arc(24, 24, 12, 12, 0, 180, { stroke:'#1A1A1A', strokeWidth:1 }); // 圆弧，角度制
}
```

**形状后面画的盖前面画的** —— 所以顺序是「先大轮廓，再五官细节」。

坐标系：原点左上、y 向下、单位是格子。
`{ fill, stroke, strokeWidth, rx }`，颜色支持 `#RGB` `#RRGGBB` `#RRGGBBAA` `rgb()` `rgba()` 和常用色名。

**格子对齐**（要"一格一只眼睛"这种精确控制时用）：
```js
cr.cellCircle(gx, gy, n, style)   // 占 n 格直径的圆，左上角在 (gx,gy)
cr.cellRect(gx, gy, gw, gh, style) // 占 gw×gh 格的方块
```

内置颜色工具：`hsl(h,s,l)` / `mix(a,b,t)` / `shade(hex,k)`。

```bash
node $S/generate.mjs code art.mjs --cols 48 --rows 48 --out out.json --preview out.png --outline
```
- `--outline` 自动给主体加深色描边（拼豆作品的关键视觉）
- `--scale 8` 内部超采样倍数，越大边缘越干净（慢一点）
- `--maxColors 8` 限制颜色数

⚠️ **别把参数里的 `mc` 解构命名成 `canvas`** —— 会和画布工厂撞名。

---

## 路径 A：手绘字符画

一格一个字符，能直接"看见"画：

```js
export default {
  name: 'shiba',
  palette: ['#3E2A20', '#E8A03C', '#FFF3C4', '#E8352B'],  // 最多 36 色
  art: [
    '..000..........000..',
    '.01110........01110.',
    '.011111000000111110.',
    '.011311111111131110.',
    '.011111122211111110.',
  ],
};
```
- 字符 = 调色板下标：`0-9` 然后 `a-z`（共 36）
- `.` 或空格 = 不放豆（透明）
- **每一行必须一样长**（用 `.` 补齐）—— 编译器会拦住不一致的行，这是最常见的错误

```bash
node $S/generate.mjs art spec.mjs --out out.json --preview out.png
```

画歪了想改？用 `decompileArt` 把已有图案导回字符画再手工调。

---

## 路径 C：照片 / 图片转图案

```bash
node $S/generate.mjs image photo.jpg --cols 29 --out out.json --preview out.png
node $S/generate.mjs image logo.png --cols 32 --cols 32 --keyColor '#FFFFFF' --maxColors 6
```
- `--fit cover|contain|stretch`，`--brightness/--contrast/--saturation`
- `--threshold 0.5` 二值化（做单色图案）
- `--keyColor '#FFFFFF' --keyTolerance 0.15` 抠掉纯色背景
- `--maxColors 6` 压色数（照片转拼豆必开，否则几十种颜色没法拼）

支持 PNG（内置解码器）、JPEG/WebP/隔行PNG（自动退回头less 浏览器解码）。
**照片转出来的必须人工修** —— 用 `--out` 存 JSON，改 `rows_art` 里的字符，再 `check` 回来。

---

## 颜色落色（自动，但要知道原理）

生成的颜色会自动**吸附到真实能买到的豆色**上，用 CIE Lab 距离 + 色相惩罚。
不然生成的画拼不出来。

```bash
node $S/generate.mjs palette              # 列出所有色卡
node $S/generate.mjs palette hama_standard --preview palette.png
```
内置：`hama_standard`(28色 5mm) / `hama_mini`(18色 2.6mm) / `glow`(夜光) / `gray16`(灰阶)。

---

## 产物格式

`--out` 产出图案 JSON，这是唯一真相，可复现、可手改、可 diff：

```json
{
  "format": "pixel-bead-pattern/v1",
  "name": "shiba", "cols": 20, "rows": 20,
  "palette": ["#3E2A20", "#E8A03C"],
  "rows_art": ["..000..", ".01110."],     // 行字符串，人眼可读
  "stats": { "filled": 268, "colors": 4, "hours": 0.45, "sizeMm": {"w":100,"h":100} }
}
```

- `--png` 额外产出**索引色 PNG**（体积最小，是固件和 Clockwise 主题最喜欢的格式）
- `--ascii` 终端里打印点阵（没有图片查看器时的后备）
- `--json` 打印完整 JSON

## 校验

```bash
node $S/generate.mjs check out.json --preview check.png
```
会检查：行宽一致 / 索引不越界 / 覆盖率 / 主体占比 / 左右对称度 / 孤立噪点。
`auditArt()` 的这些规则是启发式 —— 报出来的问题要自己判断是不是真问题。

---

## 接进图案库

```bash
node $S/generate.mjs install out.json --id pigs --name "三只小猪" --tags "标准豆,6色" --hot
```

生成的图案直接变成 `pixel-bead-studio/js/art.js` 里的内置图案（字符画格式完全一致）。
默认自动找 `./pixel-bead-studio/js/art.js`，也可用 `--art` 指定。

也可以喂给 `led-studio` 上 LED 屏 —— 两者都是离散格 + 有限色板，格式通用。

---

## 常见坑

| 坑 | 症状 | 处理 |
|---|---|---|
| 字符画行宽不一致 | 整幅图错位 | 编译器会直接报错并指出第几行（从 1 数） |
| **用了色卡外的颜色** | 落色后被吸成灰色，整只变石头 | 只用 `palette` 命令列出的色值 |
| **用椭圆/曲线 + 细描边** | 抗锯齿边缘平均出中间色 → 灰棕杂点 | 改用整数格色块；圆润感靠切角暗示 |
| **非整数缩放** | 格子边缘出现细缝，采样后混色 | 只用整数倍 |
| 颜色数太多 | 拼豆没法拼（>12 色就很痛苦） | `--maxColors 8` |
| 主体太小 | 预览里一堆空白 | 改 `cols` 或放大形状；audit 会提示占比 |
| `--outline` 没效果 | 描边没出现 | 描边只能画在**透明轮廓格**上。整片铺了底就没地方落笔 —— 想要描边就留透明背景 |
| 图案库显示英文机器名 | 标签页显示 `three-little-pigs-cutout` | `install` 时给 `--name "中文名"` |
| 只写代码不看图 | 改了 8 版还不对 | **每版都 `--preview` 并真的打开看** |

## 参考

- `references/api.md` —— 绘图 API 与图案 JSON 格式的完整说明
- 环境里如果没有 Edge/Chrome，路径 C 只能读 8bit 非隔行 PNG
