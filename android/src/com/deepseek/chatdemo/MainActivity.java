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
    private static final int REQUEST_CAMERA = 1004;
    private static final int REQUEST_GALLERY = 1005;

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
    private HttpBridge httpBridge;
    /** 拍照时写入的 MediaStore Uri 与等待回传的请求 id */
    private Uri pendingPhotoUri;
    private String pendingPhotoRequest;
    private String pendingGalleryRequest;
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
        httpBridge = new HttpBridge(this);
        webView.addJavascriptInterface(bridge, "AndroidShell");
        webView.addJavascriptInterface(httpBridge, "AndroidMcp");
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

    /**
     * 把原生 HTTP 的结果送回页面：页面在 window.__mcpFetchCallbacks 里按 id 注册了 resolver。
     * 用 evaluateJavascript 而不是 addJavascriptInterface 回调，避免把结果编码进参数列表。
     */
    void deliverHttpResult(String requestId, String payload) {
        webView.evaluateJavascript(
                "window.__mcpFetchResult && window.__mcpFetchResult("
                        + jsString(requestId) + "," + jsString(payload) + ")",
                null);
    }

    /** 流式响应：状态行与响应头先到 */
    void deliverHttpHead(String requestId, String payload) {
        webView.evaluateJavascript(
                "window.__mcpFetchHead && window.__mcpFetchHead("
                        + jsString(requestId) + "," + jsString(payload) + ")",
                null);
    }

    /** 流式响应：增量文本 */
    void deliverHttpChunk(String requestId, String chunk) {
        webView.evaluateJavascript(
                "window.__mcpFetchChunk && window.__mcpFetchChunk("
                        + jsString(requestId) + "," + jsString(chunk) + ")",
                null);
    }

    void deliverHttpEnd(String requestId) {
        webView.evaluateJavascript(
                "window.__mcpFetchEnd && window.__mcpFetchEnd(" + jsString(requestId) + ")",
                null);
    }

    void deliverHttpError(String requestId, String message) {
        webView.evaluateJavascript(
                "window.__mcpFetchError && window.__mcpFetchError("
                        + jsString(requestId) + "," + jsString(message) + ")",
                null);
    }

    private static String jsString(String value) {
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case '<': out.append("\\u003c"); break;
                case '>': out.append("\\u003e"); break;
                case '&': out.append("\\u0026"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
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
        if (requestCode == REQUEST_CAMERA) {
            String requestId = pendingPhotoRequest;
            Uri photo = pendingPhotoUri;
            pendingPhotoRequest = null;
            pendingPhotoUri = null;
            if (resultCode != RESULT_OK || photo == null) {
                if (photo != null) {
                    // 取消拍照：删掉占位的空记录
                    getContentResolver().delete(photo, null, null);
                }
                deliverPickedFile(requestId, (byte[]) null, null, null);
                return;
            }
            deliverPickedFile(requestId, photo);
            return;
        }
        if (requestCode == REQUEST_GALLERY) {
            String requestId = pendingGalleryRequest;
            pendingGalleryRequest = null;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (uri == null) {
                deliverPickedFile(requestId, (byte[]) null, null, null);
                return;
            }
            deliverPickedFile(requestId, uri);
            return;
        }
    }

    /**
     * 拍照。系统相机需要能写入目标 Uri，自己注册的 ContentProvider 是 exported=false、
     * 相机拿不到权限，因此改用 MediaStore 创建一张待写入的图片（相机可写）。
     */
    void startCamera(String requestId) {
        try {
            android.content.ContentValues values = new android.content.ContentValues();
            values.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME,
                    "chat-demo-" + System.currentTimeMillis() + ".jpg");
            values.put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH,
                        "Pictures/chat-demo");
            }
            Uri target = getContentResolver().insert(
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (target == null) {
                deliverPickedFile(requestId, (byte[]) null, null, null);
                return;
            }
            pendingPhotoUri = target;
            pendingPhotoRequest = requestId;
            Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, target);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(intent, REQUEST_CAMERA);
        } catch (Exception e) {
            android.util.Log.w("ChatDemo", "camera failed", e);
            pendingPhotoUri = null;
            pendingPhotoRequest = null;
            deliverPickedFile(requestId, (byte[]) null, null, null);
        }
    }

    /** 相册：系统图片选择器，单选 */
    void startGallery(String requestId) {
        pendingGalleryRequest = requestId;
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_image)),
                    REQUEST_GALLERY);
        } catch (android.content.ActivityNotFoundException e) {
            pendingGalleryRequest = null;
            deliverPickedFile(requestId, (byte[]) null, null, null);
        }
    }

    /** 把选中的图片读成 base64 回传页面 */
    void deliverPickedFile(String requestId, Uri uri) {
        if (requestId == null) {
            return;
        }
        try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) {
                deliverPickedFile(requestId, (byte[]) null, null, null);
                return;
            }
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            String mime = getContentResolver().getType(uri);
            deliverPickedFile(requestId, out.toByteArray(),
                    mime == null ? "image/*" : mime, "image");
        } catch (Exception e) {
            android.util.Log.w("ChatDemo", "read image failed", e);
            deliverPickedFile(requestId, (byte[]) null, null, null);
        }
    }

    /** 最终统一出口：把字节编码为 JSON 交给页面的 __androidPickedFile */
    void deliverPickedFile(String requestId, byte[] bytes, String mime, String name) {
        if (requestId == null) {
            return;
        }
        String payload = "";
        if (bytes != null && bytes.length > 0) {
            String ext = mime.contains("png") ? ".png" : mime.contains("webp") ? ".webp" : ".jpg";
            String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
            payload = "{\"name\":" + jsString(name.endsWith(ext) ? name : name + ext)
                    + ",\"mime\":" + jsString(mime) + ",\"base64\":" + jsString(b64) + "}";
        }
        final String json = payload;
        final String id = requestId;
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.__androidPickedFile && window.__androidPickedFile("
                        + jsString(id) + "," + jsString(json) + ")", null));
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
        if (httpBridge != null) {
            httpBridge.shutdown();
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidShell");
            webView.removeJavascriptInterface("AndroidMcp");
            webView.destroy();
        }
        super.onDestroy();
    }
}
