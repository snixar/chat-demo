package com.deepseek.chatdemo;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 页面与原生之间的桥。
 *
 * WebView 无法直接读取 blob: 地址（那是渲染进程内的数据），因此页面把字节分块以 base64
 * 传进来，这里落成临时文件，再用 content:// 交给系统保存或打开。
 */
public final class BlobBridge {

    private static final String TAG = "ChatDemoBridge";
    /** 单块 base64 解码后的上限，页面按此切分 */
    static final int CHUNK_BYTES = 512 * 1024;
    /**
     * 单个文件与所有未完成文件的写入上限。
     * 会话归档与附件原件都远小于此；设上限是为了在页面被注入脚本时
     * 不能无限往 cacheDir 写数据把设备存储占满。
     */
    private static final long MAX_FILE_BYTES = 512L * 1024 * 1024;
    private static final long MAX_PENDING_BYTES = 1024L * 1024 * 1024;

    /** open：交给查看器打开；save：让用户选择保存位置 */
    public enum Mode { OPEN, SAVE }

    private static final class Pending {
        final File file;
        final String name;
        final String mime;
        final Mode mode;
        FileOutputStream stream;
        /** 已写入字节数，用于总量控制 */
        long written;

        Pending(File file, String name, String mime, Mode mode) {
            this.file = file;
            this.name = name;
            this.mime = mime;
            this.mode = mode;
        }
    }

    private final Activity activity;
    private final WebView webView;
    private final ConcurrentHashMap<String, Pending> pending = new ConcurrentHashMap<>();
    /**
     * 当前页面是否为打包站点。
     * 只能在主线程更新（由 AssetServer 的页面回调写入），
     * 桥方法在 JavaBridge 线程读取 —— 不能在这里调 WebView 的任何方法。
     */
    private volatile boolean trustedPage = false;

    BlobBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /** 由 AssetServer 在页面导航时调用（主线程） */
    void setTrustedPage(boolean trusted) {
        this.trustedPage = trusted;
    }

    /** 只有打包站点自己的页面才能使用落盘、相机与 HTTP 转发接口 */
    boolean isTrustedPage() {
        return trustedPage;
    }

    private boolean isTrustedCaller() {
        return trustedPage;
    }

    /** 页面里下载会话归档时调用；返回 token，随后用 writeChunk / endFile 写入 */
    @JavascriptInterface
    public String beginFile(String name, String mime, boolean save) {
        // 与 HttpBridge 一致：只有打包站点自己的页面才能落盘到本应用缓存
        if (!isTrustedCaller()) {
            Log.w(TAG, "beginFile rejected: untrusted page");
            return "";
        }
        String safeName = name == null || name.trim().isEmpty() ? "download" : name.trim();
        // 文件名只用于展示与保存建议，路径分隔符一律替换，避免写到缓存目录之外。
        safeName = safeName.replace('/', '_').replace('\\', '_');
        String token = UUID.randomUUID().toString();
        File dir = new File(activity.getCacheDir(), "blobs");
        if (!dir.exists() && !dir.mkdirs()) {
            Log.w(TAG, "cannot create blob cache directory");
        }
        File target = new File(dir, token);
        try {
            Pending entry = new Pending(target, safeName,
                    mime == null || mime.isEmpty() ? "application/octet-stream" : mime,
                    save ? Mode.SAVE : Mode.OPEN);
            entry.stream = new FileOutputStream(target);
            pending.put(token, entry);
            return token;
        } catch (IOException e) {
            Log.e(TAG, "beginFile failed", e);
            return "";
        }
    }

