# pixel-led

像素点阵相关的四个独立 Web Demo。共同点是**都在浏览器里模拟"离散像素 + 有限色板"的硬件**，
不用真买屏就能看清不同技术方案的差别。

每个 Demo 都是**零依赖**的纯 ES 模块 + 一个几十行的静态服务器，克隆下来直接 `node server.mjs` 就能跑，
不需要 `npm install`。

---

## 四个 Demo

| Demo | 目录 | 端口 | 模拟什么 |
|---|---|---|---|
| **LED Studio** | `led-studio/` | 8139 | HUB75 点阵屏：扫描驱动、色深限制、上屏效果 |
| **拼豆工坊** | `pixel-bead-studio/` | 8137 | 拼豆图案：字符画 / 几何生成 / AI 生成 / 导出 |
| **Mini-LED Studio** | `miniled-studio/` | 8140 | Mini-LED 背光分区调光：分区提取、光晕、对比度 |
| **LED Arcade** | `led-arcade/` | 8142 | 在 LED 点阵屏里玩的横版街机游戏（三关 + 首领） |

### 四者是什么关系（容易混）

```
LED Studio（点阵屏）       Mini-LED Studio（背光）      LED Arcade（游戏）
像素 = 灯珠本身             像素 = LCD 透光率 × 背光      在点阵屏里跑游戏
间距 3~5mm，灯珠肉眼可见     间距 0.1~0.5mm，看不见        每一帧都用灯珠画出来
看的是"图案怎么显示"         看的是"分区怎么给光"          看的是"能玩成什么样"
        ↑
   拼豆工坊（拼豆）
   像素 = 一颗豆子，间距 5mm
   产物既能拼实物，也能直接上点阵屏
```

**拼豆和点阵屏是同一件事的两面**：都是离散格子 + 有限色板，图案格式通用。
`led-studio` 能直接读取 `pixel-bead-studio` 的图案库（`js/art.js` 的 `LIBRARY`）。
`led-arcade` 用的是同一套点阵渲染思路（`js/led/buffer.js` 复制自 LED Studio），
但**运行时完全独立**，不依赖其它三个目录。

---

## 跑起来

### 方式一：部署到 Vercel（推荐，零配置）

**直接 import 本仓库即可，不需要任何构建配置。** 四个 demo 会自动出现在各自的路径下：

```
https://<你的项目>.vercel.app/                    ← 落地页（四个 demo 的总入口）
https://<你的项目>.vercel.app/led-studio/         ← LED Studio
https://<你的项目>.vercel.app/pixel-bead-studio/  ← 拼豆工坊
https://<你的项目>.vercel.app/miniled-studio/     ← Mini-LED Studio
https://<你的项目>.vercel.app/led-arcade/         ← LED Arcade 游戏
```

为什么能直接跑：四个 demo 都是**纯静态 ES 模块**，没有任何服务端逻辑
（各自的 `server.mjs` 只是本地开发用的静态文件服务器，Vercel 上用不到）。
所有资源引用都是相对路径，`led-studio` 读取隔壁拼豆图案库用的也是相对路径
`../../pixel-bead-studio/js/art.js`，在 Vercel 上解析成 `/pixel-bead-studio/js/art.js`，依然成立。

`vercel.json` 只做了两件事：`cleanUrls: false`（保证 `/led-studio/` 这种路径能正常解析到
`index.html`），以及显式声明 `.js` / `.css` / `.json` 的 Content-Type。

> ⚠️ 根目录的 `index.html` 是**必须的**（Vercel 静态项目的规定）。它是四个 demo 的落地页。

### 方式二：本地

```bash
# 任选一个，进对应目录
cd led-studio          && node server.mjs 8139
cd pixel-bead-studio   && node server.mjs 8137
cd miniled-studio      && node server.mjs 8140
```

然后浏览器打开对应地址。

> ⚠️ **必须用本地服务打开，不能双击 index.html。**
> 浏览器禁止 `file://` 下加载 ES 模块，双击会导致脚本完全不跑、按钮全部没反应。
> 四个页面都内置了兜底提示面板，检测到 `file://` 会明确告诉你怎么办。

跑 `led-studio` 时建议同时跑 `pixel-bead-studio` —— 前者的"拼豆图案"上屏功能会去读后者的图案库
（读不到会退回自带图案，不会报错）。

### 关于 AI 生成功能

拼豆工坊的 AI 生成需要 DeepSeek API Key，**在页面里手动填入**，存在浏览器 localStorage
（**不写进源码，也不会传到服务器**）。部署到 Vercel 后同样可用 —— 是浏览器直连
`https://api.deepseek.com`，不经过任何后端代理。

