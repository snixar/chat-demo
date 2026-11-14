package com.deepseek.chatdemo;

import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生 HTTP 转发，供页面的 MCP 客户端使用。
 *
 * 浏览器 fetch 受同源策略约束，而 MCP 服务器（多为 localhost、局域网或自建服务）
 * 通常不返回 CORS 头；APK 又默认禁止明文 http。这里用 HttpURLConnection 代发请求，
 * 由原生侧完成 DNS、连接与读取，页面只拿到状态码与响应体。
 */
public final class HttpBridge {

    private static final String TAG = "ChatDemoHttp";
    /** 响应体上限，防止误连大文件把内存吃满 */
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT = 15_000;
    private static final int READ_TIMEOUT = 120_000;

    private final MainActivity activity;
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    /** 进行中的流式请求，用于 cancel 与去重 */
    private final java.util.concurrent.ConcurrentHashMap<String, HttpURLConnection> streams =
            new java.util.concurrent.ConcurrentHashMap<>();
    private volatile boolean destroyed = false;

    HttpBridge(MainActivity activity) {
        this.activity = activity;
    }

    /**
     * 代发一次 HTTP 请求。参数是 JSON 字符串：
     * { url, method, headers: {...}, body: string|null, requestId, stream }
     *
     * 普通请求把完整响应一次性回传；stream 为 true 时（SSE 等长连接）边读边推，
     * 页面侧收到的是增量文本，直到流结束或调用 cancel。
     */
    @JavascriptInterface
    public void request(String argument) {
        if (destroyed) {
            return;
        }
        final JSONObject args;
        final String requestId;
        try {
            args = new JSONObject(argument);
            requestId = args.optString("requestId", "");
        } catch (JSONException e) {
            Log.w(TAG, "bad request json", e);
            return;
        }
        if (requestId.isEmpty()) {
            return;
        }
        if (args.optBoolean("stream", false)) {
            streamRequest(args, requestId);
            return;
        }
        executor.execute(() -> {
            String response;
            try {
                response = perform(args);
            } catch (Exception e) {
                Log.w(TAG, "request failed", e);
                response = errorJson(e.getMessage());
            }
            final String payload = response;
            activity.runOnUiThread(() -> activity.deliverHttpResult(requestId, payload));
        });
    }

    /** 对应页面的 AbortSignal：中断时关闭连接，读循环随之结束 */
    @JavascriptInterface
    public void cancel(String requestId) {
        HttpURLConnection active = streams.remove(requestId);
        if (active != null) {
            active.disconnect();
        }
    }