    @JavascriptInterface
    public boolean writeChunk(String token, String base64) {
        Pending entry = pending.get(token);
        if (entry == null || entry.stream == null) {
            return false;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "writeChunk failed", e);
            abort(token);
            return false;
        }
        if (entry.written + bytes.length > MAX_FILE_BYTES || pendingBytes() + bytes.length > MAX_PENDING_BYTES) {
            Log.w(TAG, "writeChunk rejected: exceeds size limit");
            abort(token);
            return false;
        }
        try {
            entry.stream.write(bytes);
            entry.written += bytes.length;
            return true;
        } catch (IOException e) {
            Log.w(TAG, "writeChunk failed", e);
            abort(token);
            return false;
        }
    }

    /** 当前所有未完成文件已写入的字节总数 */
    private long pendingBytes() {
        long total = 0;
        for (Pending entry : pending.values()) {
            total += entry.written;
        }
        return total;
    }

    @JavascriptInterface
    public void endFile(String token) {
        Pending entry = pending.remove(token);
        if (entry == null) {
            return;
        }
        try {
            if (entry.stream != null) {
                entry.stream.close();
            }
        } catch (IOException e) {
            Log.w(TAG, "close failed", e);
        }
        BlobProvider.register(token, entry.file, entry.mime, entry.name);
        Uri uri = BlobProvider.uriFor(token);
        activity.runOnUiThread(() -> deliver(uri, entry));
    }

    @JavascriptInterface
    public void abortFile(String token) {
        abort(token);
    }

    private void abort(String token) {
        Pending entry = pending.remove(token);
        if (entry == null) {
            return;
        }
        try {
            if (entry.stream != null) {
                entry.stream.close();
            }
        } catch (IOException ignored) {
            // 清理临时文件失败不影响页面流程。
        }
        //noinspection ResultOfMethodCallIgnored
        entry.file.delete();
    }

    /** 页面打开 blob: 地址（附件原件）时由主进程回调，页面读取字节后交给原生 */
    void openWebBlob(String url) {
        activity.runOnUiThread(() -> webView.evaluateJavascript(
                "window.__androidOpenBlob && window.__androidOpenBlob(" + jsString(url) + ")", null));
    }

    /** 拍照：拉起系统相机，结果通过 __androidPickedFile 回传 */
    @JavascriptInterface
    public void takePhoto(String requestId) {
        activity.runOnUiThread(() -> ((MainActivity) activity).startCamera(requestId));
    }

    /** 相册：拉起系统图片选择器 */
    @JavascriptInterface
    public void pickImage(String requestId) {
        activity.runOnUiThread(() -> ((MainActivity) activity).startGallery(requestId));
    }

    /** 深色模式下同步系统栏配色 */
    @JavascriptInterface
    public void setTheme(boolean dark) {
        activity.runOnUiThread(() -> {
            if (activity instanceof MainActivity) {
                ((MainActivity) activity).applySystemBarTheme(dark);
            }
        });
    }

    private void deliver(Uri uri, Pending entry) {
        if (entry.mode == Mode.SAVE) {
            // 保存到用户选定的位置；临时文件路径记在 Activity 上，选择结果回来后再复制。
            MainActivity host = (MainActivity) activity;
            host.pendingSavePath = entry.file.getAbsolutePath();
            activity.startActivityForResult(MainActivity.saveIntent(entry.mime, entry.name),
                    MainActivity.REQUEST_SAVE);
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, entry.mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            activity.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.no_app_to_open, Toast.LENGTH_LONG).show();
        }
    }

    /** 转义为 JS 字符串字面量 */
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

    /** 清空上次运行留下的临时文件 */
    static void clearCache(Activity activity) {
        File dir = new File(activity.getCacheDir(), "blobs");
        File[] files = dir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    /** 把临时文件复制到用户选定的位置（ACTION_CREATE_DOCUMENT 的结果） */
    static void copyToUri(Activity activity, String sourcePath, Uri target) {
        File source = new File(sourcePath);
        if (!source.exists()) {
            return;
        }
        boolean copied = false;
        try {
            // openOutputStream 返回的是任意 OutputStream，强转 FileOutputStream 会 ClassCastException；
            // 目标 Uri 也可能因权限或 provider 问题抛 SecurityException。
            try (java.io.OutputStream out = activity.getContentResolver().openOutputStream(target);
                 RandomAccessFile in = new RandomAccessFile(source, "r")) {
                if (out == null) {
                    throw new IOException("content resolver returned no stream");
                }
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                }
                out.flush();
            }
            copied = true;
            Toast.makeText(activity, R.string.saved, Toast.LENGTH_SHORT).show();
        } catch (IOException | SecurityException | IllegalArgumentException | ClassCastException e) {
            Log.e(TAG, "copyToUri failed", e);
            Toast.makeText(activity, R.string.save_failed, Toast.LENGTH_LONG).show();
        } finally {
            // 复制失败时保留临时文件，用户可以在原位置重新触发保存。
            if (copied) {
                //noinspection ResultOfMethodCallIgnored
                source.delete();
            }
        }
    }

    /** 外部链接交给系统浏览器 */
    boolean openExternally(Uri uri) {
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"mailto".equals(scheme)) {
            return true;
        }
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.no_app_to_open, Toast.LENGTH_SHORT).show();
        }
        return true;
    }
}
