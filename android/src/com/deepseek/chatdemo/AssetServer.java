package com.deepseek.chatdemo;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 把打包进 assets/www 的静态站点映射到 https://appassets.androidplatform.net/。
 *
 * 不使用 file://：WebView 在 file:// 下会禁用 IndexedDB、localStorage 按目录隔离，
 * 且 fetch 受同源策略限制。用 https 自定义域提供页面后，会话存储、Blob、crypto.randomUUID
 * 与 API 的跨域请求都与普通网页一致。
 */
public final class AssetServer extends WebViewClient {

    public static final String HOST = "appassets.androidplatform.net";
    public static final String START_URL = "https://" + HOST + "/index.html";

    /** assets 下静态站点的根目录 */
    private static final String ASSET_ROOT = "www";

    private static final Map<String, String> MIME_TYPES = new HashMap<>();

    static {
        MIME_TYPES.put("html", "text/html");
        MIME_TYPES.put("js", "application/javascript");
        MIME_TYPES.put("mjs", "application/javascript");
        MIME_TYPES.put("css", "text/css");
        MIME_TYPES.put("json", "application/json");
        MIME_TYPES.put("map", "application/json");
        MIME_TYPES.put("svg", "image/svg+xml");
        MIME_TYPES.put("png", "image/png");
        MIME_TYPES.put("jpg", "image/jpeg");
        MIME_TYPES.put("jpeg", "image/jpeg");
        MIME_TYPES.put("gif", "image/gif");
        MIME_TYPES.put("webp", "image/webp");
        MIME_TYPES.put("ico", "image/x-icon");
        MIME_TYPES.put("woff", "font/woff");
        MIME_TYPES.put("woff2", "font/woff2");
        MIME_TYPES.put("ttf", "font/ttf");
        MIME_TYPES.put("otf", "font/otf");
        MIME_TYPES.put("wasm", "application/wasm");
        MIME_TYPES.put("txt", "text/plain");
        MIME_TYPES.put("licence", "text/plain");
        MIME_TYPES.put("license", "text/plain");
    }

    private final Context context;
    private final BlobBridge bridge;

    AssetServer(Context context, BlobBridge bridge) {
        this.context = context.getApplicationContext();
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!HOST.equals(uri.getHost())) {
            return null;
        }
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        // 目录穿越与查询串都在这里挡掉：只允许 assets/www 内的普通文件。
        if (path.contains("..")) {
            return notFound();
        }
        String assetPath = ASSET_ROOT + path;
        AssetManager assets = context.getAssets();
        try {
            InputStream stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
            return new WebResourceResponse(mimeType(path), isText(path) ? "utf-8" : null, stream);
        } catch (IOException e) {
            // 单页应用没有服务端路由：未知路径回退到 index.html 交给前端展示。
            if (mimeType(path).startsWith("text/html") || !hasExtension(path)) {
                try {
                    return new WebResourceResponse(
                            "text/html", "utf-8", assets.open(ASSET_ROOT + "/index.html"));
                } catch (IOException ignored) {
                    // 连入口页都缺失时按 404 处理。
                }
            }
            return notFound();
        }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (HOST.equals(uri.getHost())) {
            return false;
        }
        if ("blob".equals(uri.getScheme())) {
            // blob 由页面内的脚本读取字节后交给原生打开，原生无法直接访问该地址。
            bridge.openWebBlob(uri.toString());
            return true;
        }
        return bridge.openExternally(uri);
    }

    @Override
    public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
        // 原生桥的准入状态在主线程维护；桥方法运行在 JavaBridge 线程，
        // 直接调用 webView.getUrl() 会抛 “WebView method called on wrong thread”。
        bridge.setTrustedPage(isSiteUrl(url));
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        bridge.setTrustedPage(isSiteUrl(url));
    }

    /** 是否为打包站点的页面 */
    private static boolean isSiteUrl(String url) {
        return url != null && url.startsWith("https://" + HOST + "/");
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse(
                "text/plain", "utf-8", 404, "Not Found", null,
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static boolean hasExtension(String path) {
        int slash = path.lastIndexOf('/');
        return path.indexOf('.', slash + 1) >= 0;
    }

    private static String extension(String path) {
        int dot = path.lastIndexOf('.');
        return dot < 0 ? "" : path.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String mimeType(String path) {
        String mime = MIME_TYPES.get(extension(path));
        return mime == null ? "application/octet-stream" : mime;
    }

    private static boolean isText(String path) {
        String mime = mimeType(path);
        return mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                || mime.contains("xml");
    }
}
