package com.byd.pixelbead;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * PBSBridge —— 注入给网页的 JS 桥（网页侧见 studio 的 js/bridge.js）。
 *
 * 契约（改这里必须同步改 js/bridge.js，反之亦然）：
 *   String  version()                                                     壳版本号
 *   void    toast(String msg)                                             原生 Toast
 *   boolean sendFrame(String base64Frame, String metaJson)                 保存 + 转发到 96×48 屏
 *   boolean saveFile(String fileName, String base64Content, String mime)
 *   boolean saveDataUrl(String fileName, String dataUrl)
 *
 * 所有返回 boolean 的方法：true = 成功。网页侧拿不到异常，只能看返回值。
 *
 * 注意 @JavascriptInterface 是必须的。Android 4.2 以后不带这个注解的方法，
 * JS 侧看到的是 undefined —— 网页里的 typeof 判断会直接走浏览器兜底分支，
 * 表现就是"点了没反应 / 东西下到浏览器里去了"。
 */
public class PBSBridge {

    public static final String TAG = "PBSBridge";

    /** 帧广播：车机内其它 App / 服务想接这块屏，监听这个 action 就行 */
    public static final String ACTION_PANEL_FRAME = "com.byd.pixelbead.PANEL_FRAME";
    public static final String EXTRA_FRAME = "frame";
    public static final String EXTRA_META = "meta";

    /** 系统「下载」目录下的子目录名 */
    public static final String DIR_NAME = "PixelBead";

    private final Context ctx;         // Application Context，用来写 MediaStore
    private final Activity activity;   // 只用来弹 Toast
    private final SimpleDateFormat stamp = new SimpleDateFormat("MMdd-HHmmss", Locale.US);

    public PBSBridge(Activity activity) {
        this.activity = activity;
        this.ctx = activity.getApplicationContext();
    }

    /* ======================= 基础 ======================= */

    @JavascriptInterface
    public String version() {
        return "1.0";
    }

    @JavascriptInterface
    public void toast(final String msg) {
        Log.i(TAG, "toast: " + msg);
        activity.runOnUiThread(() -> {
            try { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show(); } catch (Exception ignore) { }
        });
    }

    /* ======================= 下发帧 ======================= */

    /**
     * 网页点「发送到屏幕」会走到这里。
     * 做两件事：① 落盘到 下载/PixelBead  ② 转发给点阵屏（见 forwardFrameToPanel）
     *
     * @param base64Frame RLE 打包后的完整帧
     *                    协议：A5 5A | ver | cmd | cols | rows | colors | flags | RGB565 | RLE | CRC16
     * @param metaJson    形如 {"title":"..","cols":96,"rows":48,"colors":n,"frameBytes":n,
     *                    "payloadBytes":n,"saved":"99","rle":true,"protocol":"..","createdAt":".."}
     */
    @JavascriptInterface
    public boolean sendFrame(String base64Frame, String metaJson) {
        Log.i(TAG, "sendFrame meta=" + metaJson + " base64Len=" + (base64Frame == null ? 0 : base64Frame.length()));

        byte[] frame = decode(base64Frame);
        if (frame == null || frame.length == 0) {
            Log.e(TAG, "sendFrame: 帧解码失败");
            return false;
        }

        String name = "frame-" + stamp.format(new Date()) + ".bin";
        boolean saved = writeToDownload(name, frame, "application/octet-stream");
        boolean forwarded = forwardFrameToPanel(frame, metaJson);

        if (saved) {
            toast("帧已存到 下载/" + DIR_NAME + "/" + name + "（" + frame.length + "B）");
        } else {
            toast("帧写入失败，请看 Logcat");
        }
        return saved && forwarded;
    }

    /* ======================= 保存文件 ======================= */

    @JavascriptInterface
    public boolean saveFile(String fileName, String base64Content, String mimeType) {
        byte[] data = decode(base64Content);
        if (data == null) {
            Log.e(TAG, "saveFile: base64 解码失败 " + fileName);
            return false;
        }
        String mime = (mimeType == null || mimeType.isEmpty()) ? "application/octet-stream" : mimeType;
        boolean ok = writeToDownload(sanitize(fileName), data, mime);
        Log.i(TAG, "saveFile " + fileName + " (" + data.length + "B, " + mime + ") -> " + ok);
        return ok;
    }

    @JavascriptInterface
    public boolean saveDataUrl(String fileName, String dataUrl) {
        if (dataUrl == null) return false;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) {
            Log.e(TAG, "saveDataUrl: 不是 dataURL");
            return false;
        }
        String head = dataUrl.substring(0, comma);              // data:image/png;base64
        String mime = "application/octet-stream";
        int colon = head.indexOf(':');
        int semi = head.indexOf(';');
        if (colon >= 0 && semi > colon) mime = head.substring(colon + 1, semi);