---

## 各 Demo 的能力

### LED Studio（`led-studio/`）
- 虚拟屏尺寸 8×8 ~ 256×128，含常用的 64×32 / 64×64 / 96×48 / 128×32
- **真实色深限制**：RGB888 / RGB666 / **RGB565（HUB75 常见）** / RGB332 / 单色
- 屏的观感：灯珠形状（圆/方）、灯珠间隙、辉光、扫描线、伽马
- 10 个驱动效果：滚动文字、全屏图片、横向滚动、扫描线扫过、等离子、雪花、流星雨、呼吸灯、彩条/灰阶测试、彩虹
- 图片 / 视频导入上屏（拖拽或选择文件），三种上屏方式
- 拼豆图案一键上屏
- 导出：**固件 C 数组**、**RLE 下发帧**、图案 JSON、录制 WebM、导出帧序列
- 5×7 点阵字库（**笔画定义生成**，不是手抄位图 —— 见下方"踩过的坑"）

### 拼豆工坊（`pixel-bead-studio/`）
- 三条生成路径：**手绘字符画** / **几何代码绘图** / **AI 生成**（需 DeepSeek API Key，走 `spec.js` 形状规格）
- 内置图案库（11 个，含"三只小猪"）
- 真实豆色落色（CIE Lab 距离 + 色相惩罚，不会把暗红配成粉豆）
- 尺寸 20×20 ~ 96×48，导出图案 JSON / 索引色 PNG / 固件头文件 / Clockwise 主题包
- 成品尺寸与耗时估算

### Mini-LED Studio（`miniled-studio/`）
- 成像模型：`最终画面 = LCD 透光率(像素级) × 背光亮度(分区级，被扩散糊开)`
- 4 种分区取值算法：`max` / `mean` / `rms` / `hybrid`（可调 max 权重）
- 分区数 2×2 ~ 128×72，含真实产品档位预设（96 / 384 / 1152 / 2304 / 9216 分区）
- 背光扩散、分区最低亮度、面板漏光、原生对比度、伽马
- 7 个测试画面 + 自己上传图片，三图对比（原图 / 传统整屏背光 / Mini-LED）
- 背光场热力图、分区网格叠加
- 实时指标：重建误差 MAE、背光功耗、估算对比度、光晕量化
- 导出对比报告

**实测结论**（夜景窗户场景，32×18 分区）：

| 指标 | 传统整屏背光 | Mini-LED | 改善 |
|---|---|---|---|
| 重建误差 MAE | 0.0266 | **0.0035** | 准了 7.5× |
| 背光功耗 | 85.3% | **22.7%** | 只剩 27% |

像素级验证：暗房间 `8,8,9` → 传统 `2,2,2`（压过头）/ Mini-LED `8,8,10`（精确还原）。

---

## 目录结构

```
pixel-led/
├─ index.html             落地页（四个 demo 的总入口，Vercel 需要根目录有 index.html）
├─ vercel.json            Vercel 配置（cleanUrls + Content-Type）
├─ led-studio/            HUB75 点阵屏模拟器
│  ├─ index.html
│  ├─ server.mjs          静态服务（根 = 仓库根，为了能读隔壁拼豆图案库）
│  ├─ css/app.css
│  └─ js/
│     ├─ buffer.js        帧缓冲、色深量化、RLE
│     ├─ font.js          5×7 字库（笔画定义生成 + 自检）
│     ├─ effects.js       10 个驱动效果
│     ├─ pipeline.js      上屏管线（采样、适配、抖动）
│     ├─ display.js       虚拟屏渲染（灯珠、辉光、扫描线）
│     └─ app.js           UI 控制器
├─ pixel-bead-studio/     拼豆图案工坊
│  ├─ index.html
│  ├─ server.mjs
│  ├─ art/                示例素材（SVG、主题包、固件头文件）
│  └─ js/
│     ├─ grid.js          格子数据结构
│     ├─ palette.js       豆色板与落色
│     ├─ art.js           内置图案库（字符画格式）
│     ├─ chars.js         字符画编译
│     ├─ spec.js          形状规格 → 像素
│     ├─ svgraster.js     SVG → 像素
│     ├─ render.js        拼豆板渲染
│     ├─ export.js        导出（JSON/PNG/头文件/主题包）
│     ├─ themepack.js     Clockwise 主题包
│     └─ ai.js            DeepSeek 接入
├─ miniled-studio/        Mini-LED 背光分区调光
   ├─ index.html
   ├─ server.mjs
└─ led-arcade/            LED 点阵街机游戏
   ├─ index.html
   ├─ start.bat          Windows 双击启动
   ├─ server.mjs         静态服务（自包含，根 = 自己）
   ├─ docs/              设计 / 计划 / 验证记录
   ├─ tests/game.test.mjs  12 项游戏逻辑测试
   └─ js/
      ├─ game.js         固定步长模拟、关卡、自动演示（不依赖 DOM）
      ├─ render.js       原生像素场景绘制
      ├─ app.js          输入、主循环、设置、导出
      └─ led/            buffer.js（点阵缓冲）+ display.js（灯珠显示）
```