    /**
     * 流式请求：先回传状态行与响应头，之后每读到一段文本就推一次增量，
     * 结束时推 streamEnd。页面据此拼出与 fetch 相同的 Response 行为。
     */
    private void streamRequest(JSONObject args, String requestId) {
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                String url = args.getString("url");
                String method = args.optString("method", "GET");
                String body = args.isNull("body") ? null : args.optString("body", null);
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setRequestMethod(method);
                connection.setConnectTimeout(CONNECT_TIMEOUT);
                // 流式连接不设读超时：服务端可能长时间没有新事件（保活注释除外）
                connection.setReadTimeout(0);
                connection.setInstanceFollowRedirects(false);
                connection.setDoInput(true);
                JSONObject headers = args.optJSONObject("headers");
                if (headers != null) {
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String name = it.next();
                        if (name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length")) {
                            continue;
                        }
                        connection.setRequestProperty(name, headers.optString(name, ""));
                    }
                }
                if (body != null && !body.isEmpty()) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(bytes);
                    }
                }
                streams.put(requestId, connection);
                int status = connection.getResponseCode();
                JSONObject head = new JSONObject();
                head.put("status", status);
                String statusText = connection.getResponseMessage();
                head.put("statusText", statusText == null ? "" : statusText);
                JSONObject responseHeaders = new JSONObject();
                for (java.util.Map.Entry<String, java.util.List<String>> entry
                        : connection.getHeaderFields().entrySet()) {
                    String name = entry.getKey();
                    if (name == null || entry.getValue() == null || entry.getValue().isEmpty()) {
                        continue;
                    }
                    responseHeaders.put(name, entry.getValue().get(0));
                }
                head.put("headers", responseHeaders);
                final String headPayload = head.toString();
                activity.runOnUiThread(() -> activity.deliverHttpHead(requestId, headPayload));

                InputStream stream = status >= 400
                        ? connection.getErrorStream()
                        : connection.getInputStream();
                if (stream != null) {
                    try (InputStream in = stream) {
                        byte[] buffer = new byte[8 * 1024];
                        int read;
                        while ((read = in.read(buffer)) > 0) {
                            if (destroyed || !streams.containsKey(requestId)) {
                                break;
                            }
                            String chunk = new String(buffer, 0, read, StandardCharsets.UTF_8);
                            activity.runOnUiThread(
                                    () -> activity.deliverHttpChunk(requestId, chunk));
                        }
                    }
                }
                activity.runOnUiThread(() -> activity.deliverHttpEnd(requestId));
            } catch (Exception e) {
                Log.w(TAG, "stream failed", e);
                final String message = e.getMessage() == null ? "stream failed" : e.getMessage();
                activity.runOnUiThread(() -> activity.deliverHttpError(requestId, message));
            } finally {
                streams.remove(requestId);
                if (connection != null) {
                    connection.disconnect();
                }
            }
        });
    }

    private String perform(JSONObject args) throws IOException, JSONException {
        String url = args.getString("url");
        String method = args.optString("method", "GET");
        String body = args.isNull("body") ? null : args.optString("body", null);

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT);
            connection.setReadTimeout(READ_TIMEOUT);
            // 不自动跟随重定向：MCP 的 endpoint 语义依赖原始响应
            connection.setInstanceFollowRedirects(false);
            connection.setDoInput(true);

            JSONObject headers = args.optJSONObject("headers");
            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String name = it.next();
                    String value = headers.optString(name, "");
                    // Host、Content-Length 由连接自己计算，跳过以免被底层拒绝
                    if (name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length")) {
                        continue;
                    }
                    connection.setRequestProperty(name, value);
                }
            }

            if (body != null && !body.isEmpty()) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }

            int status = connection.getResponseCode();
            String contentType = connection.getContentType();
            boolean textual = contentType == null
                    || contentType.contains("json")
                    || contentType.contains("text")
                    || contentType.contains("xml")
                    || contentType.contains("javascript");

            InputStream stream = status >= 400
                    ? connection.getErrorStream()
                    : connection.getInputStream();
            byte[] raw = readLimited(stream);

            JSONObject result = new JSONObject();
            result.put("status", status);
            String statusText = connection.getResponseMessage();
            result.put("statusText", statusText == null ? "" : statusText);
            JSONObject responseHeaders = new JSONObject();
            for (java.util.Map.Entry<String, java.util.List<String>> entry
                    : connection.getHeaderFields().entrySet()) {
                String name = entry.getKey();
                if (name == null || entry.getValue() == null || entry.getValue().isEmpty()) {
                    continue;
                }
                responseHeaders.put(name, entry.getValue().get(0));
            }
            result.put("headers", responseHeaders);
            if (raw.length > 0) {
                if (textual) {
                    result.put("body", new String(raw, StandardCharsets.UTF_8));
                } else {
                    result.put("body", Base64.encodeToString(raw, Base64.NO_WRAP));
                    result.put("bodyBase64", true);
                }
            }
            return result.toString();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static byte[] readLimited(InputStream stream) throws IOException {
        if (stream == null) {
            return new byte[0];
        }
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                total += read;
                if (total > MAX_BODY) {
                    out.write(buffer, 0, read - (total - MAX_BODY));
                    break;
                }
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    private static String errorJson(String message) {
        try {
            JSONObject result = new JSONObject();
            result.put("status", 0);
            result.put("error", message == null ? "request failed" : message);
            return result.toString();
        } catch (JSONException e) {
            return "{\"status\":0,\"error\":\"request failed\"}";
        }
    }

    void shutdown() {
        destroyed = true;
        executor.shutdownNow();
    }
}
