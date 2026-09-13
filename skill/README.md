# pixel-bead-pattern skill

拼豆 / 像素图案生成器。**零依赖**，只用 Node 内置模块，不需要 `npm install`。

这套东西是 `pixel-bead-studio` 的图案产线：用它生成图案、看图迭代、再 `install` 进
`pixel-bead-studio/js/art.js` 的图案库。

## 三条生成路径

| 路径 | 命令 | 什么时候用 |
|---|---|---|
| **A 手绘字符画** | `art <spec.mjs>` | 形象简单明确、要逐格精确控制 |
| **B 几何代码** | `code <art.mjs>` | 结构复杂：有曲线、重复元素、几何形体 |
| **C 照片/图片转** | `image <photo>` | 有现成图片要转成图案（只适合出草稿） |

经验：**结构性题材（火箭、花、建筑）用 B 又准又快；有机形象（动物）用 A 更稳** ——
B 的曲线在 30 格尺度下只会得到零散点，形不成实心轮廓。

## 最重要的一条：必须看图

**生成 → 渲染 → 看 → 改，这个闭环不能省。**

```
node scripts/generate.mjs code art.mjs --cols 48 --rows 48 --out out.json --preview out.png
```

然后**打开那张 PNG 看**，不对就改。跳过这步就会盲改十几版都不对 —— 这是这个工具存在的全部理由。

## 用法

```bash
cd skill

# 生成（路径 B：几何代码）
node scripts/generate.mjs code my-art.mjs --cols 50 --rows 54 \
  --out out.json --preview out.png --maxColors 12

# 看图确认后，加进图案库（幂等，失败自动回滚）
node scripts/generate.mjs install out.json --id mypattern --name "中文名" --tags "标准豆,10色"

# 其它
node scripts/generate.mjs palette          # 看色卡
node scripts/generate.mjs check out.json   # 校验已生成的图案
```

`install` 会自动找 `../pixel-bead-studio/js/art.js`，也可用 `--art` 指定。

## 尺寸

没有硬性上限，格子数由 `--cols` / `--rows` 决定。已有图案从 20×20 到 64×32 都有，
大尺寸（50×54 这种）豆子数约 800~1600 颗，成品 250~280mm，耗时 2~3 小时。

## 只用色卡里真实存在的颜色

内置色卡（`palette` 命令可查）是 Hama 风格的 28 色，和 `pixel-bead-studio` 的
`standard` 色卡**逐色一致**。用了色卡外的颜色，落色时会被吸成别的色 ——
比如 `#E8E8E8` 会被吸到 `#F2F2F2`、`#C4C4C4` 会被吸到 `#9B9B9B`，
导致精心设计的明暗层次全部压平。

**拼豆超过 12 色就很难拼了**，建议 `--maxColors 12`。

## 结构

```
skill/
├─ SKILL.md            agent 用的技能说明
├─ references/api.md   绘图 API 与数据格式完整参考
└─ scripts/
   ├─ generate.mjs     CLI 入口（art / code / image / check / install / palette）
   └─ lib/
      ├─ art.mjs       画布 API（几何图元 + 采样落色）
      ├─ chars.mjs     字符画编译校验 + install 写入 art.js
      ├─ palette.mjs   色卡 + CIE Lab 落色 + 抖动
      ├─ raster.mjs    零依赖 2D 光栅化器
      ├─ trace.mjs     图片解码（PNG 自带解码器，其它格式退浏览器）
      ├─ preview.mjs   拼豆板 / LED 两种预览渲染
      └─ png.mjs       零依赖 PNG 编解码
```