---

## 踩过的坑（留着免得再犯）

这些都是实际调试中踩出来的，写在代码注释里了，这里汇总一下：

### 架构 / 环境
1. **`file://` 打不开 ES 模块** —— 必须走本地服务。四个页面都加了兜底面板，并区分
   "真的 file:// 打开"和"服务开着但脚本报错"两种情况，给不同的提示（否则会把人误导到错误方向）。
2. **不能对工作区根 `git init`** —— 里面有别的项目和几百 MB 的压缩包。

### 点阵屏
3. **`requestAnimationFrame` 在无头浏览器 + `--virtual-time-budget` 下只触发一次** ——
   依赖多帧的测试要在页面里直接调渲染函数，别等动画。
4. **`canvas.captureStream(30)` 在无头浏览器里录出 0 字节** —— 要用 `captureStream(0)` + `track.requestFrame()`。
5. **量化时必须在钳位之后再套伽马** —— 加法图层叠加后可能超过 1，先套伽马会把高光算成 1.63 再被裁掉，丢掉图层关系。
6. **手写 5×7 字库抄错了一个字** —— `Y` 的第 3 列写成 `0b1111000`，导致 `BYD` 显示成一坨。
   **已修复**：字库改成**笔画定义生成位图**（写起止点，程序算格子），这类错误在结构上不可能再发生，
   并加了 `auditGlyphs()` 密度自检（阈值按字母/标点分类，否则满屏误报）。
   教训：手抄位图这种"看起来合理但错一位"的 bug，肉眼几乎发现不了 —— 能程序生成的就别手写。

### 拼豆
7. **预览里的珠子中心孔不能打成真透明** —— 会透出底板，整片看起来又脏又糊。要用同色压暗。
8. **必须只用色卡里真实存在的颜色** —— 用了色卡外的色值，落色时会被吸成灰色，
   整只"白象"变石头。灰色可用范围很窄（`#FFFFFF` / `#F2F2F2` / `#9B9B9B` / `#4A4A4A`），
   想更立体只能靠冷暖色偏移，不能靠加更多灰阶。
9. **`labDistance` 传 Lab 对象时距离恒为 0** —— `hexToLab({...})` 会 `String(obj)` 成
   `"[object Object]"`，缓存命中同一个键，表现为"所有颜色都被吸到色卡第一项"。
   现在显式支持两种输入，非法格式会明确报错而不是静默返回垃圾值。
10. **几何代码画动物不成立** —— 曲线在 40 格尺度下只会得到一圈零散点，形不成实心轮廓。
    几何构造适合机械/建筑类；**动物必须走字符画**（逐格画）。
11. **复杂形象要先在小画布上验证 sprite** —— 直接拼整幅图会盲改十几版都不对。
    先画一个头（20×16）、渲染、确认"一眼认得出"，再组装。

### Mini-LED
12. **函数不能命名为 `process`** —— 会遮蔽 Node 全局 `process`，报错是
    `process.exit is not a function`（看起来完全无关）。已改名 `processFrame`。
13. **面板漏光必须是加性的，不能当除数** —— 物理上 LCD 关不严，背光再暗也有一点光透出来。
    所以黑场下限 ≈ leak（常数），这才是"面板原生对比度"的根源。
14. **全局背光基线要自适应，不能写死 1.0** —— 真实电视会按画面内容调全局背光，
    写死 1.0 对暗场画面是冤枉，对比就失去意义。
15. **测光晕要用"亮暗紧邻"的画面** —— 用左右对半的图测过，暗区离亮区太远，扩散传不过去，
    三种分区数都测出 0，等于没测。
16. **测高光还原要看峰值/高光区均值，不能看 RMSE** —— 成像里透光率被截断到 1，
    高光像素被"精确"还原，RMSE 恒为 0。

---

## 许可

内部项目，暂无 License。
