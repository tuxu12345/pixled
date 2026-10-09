# 拼豆工坊 · Pixel Bead Studio

「文/图 → 像素点阵 → 车外 HUB75 点阵屏」的可交互 Demo，配一份《AI 能力技术架构方案图》。
对应群里的需求：**让用户不用手动做，AI 直接生成拼豆风图案，并一键下发到 96×48 的屏上**。

---

## 车机版（绘画优先）改了什么

这一版同时是 **安卓车机 App（`com.byd.pixelbead`）内置的网页**。网页代码只维护这一份，
安卓壳把 `assets/www` 原样装进 WebView，一个字节都不改（见 `../pixel-bead-app/README.md`）。

| 改动 | 位置 | 说明 |
|---|---|---|
| **打开就是画布** | `js/app.js` `boot()` | 不再默认载入图案库第一个（那是只读展示），改成 32×32 空白画布 + 直接进编辑态 |
| **画布升为第 1 屏** | `index.html` / `css/app.css` | AI 生成降级到右栏，标「可选」；顶栏加「🗒 新建」「🔥 熨烫」 |
| **编辑面板默认展开** | `index.html` | 铅笔/橡皮/油漆桶/吸管/直线/矩形 + 28 色色板 + 撤销 + 自定义取色常驻 |
| **一画就拖屏** | `js/app.js` `bindCanvas()` | `pointerdown` 里加 `ev.preventDefault()`；配合 CSS `touch-action:none` |
| **小方块 LED 灯珠质感** | `js/render.js` | 圆角瓷砖 + 上亮下暗渐变 + 左上高光。**点阵 LED 是矩形，不是圆豆** |
| **🔥 熨烫预览** | `js/render.js` `drawIron()` | 逐角圆角让相邻豆子熔合粘连、无孔、整片熔面光泽；导出 PNG 同效果 |
| **`roundedRect()` polyfill** | `js/render.js` | 部分 WebView 没有 `ctx.roundRect`，直接用会 TypeError 白屏 |
| **车机横屏布局** | `css/app.css` | 整页不滚动 = 左画布撑满 + 84px 竖排工具条 + 右栏独立滚动 |
| **JS 桥** | `js/bridge.js` | `PBSBridge` 调用全部 `typeof` 判断，浏览器自动回退 blob 下载 |
| **localStorage 保险丝** | `js/safels.js` | WebView 没开 `domStorageEnabled` 时降级为内存，不白屏 |
| **启动失败诊断** | `index.html` | 模块没起来时区分「file:// 双击」「WebView 内核太老」「文件缺失」三种原因 |

### 横屏车机布局（1280×720 / 800×480 都验过）

```
┌───────────────────────────────────────────────┬──────────────┐
│ 顶栏  🗒新建 🔥熨烫   [桥] [AI] ⚙              │              │
├──────────────────────────┬────┬───────────────┤  右栏        │
│                          │ 84 │  AI 生成      │  （可选）     │
│      大画布撑满           │ px │  ────────     │  独立滚动     │
│      （不滚动）           │ 竖 │  图案库       │              │
│                          │ 排 │              │              │
└──────────────────────────┴────┴───────────────┴──────────────┘
```

三个必须记住的坑（都在代码注释里标了）：

1. **整页不滚动**：`html,body{height:100%;overflow:hidden}` + `body` 变 flex 列，
   高度交给 `main{flex:1;min-height:0}`。用 `100vh` 硬算会在某些车机上差一截。
2. **画布高度只能从 `canvasWrap.clientHeight` 反推**。用 `window.innerHeight` 估出来的
   cell 会把画布顶出屏幕（它比画布容器多着一整个顶栏 + 工具行）。见 `js/app.js` `render()`。
3. **`.editor` 换成 `flex-direction:column` 时必须同时加 `flex-wrap:nowrap`**。
   基础样式带 `flex-wrap:wrap`，不改的话 28 色色板会被 wrap 到第二列，
   而第二列刚好被 84px 宽度 + `overflow-x:hidden` 裁掉 —— 现象是**一个颜色都看不见**。

---

## 快速开始

**必须用本地服务打开**（浏览器禁止 `file://` 加载 ES 模块，双击 `index.html` 会白屏且按钮无反应）：

