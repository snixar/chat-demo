package com.deepseek.chatdemo;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewDatabase;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 单 Activity 的 WebView 壳。
 *
 * 页面资源由 AssetServer 以 https://appassets.androidplatform.net/ 提供，
 * 因此 IndexedDB、localStorage、Blob 与跨域请求都按普通网页的规则工作。
 */
public final class MainActivity extends Activity {

    static final String EXTRA_BLOB_TOKEN = "com.deepseek.chatdemo.BLOB_SOURCE";
    /** 等待保存的临时文件路径；ACTION_CREATE_DOCUMENT 的结果里只带回目标 Uri */
    String pendingSavePath;

    private static final int REQUEST_FILE = 1001;
    private static final int REQUEST_MIC = 1002;
    static final int REQUEST_SAVE = 1003;

    /** 让用户选择归档保存位置；结果在 onActivityResult 里复制临时文件 */
    static Intent saveIntent(String mime, String name) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        return intent;
    }

    private WebView webView;
    private BlobBridge bridge;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest micRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BlobBridge.clearCache(this);
        // 关掉 WebView 的本地数据加密弹窗与自动填充，避免首次启动时的额外提示
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
        }

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);
        setContentView(root);
        applySystemBarTheme(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        // 页面按 <meta name="viewport"> 排版，固定为不缩放，配合前端移动端布局
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);

        bridge = new BlobBridge(this, webView);
        webView.addJavascriptInterface(bridge, "AndroidShell");
        webView.setWebViewClient(new AssetServer(this, bridge));
        webView.setWebChromeClient(new ChromeClient());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) ->
                bridge.openWebBlob(url));

        if (savedInstanceState == null) {
            webView.loadUrl(AssetServer.START_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    /** 系统栏配色跟随页面主题；页面在 theme.ts 里切换深浅色后调用 */
    void applySystemBarTheme(boolean dark) {
        int color = getColor(dark ? R.color.app_window_background_dark : R.color.app_window_background);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        if (dark) {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        } else {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        decor.setSystemUiVisibility(flags);
    }

    private final class ChromeClient extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // 页面按扩展名自行校验格式，这里放开类型让系统能选到任意文档
            intent.setType("*/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)),
                        REQUEST_FILE);
                return true;
            } catch (android.content.ActivityNotFoundException e) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsAudio = false;
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    wantsAudio = true;
                }
            }
            if (!wantsAudio) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                return;
            }
            // 保留请求，等运行时权限结果回来再决定
            micRequest = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (micRequest == request) {
                micRequest = null;
            }
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage message) {
            android.util.Log.d("ChatDemoWeb", message.message()
                    + " @" + message.sourceId() + ":" + message.lineNumber());
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_MIC || micRequest == null) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            micRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            micRequest.deny();
        }
        micRequest = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE) {
            if (fileCallback == null) {
                return;
            }
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        result[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        if (requestCode == REQUEST_SAVE) {
            String path = pendingSavePath;
            pendingSavePath = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && path != null) {
                BlobBridge.copyToUri(this, path, data.getData());
            } else if (path != null) {
                // 用户取消保存：删掉临时文件
                //noinspection ResultOfMethodCallIgnored
                new java.io.File(path).delete();
            }
            return;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    public void onBackPressed() {
        // 先让页面处理：关闭设置弹窗、侧边栏或搜索结果等浮层
        webView.evaluateJavascript(
                "(window.__androidHandleBack && window.__androidHandleBack()) ? '1' : '0'",
                value -> {
                    if (!"\"1\"".equals(value) && !"1".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidShell");
            webView.destroy();
        }
        super.onDestroy();
    }
}