        byte[] data = decode(dataUrl.substring(comma + 1));
        if (data == null) return false;
        boolean ok = writeToDownload(sanitize(fileName), data, mime);
        Log.i(TAG, "saveDataUrl " + fileName + " (" + data.length + "B, " + mime + ") -> " + ok);
        return ok;
    }

    /* ======================= 落盘：下载/PixelBead ======================= */

    /**
     * API 29+ 的分区存储：往公共「下载」目录写必须走 MediaStore，
     * 直接 File 写 /sdcard/Download 会 EACCES。
     * RELATIVE_PATH 用 Download/PixelBead，文件管理器里就能看到这个文件夹。
     */
    public boolean writeToDownload(String fileName, byte[] data, String mime) {
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeForMediaStore(fileName, mime));
        cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + DIR_NAME);
        cv.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri item = null;
        try {
            item = ctx.getContentResolver().insert(collection, cv);
            if (item == null) {
                Log.e(TAG, "MediaStore.insert 返回 null: " + fileName);
                return false;
            }
            try (OutputStream os = ctx.getContentResolver().openOutputStream(item, "w")) {
                if (os == null) throw new IllegalStateException("openOutputStream = null");
                os.write(data);
                os.flush();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            ctx.getContentResolver().update(item, done, null, null);
            Log.i(TAG, "已写入 下载/" + DIR_NAME + "/" + fileName + "  uri=" + item);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "写文件失败: " + fileName, e);
            if (item != null) {
                try { ctx.getContentResolver().delete(item, null, null); } catch (Exception ignore) { }
            }
            return false;
        }
    }

    /**
     * MediaStore 会"顺手"把文件名改成和 MIME 匹配的扩展名 ——
     * 实测 `bead_art.h` + `text/plain` 落盘变成 `bead_art.h.txt`，
     * 硬件同事拿到这个文件名会骂人。`text/plain` 的规范扩展名是 `.txt`，
     * `.h` 不在 MimeTypeMap 里，于是被追加了一个。
     *
     * 规则：扩展名和 MIME 能对上才把 MIME 交给 MediaStore，
     * 对不上（.h / .ino / .bin ...）一律用 application/octet-stream，
     * 这样 MediaStore 不会自作主张改名字。
     */
    private static String mimeForMediaStore(String fileName, String mime) {
        String ext = extensionOf(fileName);
        if (ext.isEmpty()) return "application/octet-stream";
        String fromExt = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (fromExt == null) return "application/octet-stream";          // .h 这种，别让系统猜
        String canonicalExt = android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        if (canonicalExt != null && canonicalExt.equalsIgnoreCase(ext)) return mime;
        // 扩展名和 MIME 对不上就用 fromExt，实在不行退回 octet-stream
        return fromExt;
    }

    private static String extensionOf(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        return (dot < 0 || dot == name.length() - 1) ? "" : name.substring(dot + 1).toLowerCase(Locale.US);
    }

    /* ======================= ★ 硬件同事的缝合点 ★ ======================= */

    /**
     * 把已经打包好的帧推给 96×48 点阵屏。
     *
     * 现在只打日志 + 发一条 App 内广播 —— 这就是留给硬件同事的接口。
     * 帧本身已经完备（尺寸、调色板、RLE、CRC16 都在里面），接的时候不用再碰网页。
     *
     * 接串口（USB / UART）：
     *     SerialTransport.get().write(frame);
     * 接 BLE：
     *     BleTransport.get().send(frame);          // 帧通常 &lt; 512B，普通 MTU 分包即可
     * 接车机总线（CAN / 私有 IPC）：
     *     监听 ACTION_PANEL_FRAME 广播，或把下面的 sendBroadcast 换成你的接口调用。
     *
     * @return true 表示帧已经交出去（现在是"已打日志 + 已广播"）
     */
    public boolean forwardFrameToPanel(byte[] frame, String metaJson) {
        Log.i(TAG, "══════════ 下发 96×48 点阵屏 ══════════");
        Log.i(TAG, "meta  : " + metaJson);
        Log.i(TAG, "frame : " + frame.length + " bytes  head=" + hex(frame, 24));
        Log.i(TAG, "TODO(硬件): 把 frame 交给 SerialTransport / BleTransport 发出去");

        try {
            Intent it = new Intent(ACTION_PANEL_FRAME);
            it.setPackage(ctx.getPackageName());
            it.putExtra(EXTRA_FRAME, frame);
            it.putExtra(EXTRA_META, metaJson);
            ctx.sendBroadcast(it);
        } catch (Exception e) {
            Log.w(TAG, "广播帧失败（不影响其它功能）", e);
        }
        return true;
    }

    /* ======================= 小工具 ======================= */

    private static byte[] decode(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        try {
            return Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** 文件名消毒：网页那边已经处理过一次，这里再兜一次（防路径穿越之类） */
    private static String sanitize(String name) {
        if (name == null || name.trim().isEmpty()) return "pixelbead-" + System.currentTimeMillis();
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0 && name.length() - dot <= 6) ext = name.substring(dot);
        String s = name.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
        if (s.length() > 64) s = s.substring(0, 64 - ext.length()) + ext;
        return s;
    }

    private static String hex(byte[] b, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(n, b.length); i++) sb.append(String.format(Locale.US, "%02X ", b[i]));
        return sb.toString().trim();
    }
}
