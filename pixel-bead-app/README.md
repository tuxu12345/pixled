# 拼豆工坊 · 车机安卓壳（PixelBead）

把 `pixel-bead-studio` 那套纯前端**原样**装进 Android WebView：横屏全屏、离线可用、
接一根 JS 桥把画好的图案存进「下载/PixelBead」并下发到 96×48 点阵屏。

- applicationId `com.byd.pixelbead`　应用名「拼豆工坊」
- minSdk 29 / targetSdk 34 / compileSdk 34
- 强制横屏、沉浸式全屏、窗口底色 `#0B1017`
- 网页一个字节都没改：`app/src/main/assets/www/` 是 `pixel-bead-studio/` 的同步副本

---

## 构建

```bash
# 1) 需要 JDK 17 和 Android SDK（platforms;android-34 + build-tools;34.0.0 + platform-tools）
# 2) 指向你的 SDK
echo 'sdk.dir=/path/to/android-sdk' > local.properties     # 或用 ANDROID_HOME 环境变量
# 3) 出包
./gradlew assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

装到车机（或先用手机/模拟器横屏验证）：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s PixelBead PBSBridge          # 网页 console + 桥的日志都在这
```

### 网页资产怎么进来的

`app/build.gradle.kts` 里有个 `syncWebAssets` 任务，构建前把
`../pixel-bead-studio/` 原样拷进 `app/src/main/assets/www/`。
**网页只维护一份**，改完网页直接 `./gradlew assembleDebug` 就是新的。

- 想跳过同步（比如 CI 上只有本仓库）：`./gradlew assembleDebug -PskipWebSync`
- 仓库里已经提交了同步后的产物，所以没有 `../pixel-bead-studio` 也能构建
- 排除项：`node_modules/`、`.git/`、`tools/`、`*.log`、`package-lock.json`

---

## 在模拟器 / 真机上车验证

`tools/` 下有两个脚本，都是这次实际用来验收的（已验证跑通）：

```powershell
# 1) 无窗口启动 1280×720 横屏模拟器 → 装 APK → 启动 → 截图
.\tools\run-on-emulator.ps1

# 2) 通过 CDP 直接驱动车机壳里的 WebView（比 adb input tap 靠谱得多）
$pid_ = (adb shell pidof com.byd.pixelbead) -join ''
adb forward tcp:9222 localabstract:webview_devtools_remote_$pid_
node .\tools\verify-on-device.mjs
```

`verify-on-device.mjs` 会读每个按钮的**真实 bounding box**、直接读页面状态，
并断言：整页不滚动 / 色板 28 色可见 / 画布不溢出 / 图案库前 3 个 /
新建清空 / 涂抹上色 / 熨烫切换 / sendFrame 调到桥 / 无 JS 报错。

> 依赖 `WebView.setWebContentsDebuggingEnabled(true)` —— 只在 **debug 包**里开，
> release 包不会暴露调试口。

开发期看网页 console：

```bash
adb logcat -s PixelBead PBSBridge        # 网页 console + 桥的日志
adb logcat -s PixelBead.E                # 只要网页的 error
```

---

## 三个踩过的坑，代码里都堵上了

### ① `file://` 下 ES 模块被 CORS 拦 → 不用 file://

网页的 js 全是 ES 模块。`file://` 下 module script 走 CORS 模式，直接
`ERR_FAILED`，页面白屏（这也是为什么本地调试必须 `node server.mjs 8137`）。

所以这里用 **`WebViewAssetLoader`** 把 `assets/www` 用
`https://appassets.androidplatform.net/assets/www/` 这个虚拟源伺服出去：

```java
final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();
web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
```

没有引入服务器、没有网络请求，纯离线；顺带让页面拿到一个正常的 origin
（`file://` 下是不透明源，localStorage 也靠不住）。

### ② `domStorageEnabled(true)` 是保命的

```java
s.setDomStorageEnabled(true);
```

不开的话 `window.localStorage` 要么是 null、要么一访问就抛 `SecurityError`，
页面 `boot()` 直接挂掉 —— 现象是"界面出来了，点什么都没反应"。
网页侧 `js/safels.js` 还兜了一层：真不可用就换成内存实现，功能降级但不白屏。

### ③ 画布上不能"一画就拖屏"

两边一起做才行：

- 网页侧：`pointerdown` 里 `ev.preventDefault()`；`#canvas` 和
  `.canvas-wrap.edit` 加 `touch-action: none`
