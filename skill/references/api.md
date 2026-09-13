# 绘图 API 与数据格式参考

## 1. 画布 API（路径 B）

```js
export default function ({ cr, mc, hsl, mix, shade, cols, rows }) { ... }
```

引擎会预建一张 `cols × rows` 的画布放在 **`cr`**。要用别的尺寸就自己建：

```js
const c = mc({ w: 40, h: 24, scale: 8, background: '#FFFFFF' });
```

**坐标**：原点左上，y 向下，单位是格子（不是像素）。内部按 `scale`（默认 8）超采样，
所以半径 0.5 这种小数也是有效的 —— 采样时会平均，边缘天然抗锯齿。

**绘制顺序**：后画的盖前面的。先大轮廓，再五官。

### 图元

| 方法 | 签名 | 说明 |
|---|---|---|
| `circle` | `(cx, cy, rad, style)` | 圆 |
| `ellipse` | `(cx, cy, rx, ry, style)` | 椭圆 |
| `rect` | `(x, y, w, h, style)` | 矩形，`style.rx` 给圆角 |
| `poly` | `(points, style)` | 多边形，自动闭合；`points` 是 `[[x,y],...]` |
| `path` | `(points, style)` | 折线，**不**闭合 |
| `line` | `(x1, y1, x2, y2, style)` | 直线 |
| `capsule` | `(x1, y1, x2, y2, thickness, style)` | 粗线段（圆头），画四肢/茎/车架很好用 |
| `arc` | `(cx, cy, rx, ry, a0, a1, style)` | 圆弧，**角度制**，0° 指向右，顺时针（y 向下） |

### style

```js
{ fill: '#RRGGBB', stroke: '#RRGGBB', strokeWidth: 1, rx: 2 }
```

- `fill` 省略 = 不填充
- `stroke` 省略 = 不描边；`strokeWidth` 单位也是格子
- 颜色格式：`#RGB` / `#RRGGBB` / `#RRGGBBAA` / `rgb()` / `rgba()`
- 也认这些色名：black white red green blue yellow orange purple gray cyan magenta brown pink navy teal

### 格子对齐

拼豆是格子的，有些形状按格画更整齐：

```js
cr.cellCircle(gx, gy, n, style)     // 占 n 格直径的圆，左上角在格子 (gx,gy)
cr.cellRect(gx, gy, gw, gh, style)  // 占 gw×gh 格的方块
```

### 颜色工具

```js
hsl(210, 0.8, 0.5)      // → '#1A8CFF'，h 0..360，s/l 0..1
mix('#FF0000', '#0000FF', 0.5)
shade('#FFA300', 0.7)   // 压暗；>1 提亮
```

### 其他

```js
cr.drawImage(otherRaster, dx, dy)  // 贴图
cr.debugBounds('#FF00FF')          // 画个外框，检查构图有没有超出
```

---

## 2. 字符画格式（路径 A）

```js
export default {
  name: '作品名',
  palette: ['#RRGGBB', ...],   // 最多 36 色
  art: ['..00..', '.0110.'],   // 每行必须等长
};
```

| 字符 | 含义 |
|---|---|
| `0`-`9` | 调色板下标 0-9 |
| `a`-`z` | 调色板下标 10-35 |
| `.` / 空格 | 不放豆（透明） |

导出的行字符串就是同一个格式，所以 `decompileArt(grid)` 的输出能直接改完再编回来。

---

## 3. 图案 JSON（唯一真相）

```json
{
  "format": "pixel-bead-pattern/v1",
  "name": "shiba",
  "source": "code:art.mjs",
  "cols": 20,
  "rows": 20,
  "palette": ["#3E2A20", "#E8A03C", "#FFF3C4", "#E8352B"],
  "rows_art": [
    "..000..........000..",
    ".01110........01110."
  ],
  "stats": {
    "filled": 268,
    "empty": 132,
    "colors": 4,
    "hours": 0.45,
    "sizeMm": { "w": 100, "h": 100 },
    "beadSet": "标准拼豆（Hama 风格）"
  },
  "generatedAt": "2026-09-13T07:00:00.000Z"
}
```

- `rows_art` 的行字符串 = 人眼可读的点阵，`git diff` 看得懂，手工能改
- 索引 `-1` 不出现，透明用 `.` 表示
- 调色板已收拢到**实际用到**的颜色（不会有没用的色占位）

### 手改后校验

```bash
node scripts/generate.mjs check out.json --preview check.png
```

---

## 4. 色卡

```
hama_standard   标准拼豆（Hama 风格）  28 色  豆径 5mm
hama_mini       迷你豆                18 色  豆径 2.6mm
glow            夜光豆                12 色  豆径 5mm
gray16          16 级灰阶             16 色  豆径 5mm（做单色图案）
```

落色用 **CIE Lab 距离 + 色相惩罚**。为什么不用加权 RGB：
加权 RGB 会把 `#C0392B`（暗红）配成 `#FFB7C5`（粉豆）、把 `#2B2B2B`（黑）配成棕豆，
一眼就假。换 Lab 之后 3000 个随机色里有 57% 的落色结果不同，且明显更符合肉眼。

---

## 5. 内部模块（要扩展时才看）

| 文件 | 职责 |
|---|---|
| `lib/png.mjs` | 零依赖 PNG 编码/解码（索引色 + RGBA） |
| `lib/raster.mjs` | 2D 光栅化器（图元、合成、模糊、降采样采样） |
| `lib/palette.mjs` | 色卡 + CIE Lab 落色 + Bayer 抖动 + 描边 |
| `lib/art.mjs` | 画布 API（用户友好层）+ 采样落色 |
| `lib/chars.mjs` | 字符画编译/反编译 + 质量自检 |
| `lib/trace.mjs` | 图片解码（PNG 自己解，其他退浏览器）+ 采样 |
| `lib/preview.mjs` | 拼豆/LED 预览渲染 + 5×7 标签字库 |

关键设计：**抗锯齿不在图元层做，而是先在 `cols×scale` 的高分辨率栅格化，
再从高分辨率图按格平均采样** —— 平均本身就是抗锯齿，而且采样权重可控。

预览渲染的两个细节（都是踩出来的）：
- 珠子中心孔用**同色压暗**，不是打透明 —— 透明会透出底板，整片看起来又脏又糊
- 珠子之间必须留缝 —— 铺满就像马赛克，不像拼豆
