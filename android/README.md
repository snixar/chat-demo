# Android 应用

把 `dist/` 打进单 Activity 的 WebView 壳，产出可安装的 APK。页面本身与网页版完全相同，原生层只补上 WebView 缺少的能力。

## 构建

需要：

- JDK 17 或更高（`javac`、`keytool`）
- Android SDK，包含 `build-tools;36.0.0` 与 `platforms;android-34`
- Python 3（往 APK 里追加 `classes.dex`）

```sh
export ANDROID_SDK_ROOT=$HOME/Android/sdk
pnpm android          # 产物：android/build/chat-demo-<version>.apk
pnpm android:debug    # 调试签名 + debuggable，用于 WebView 远程调试
```

`release` 构建必须提供签名库口令，未设置 `KEYSTORE_PASSWORD` 时脚本直接失败，不会用默认口令生成签名库——签名库一旦以公开口令创建，任何拿到该文件的人都能签出被系统视为同一应用的升级包。首次构建会用该口令在 `android/.keystore/` 生成签名库。**这个文件与口令必须一起备份**：换签名后已安装的应用无法覆盖升级。

```sh
export KEYSTORE_PASSWORD='<自选口令>'
pnpm android
```

其余环境变量：

| 变量                  | 默认值                          |
| --------------------- | ------------------------------- |
| `ANDROID_SDK_ROOT`    | `~/Android/sdk`                 |
| `BUILD_TOOLS_VERSION` | `36.0.0`                        |
| `KEYSTORE`            | `android/.keystore/release.jks` |
| `KEYSTORE_PASSWORD`   | 无（release 必填）              |
| `KEYSTORE_ALIAS`      | `chat-demo`                     |

`build-tools 34` 自带的 D8 8.2.2 处理 enum 时会内部崩溃，因此脚本默认用 36。

构建步骤是 `aapt2 compile → aapt2 link → javac → d8 → zipalign → apksigner`，全部直接调用 SDK 工具，不需要 Gradle、AndroidX 或网络。

## 为什么不用 file://

WebView 在 `file://` 下会禁用 IndexedDB、按目录隔离 localStorage，且 `fetch` 受同源策略限制，会话历史和附件都会失效。

`AssetServer` 拦截发往 `https://appassets.androidplatform.net/` 的请求并从 `assets/www` 读取文件，等价于 AndroidX 的 `WebViewAssetLoader`。页面于是拥有正常的 https 源，存储、Blob、`crypto.randomUUID` 和跨域请求都与浏览器一致。API 服务会反射该 Origin，无需额外代理。

## 原生补上的能力

| 能力         | 实现                                                                 |
| ------------ | -------------------------------------------------------------------- |
| 返回键       | `__androidHandleBack` 依次关闭弹窗 → 搜索结果 → 侧边栏，再退出       |
| 导出会话 ZIP | `blob:` 无法交给系统，页面分块传字节，原生落盘后走系统保存位置选择器 |
| 打开附件     | 同上，落盘后用 `content://` 交给对应应用打开                         |
| 选择文件     | `onShowFileChooser` 接系统文件选择器，支持多选                       |
| 语音输入     | `onPermissionRequest` 处理麦克风授权，首次使用时请求 `RECORD_AUDIO`  |
| 系统栏配色   | 页面主题变化时通过桥同步状态栏 / 导航栏深浅色                        |
| 安全区       | `body.is-native-app` 按 `env(safe-area-inset-*)` 给 `#root` 留白     |

`src/services/native.ts` 是这些桥接的适配层：浏览器中所有函数退化为默认行为，不改变网页版。

## 目录

```text
android/
  AndroidManifest.xml
  build.sh                         构建脚本
  res/                             图标、主题、文案
  src/com/deepseek/chatdemo/
    MainActivity.java              WebView 宿主、文件选择、麦克风、返回键
    AssetServer.java               assets → https 源映射
    BlobBridge.java                Blob 落盘与 content:// 投递
    BlobProvider.java              最小 ContentProvider（查看器读取文件）
```

## 已知限制

- 不包含 AndroidX，因此没有 `FileProvider`、SplashScreen API 等；文件投递用自写的最小 `ContentProvider`。
- 只有 arm64 / x86 通用的 Java 代码，APK 不含 native 库，可在任意 ABI 安装。
- `allowBackup=false`：会话数据只存在于设备上，迁移请用设置里的导出 / 导入。

## MCP 支持

设置 → 扩展 → MCP 服务器可添加外部 MCP 服务器，支持两种传输：

| 传输 | 说明 |
| --- | --- |
| Streamable HTTP | 所有消息 POST 到同一 endpoint，响应可为 JSON 或 SSE 流（2025-03-26 推荐） |
| SSE | 先 GET 建立长连接，服务端用 `endpoint` 事件给出 POST 地址（2024-11-05 旧方式） |

工具会以 `mcp__<serverId>__<toolName>` 的名字声明给模型；模型返回 `tool_use` 后由页面执行，结果作为 `tool_result` 回传，模型继续生成，最多 6 轮。

`HttpBridge` 用原生 `HttpURLConnection` 代发请求：浏览器 `fetch` 受同源策略约束，而 MCP 服务器通常不返回 CORS 头；APK 也默认禁止明文 `http://`。原生桥同时支持流式推送，SSE 长连接因此可用。`network_security_config.xml` 仅对 `localhost`、`127.0.0.1`、`10.0.2.2` 放开明文，主 API 仍强制 HTTPS。

测试连接会真正握手并列出工具；连不上的服务器不影响对话，只是这轮没有对应工具。