- 原生侧：WebView 关掉滚动条、`OVER_SCROLL_NEVER`、禁长按选择
  （`setOnLongClickListener(v -> true)`）

---

## JS 桥契约（★ 改这里必须同步改 `js/bridge.js`）

`MainActivity` 通过 `addJavascriptInterface(new PBSBridge(this), "PBSBridge")` 注入。
**每个方法都必须带 `@JavascriptInterface`** —— 不带的在 JS 侧是 `undefined`，
网页里的 `typeof` 判断会直接走浏览器兜底分支（东西下到浏览器里去了）。

| 方法 | 说明 |
|---|---|
| `String version()` | 壳版本号，网页顶栏显示「车机桥 1.0」 |
| `void toast(String msg)` | 原生 Toast |
| `boolean sendFrame(String base64Frame, String metaJson)` | 保存帧 + 转发到屏幕 |
| `boolean saveFile(String fileName, String base64Content, String mimeType)` | 存到 下载/PixelBead |
| `boolean saveDataUrl(String fileName, String dataUrl)` | 存到 下载/PixelBead（PNG 走这条） |

返回 `boolean` 的方法：`true` = 成功。网页侧拿不到异常，只能看返回值。

**落盘位置**：`内部存储/Download/PixelBead/`。
API 29+ 的分区存储必须走 `MediaStore.Downloads`，
`RELATIVE_PATH = Download/PixelBead`，直接 `File` 写 `/sdcard/Download` 会 EACCES。

**网页侧全部 typeof 判断**（见 `js/bridge.js`）：没有桥就退回浏览器 blob 下载，
所以纯网页版（`node server.mjs 8137` / Vercel）照常能跑，不会因为找不到桥而按钮变哑巴。

---

## ★★★ 硬件同事的缝合点 ★★★

`PBSBridge.forwardFrameToPanel(byte[] frame, String metaJson)` —— 就这一个方法。

网页点「发送到屏幕」时，帧已经在网页侧打包好了，协议完备：

```
magic   2B   A5 5A
version 1B   = 1
cmd     1B   1=静态图 2=动画 3=文字 4=亮度
cols    1B
rows    1B
colors  1B
flags   1B   bit0 = RLE, bit1 = RGB565 调色板
palette N*2B RGB565
payload ..   RLE：每 2 字节 [颜色索引+1, 连续像素数]，索引 0 = 灭
crc     2B   CRC16-CCITT(poly 0x1021, init 0xFFFF)
```

现在这个方法只做三件事：打 Logcat、发一条 App 内广播、返回 true。
接硬件时把 `frame` 交出去就行，**不用再碰网页**：

```java
SerialTransport.get().write(frame);     // USB / UART
BleTransport.get().send(frame);         // BLE（帧通常 < 512B，普通 MTU 分包即可）
```

或者监听广播（车机内其它 App / 服务也能接这块屏）：

```java
public static final String ACTION_PANEL_FRAME = "com.byd.pixelbead.PANEL_FRAME";
// extras: "frame" (byte[]), "meta" (String, JSON)
```

`metaJson` 长这样，硬件侧要的尺寸/色数/压缩率都在里面：

```json
{
  "app": "拼豆工坊", "title": "罗小黑",
  "cols": 96, "rows": 48, "colors": 7,
  "frameBytes": 412, "payloadBytes": 400, "saved": "91",
  "rle": true,
  "protocol": "A5 5A | ver | cmd | cols | rows | colors | flags | RGB565palette | RLE | CRC16",
  "createdAt": "2026-10-09T14:46:22.454Z"
}
```

---

## 其它实现细节

- **文件选择器**：网页有「🖼 导入图片」（`<input type=file>`）。不实现
  `WebChromeClient.onShowFileChooser` 的话车机上点了完全没反应，
  所以 `MainActivity` 里走 `startActivityForResult` + `FileChooserParams.parseResult`。
- **权限**：只声明 `INTERNET` / `ACCESS_NETWORK_STATE`（AI 生成要外网直连 DeepSeek）。
  画画、导出、下发帧全部离线可用，车机没网也能干活。
- **沉浸式**：`WindowInsetsController.hide(systemBars)`（API 30+）/
  `SYSTEM_UI_FLAG_IMMERSIVE_STICKY`（API 29），`onWindowFocusChanged` 里抢回来。
- **图标**：纯 vector 自适应图标，就是 app 自己画的那种小方块 LED 灯珠。
- **控制台**：`WebChromeClient.onConsoleMessage` 把网页 console 全转发到 Logcat，
  排查靠 `adb logcat -s PixelBead`。
