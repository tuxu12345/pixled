package com.byd.pixelbead;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

/**
 * 拼豆工坊 · 车机壳
 *
 * 干的事其实很少：把 studio 那套纯前端原样装进 WebView，横屏全屏，接一根 JS 桥。
 * 网页一个字节都没改（app/src/main/assets/www 是 pixel-bead-studio 的同步副本）。
 *
 * 三个踩过的坑，这里逐个堵上：
 *   ① file:// 下 ES 模块被 CORS 拦 —— 所以不用 file://，改用 WebViewAssetLoader
 *      把 assets/www 以 https://appassets.androidplatform.net/assets/www/ 伺服出去。
 *      （顺带解决了 localStorage 在 file:// 下拿到 opaque origin 的问题）
 *   ② domStorageEnabled 必须 true —— 见 setupWebView()，否则 localStorage 直接抛，
 *      网页的 boot() 一挂，整个界面就是死的。
 *   ③ 触摸屏上画布必须能"画"而不是"拖" —— 网页侧 pointerdown preventDefault +
 *      touch-action:none 负责；这里再把 WebView 自己的滚动和长按选择关掉配合。
 */
public class MainActivity extends Activity {

    private static final String TAG = "PixelBead";

    /** WebViewAssetLoader 的虚拟域名（androidx.webkit 固定用这个） */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/assets/www/index.html";

    private static final int REQ_FILE_CHOOSER = 0x1001;

    private WebView web;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // 车机上别自己息屏
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.parseColor("#FF0B1017")));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#FF0B1017"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupWebView(web);
        root.addView(web);
        setContentView(root);

        /* debug 包开 WebView 远程调试：车机上排查网页问题全靠它。
           用法：adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
                然后 Chrome 打开 chrome://inspect（或直接用 CDP 连 9222）
           release 包不开，避免把调试口暴露出去。 */
        if (0 != (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)) {
            try {
                WebView.setWebContentsDebuggingEnabled(true);
                Log.i(TAG, "WebView 远程调试已开启（debug 包）");
            } catch (Exception e) {
                Log.w(TAG, "开 WebView 调试失败", e);
            }
        }

        goImmersive();
        web.loadUrl(START_URL);
    }

    /* ==================================================================
       WebView 配置
       ================================================================== */

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView(final WebView wv) {
        wv.setBackgroundColor(Color.parseColor("#FF0B1017"));

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // ← 坑 ②：不开这个 localStorage 抛异常，界面全死
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(true);              // 让页面里的 <meta viewport> 生效（响应式布局要用）
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                      // 车机系统字体放大不要影响布局
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setLongClickable(false);
        wv.setHapticFeedbackEnabled(false);
        wv.setOnLongClickListener(v -> true);    // 关掉长按选择/放大镜，不然画布上长按会弹菜单

        // JS 桥：网页侧全部 typeof 判断，这里不存在网页也能跑（走浏览器下载兜底）
        wv.addJavascriptInterface(new PBSBridge(this), "PBSBridge");

        // ---- assets/www 用 https:// 虚拟源伺服（解决 file:// 加载 ES 模块被拦） ----
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return loader.shouldInterceptRequest(Uri.parse(url));
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (("https".equals(scheme) || "http".equals(scheme)) && ASSET_HOST.equals(u.getHost())) {
                    return false;                 // 自家的虚拟源，放行
                }
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));   // 外链丢给系统浏览器
                    } catch (ActivityNotFoundException ignore) { }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "页面加载完成: " + url + "  桥=" + (view != null));
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            /* 网页里有「🖼 导入图片」→ <input type=file>，
               不实现这个回调的话车机上点了完全没反应。 */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                    pendingFileCallback = null;
                }
                pendingFileCallback = callback;

                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    pendingFileCallback = null;
                    Toast.makeText(MainActivity.this, R.string.pick_no_app, Toast.LENGTH_LONG).show();
                    Log.e(TAG, "没有文件选择器", e);
                    return false;
                }
            }

            /** 网页的 console 全部转发到 Logcat，车机上排查全靠它（adb logcat -s PixelBead PBSBridge） */
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                String tag = cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? "PixelBead.E" : "PixelBead";
                Log.println(cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.INFO,
                        tag, cm.message() + "  @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });
    }

    /* ==================================================================
       全屏沉浸（横屏车机）
       ================================================================== */

    private void goImmersive() {
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            decor.setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();   // 系统弹窗抢过焦点后会退出沉浸，这里抢回来
    }

    @Override
    protected void onResume() {
        super.onResume();
        goImmersive();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    /* ==================================================================
       文件选择器回调
       ================================================================== */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ==================================================================
       返回键
       ================================================================== */

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("PBSBridge");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