```bash
cd pixel-bead-studio
node server.mjs 8137
# 打开 http://127.0.0.1:8137/
```

> 万一直接双击了 `index.html`，页面会显示一个明确的提示告诉你怎么起服务，不会让你对着黑屏猜。

**架构图**：`architecture.html` 是自包含的，双击就能看，可投屏。

### 配 API Key
点右上角 **⚙** 填入 `sk-...` 保存即可（存 localStorage，请求直连 `api.deepseek.com`，外网直连，不需要本地代理）。
不填也能用：AI 生成会走内置图案演示，而画画 / 导出 / 下发帧完全不依赖网络。

> ⚠️ 纯前端直连只适合演示。生产环境 Key 必须放服务端，走自家 `/api/ai/pixel` 代理。

---

## 工具：图纸截图 → 图案库条目

`tools/extract-art.mjs` 把一张**拼豆图纸截图**读成能直接进 `js/art.js` 的条目。

```bash
npm i -D puppeteer-core                      # 只装这个，浏览器用系统已装的 Chrome / Edge
node tools/extract-art.mjs 图纸.png --cols 52 --rows 52 \
     --id luoxiaohei --name "罗小黑" --tags "标准豆,7色,约2.5小时" --hot \
     --out art-luoxiaohei.js --preview luoxiaohei.png --crop-debug crop.png
# 确认没问题了再加 --install，直接插到 js/art.js 的 ART 数组头部（语法 + 加载双重自检，失败回滚）
```

它做的事：

1. **找图纸区域** —— 先检测网格线（低饱和浅灰长直线），再用「最均匀的 cols+1 / rows+1 条线」
   拟合格距和原点。截图带的页眉标题、页脚色卡、四周留白会被自然排除。
   拟合不上就退回内容外接框；`--crop x,y,w,h` 可以手动指定，`--crop-debug` 导出框选图看一眼。
2. **逐格取中心 60% 的众数色**（按 5 bit/通道分桶，再对桶内取真实均值）。
3. **判空** —— 中心是纸白 **且** 这一格里几乎没有"画上去的"像素。
   单看"中心是不是白的"会把白豆子（线条小狗整个身子都是白的）一起判没；
   所以把格子挖掉一圈边界带（格线就在边界上），看里面还有多少像素不是纸白。
4. **落色到标准豆色卡** —— 复用 `js/palette.js` 的 `nearestColor`（CIE Lab + 色相惩罚），
   和网页端同一份色卡、同一套算法。
5. **删孤立浅色噪点** —— 8 邻域里有豆的邻居 ≤1 且自身偏亮的格子判为图纸反光/网格残留。
   不删深色孤立点（那可能是眼睛高光、鼻尖这类真实细节）。
6. **压色数 / 出条目 / 出预览 PNG**。

回归测试：把图案库里已有的图案渲染成一张「白底 + 圆豆 + 网格 + 页眉页脚」的图纸截图，
再让脚本读回来逐格比对，**8 个图案（20×20 到 52×52）全部 100% 一致**。

---

## 界面（刻意做简单）

一条主线，只有三个区块：

1. **写一句 → 生成**：输入框 + 6 个快捷词 + 尺寸/豆色；生成方式、色数上限、创造力、模型名都收在「更多选项」里
2. **画布**：点「✎ 编辑」才出现工具和色板，「🎲」随机换色，「⤓ 导出」，「发送到屏幕」
3. **图案库**：点一下直接换图案

没有侧边栏、没有常驻的参数面板 —— 打开就知道该干嘛。


---

## 能做什么

| 能力 | 说明 |
|---|---|
| **AI 文生点阵** | 一句话出图。默认走「语义分镜 → 本地渲染」，可选「模型直出网格」 |
| **图生点阵** | 传照片，让多模态模型转成拼豆图案 |
| **像素编辑器** | 铅笔/橡皮/油漆桶/吸管/直线/矩形、撤销重做、镜像、裁边 |
| **真实豆色卡** | 标准豆 28 色 / 迷你豆 18 色 / 夜光豆 12 色，自动把 AI 配色落到**能买到的豆色**上 |
| **屏幕预览** | 96×48 面板实时预览，带发光质感、换色/呼吸/扫描/波动动效、3×5 点阵字叠字 |
| **导出** | PNG / 豆子清单 / 图案 JSON / **ESP32 C 数组（含 RGB565 调色板 + RLE）** / 二进制帧（CRC16） / **Clockwise 主题 JSON** |

---

## 和 Clockwise / clock-club 生态对接

导出菜单里的 **「Clockwise 主题」** 会生成一份符合 [clock-club](https://github.com/jnthas/clock-club) 规范的主题 JSON：
颜色是 RGB565 整数，图片是内嵌的**索引色 PNG（base64）** —— 固件（[clockwise](https://github.com/jnthas/clockwise)）拉下来就能直接上屏，不用重烧固件。

完整技术分析见 `../led-matrix-research/LED点阵上屏与烧录技术分析.md`，那里解释了整条链路和几个必须避开的坑。

实测体积：64×64 / 11 色的图案 → 索引 PNG **556 字节** → 完整主题 JSON **1060 字节**。

> ⚠️ **浏览器端导出的 PNG 会更大**：浏览器没有 `node:zlib`，IDAT 只能走未压缩兜底。
> 小图没问题（29×29 约 998B，仍在上限内），**64×64 这类大图请在 Node 下用 `_probe/make-theme.mjs` 生成**。
> 界面上的提示会实时告诉你有没有超过固件的 1KB 缓冲上限。


---

## 实测结论（这套东西为什么这么做）

1. **别用文生图模型。** 像素屏要的是离散格点 + 真实豆色，生图给的是位图，还得反推网格、颜色也对不上。
   让 LLM 直接输出结构化格点数据更准、更省、可编辑。
2. **必须关思考链。** `deepseek-v4-flash` 是推理模型，不关的话 `max_tokens` 会被 `reasoning_tokens` 吃满，
   `content` 返回空串（实测 8000 token 全烧在思考上）。加 `thinking: {type:'disabled'}` 后 20×20 约 1.8s 返回。
3. **两条路径，默认走分镜：**

   | 路径 | 做法 | 实测 |
   |---|---|---|
   | `spec`（默认） | 模型只出「形状 + 配色 + 位置」分镜，像素由本地渲染器铺 | ~1000–1400 token，48×48 稳定出可辨识图案 |
   | `direct`（可选） | 模型直出「行字符串」网格 | 20×20 约 460 token 够用；48×48 要 8000 token 仍会截断成糊图 |

   分镜更稳：模型只需决定 16 个形状，不用逐格生成 2304 个像素；边缘由几何算法生成，天然干净、严格对称。
4. **颜色匹配必须用 CIE Lab。** 加权 RGB 会把 `#C0392B`（暗红）配成 `#FFB7C5`（粉）、`#2B2B2B`（黑）配成棕，
   一眼就假。换 Lab + 色相惩罚后，3000 个随机色里两种算法差 57%，Lab 明显更符合肉眼。
5. **护栏要厚。** AI 输出不可信：抠 JSON、尺寸对齐、索引越界、调色板缺失、对称修复、描边补齐、落色兜底，一层都不能少。
6. **CORS 可用但不该依赖。** `api.deepseek.com` 的预检会正常回显 `access-control-allow-origin`，浏览器可直连；
   但生产环境仍应走服务端代理，隐藏 Key + 做配额 + 内容审核。

---

## 文件结构

```
pixel-bead-studio/
├─ index.html          主界面（车机 HMI 风格）
├─ architecture.html   ★ AI 能力技术架构方案图（自包含，可投屏）
├─ server.mjs          本地静态服务 + 可选 /api/chat 代理
├─ css/app.css
└─ js/
   ├─ ai.js       两条生成路径、提示词、调用参数、兜底生成
   ├─ spec.js     ★ 语义分镜 → 本地光栅化（默认路径）
   ├─ grid.js     点阵数据模型 + 校验/修复管线
   ├─ palette.js  拼豆色卡 + CIE Lab 落色
   ├─ render.js   画布/豆子质感/PNG/豆子清单
   ├─ export.js   C 数组 / 二进制帧 / 3×5 字库 / 动效帧
   ├─ art.js      内置图案库 + 我的创作
   └─ ui.js       UI 控制器
```

---

## 硬件对接

- **屏**：微雪 HUB75 RGB 全彩点阵，96×48（约 20×10cm），可级联
- **驱动**：ESP32-S3 RGB Matrix 驱动板（双麦克风，可做语音唤醒换图）
- **帧协议**（串口 / BLE / WiFi 通用同一份帧）：

```
A5 5A | ver | cmd | cols | rows | colors | flags | palette[colors*2] | payload | CRC16
```

`payload` 为 RLE 数据（每 2 字节 = [颜色索引+1, 连续像素数]）。
实测 96×48 帧从 4608 字节压到 522–700 字节（省 85–89%）。

导出的 `bead_art.h` 里带 `palette565[]`、`_frame_rle[]` 和 `_draw_rle()`，可直接编译进 ESP-IDF 工程。

---

## 自测

```bash
node ../\_probe/test-lib.mjs                  # 32 项纯逻辑自测（规整化/修复/打包/导出/字库/动效）
node ../\_probe/run-headless.mjs smoke        # 无头浏览器把界面上每个按钮都点一遍（40+ 项）
node ../\_probe/run-headless.mjs ai-ui        # 走真实 UI 路径 + 真实 API 生成一张
node ../\_probe/run-headless.mjs multirun     # 多种描述各生成一次，出图人工核对
node ../\_probe/run-headless.mjs ui --shot /index.html 1280 1400   # 给界面截图
```

## SVG 路径 → 拼豆点阵（画准结构的路子）

语义分镜只会画椭圆/矩形/三角，遇到「骑自行车的鹈鹕」这种**有结构、有细长线条**的画面就崩成色块。
`js/svgraster.js` 提供了第二条路：**用 SVG 把画面画准，再按格取样**，然后落色到真实豆色卡。

```js
import { svgToGrid } from './js/svgraster.js';
const grid = svgToGrid(svgText, {
  cols: 96, rows: 48,
  beadPalette: BEAD_SETS.standard.colors.map((c) => c[1]),
  strokeScale: 0.7,   // 低分辨率下必须压线宽，否则线一多就糊成黑块
});
```

支持 `circle / ellipse / rect / line / polyline / polygon / path`，
path 支持 `M L H V C S Q T A Z`（含相对指令）；**只有闭合子路径参与填充**，开放子路径只描边。

样张：`art/pelican-bike.svg` → `art/pelican-bike.json` → `art/bead_pelican.h`
（重新生成：`node ../_probe/make-pelican.mjs`）

### 这个光栅化器踩过的 5 个坑（都已修，值得留着）

1. **属性名正则漏了数字**：写成 `[a-zA-Z-]+` → `x1/y1/x2/y2` 全解析成 `undefined`，所有线条都画到 (0,0)。
2. **子路径起点被塞了 `[0,0]`**：`startSub` 里写成 `cur = [[x, y]]`，等于每条子路径都从原点牵一条线过来。
3. **开放子路径也拿去填色**：bbox 会扫出一大片空白楔形，整幅图被盖住。
4. **指令连写判断写反了**：`M56 5L57 8` 这种紧凑写法会错位，后面坐标全乱。
5. **读到越界 token 变 NaN**：坐标被污染成 NaN 还会死循环，必须显式 `break`。
   调试手法：`_probe/debug-flatten.mjs`（看展平后的点）和 `svgToGrid(..., {debug:true})`（逐元素报填充/描边范围）。


- **`file://` 下 ES 模块被拦**：双击打开 = 白屏 + 按钮全无反应。现在页面上有兜底提示，并在 README 里写死"必须起服务"。
- **`hidden` 属性被 CSS 覆盖**：`.guard{display:grid}` 优先级高于浏览器默认的 `[hidden]{display:none}`，
  导致"隐藏了却仍然盖住页面"。现在所有覆盖层改用 `.show` 类控制。
- **豆孔用 `destination-out` 打透明**：结果从每个豆子里透出背景棋盘格，整片看起来又脏又糊。
  真实豆孔是"同色更暗"，改成填充暗色后立刻干净了。
- **棋盘格和豆子一样大**：视觉噪声太重，现在棋盘格固定不小于 24px。
- **推理模型吃满 token**：见上文第 2 条。

