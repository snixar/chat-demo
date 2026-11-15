#!/usr/bin/env bash
#
# 构建 Android APK：把 dist/ 打进 assets，用 aapt2 / javac / d8 / apksigner 手工打包。
#
# 不依赖 Gradle 与 AndroidX：本工程只用 android.jar 里的 API，因此整个工具链
# 只需要 build-tools 与一个 platform。
#
# 用法：
#   android/build.sh            # 构建 release APK
#   android/build.sh --debug    # 使用调试签名与 debuggable 清单
#
# 依赖环境变量（可选）：
#   ANDROID_SDK_ROOT  Android SDK 路径，默认 ~/Android/sdk
#   KEYSTORE          签名库路径，默认 android/.keystore/release.jks
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
OUT_DIR="$ANDROID_DIR/build"
SDK="${ANDROID_SDK_ROOT:-$HOME/Android/sdk}"
# build-tools 34 自带的 D8 8.2.2 处理 enum 会内部崩溃，需 36+
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-36.0.0}"
BUILD_TOOLS="$SDK/build-tools/$BUILD_TOOLS_VERSION"
PLATFORM="$SDK/platforms/android-34/android.jar"

DEBUG=0
[[ "${1:-}" == "--debug" ]] && DEBUG=1

for tool in aapt2 d8 zipalign apksigner; do
  if [[ ! -x "$BUILD_TOOLS/$tool" ]]; then
    echo "缺少构建工具：$BUILD_TOOLS/$tool" >&2
    echo "请先安装 Android build-tools $BUILD_TOOLS_VERSION 与 platform android-34。" >&2
    exit 1
  fi
done
[[ -f "$PLATFORM" ]] || { echo "缺少 $PLATFORM" >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/package.json').version")"
MAJOR="${VERSION%%.*}"
REST="${VERSION#*.}"
MINOR="${REST%%.*}"
PATCH="${REST#*.}"
VERSION_CODE=$((MAJOR * 10000 + MINOR * 100 + PATCH))

echo "==> 构建前端静态站点"
(cd "$ROOT" && pnpm build)

echo "==> 准备 assets"
rm -rf "$ANDROID_DIR/assets" "$OUT_DIR"
mkdir -p "$ANDROID_DIR/assets/www" "$OUT_DIR/compiled" "$OUT_DIR/gen" "$OUT_DIR/classes"
cp -R "$ROOT/dist/." "$ANDROID_DIR/assets/www/"

echo "==> 编译资源"
"$BUILD_TOOLS/aapt2" compile --dir "$ANDROID_DIR/res" -o "$OUT_DIR/compiled/"

MANIFEST="$ANDROID_DIR/AndroidManifest.xml"
MANIFEST_ARGS=(--manifest "$MANIFEST")
if [[ $DEBUG -eq 1 ]]; then
  # 调试构建：允许 WebView 远程调试，并用调试签名
  MANIFEST_ARGS+=(--debug-mode)
fi

echo "==> 链接资源与 assets（versionName=$VERSION, versionCode=$VERSION_CODE）"
"$BUILD_TOOLS/aapt2" link \
  -o "$OUT_DIR/unsigned.apk" \
  -I "$PLATFORM" \
  -A "$ANDROID_DIR/assets" \
  --java "$OUT_DIR/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION" \
  --auto-add-overlay \
  "${MANIFEST_ARGS[@]}" \
  "$OUT_DIR/compiled/"*.flat

echo "==> 编译 Java"
find "$ANDROID_DIR/src" "$OUT_DIR/gen" -name '*.java' > "$OUT_DIR/sources.txt"
# JDK 21 不再允许对 target 17 使用 -bootclasspath；android.jar 放在 classpath 上，
# 与 Android Gradle Plugin 的做法一致（java.* 由 JDK 提供，android.* 来自 android.jar）。
javac -source 17 -target 17 \
  -classpath "$PLATFORM" \
  -encoding UTF-8 \
  -Xlint:-options \
  -d "$OUT_DIR/classes" \
  @"$OUT_DIR/sources.txt"

echo "==> 生成 dex"
find "$OUT_DIR/classes" -name '*.class' > "$OUT_DIR/classes.txt"
"$BUILD_TOOLS/d8" \
  --lib "$PLATFORM" \
  --min-api 26 \
  --release \
  --output "$OUT_DIR" \
  @"$OUT_DIR/classes.txt"

echo "==> 打包 dex"
cp "$OUT_DIR/unsigned.apk" "$OUT_DIR/with-dex.apk"
# 用 Python 的 zipfile 而不是 zip 命令：APK 只是 ZIP，且不引入额外系统依赖
python3 - "$OUT_DIR/with-dex.apk" "$OUT_DIR/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "==> 对齐"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT_DIR/with-dex.apk" "$OUT_DIR/aligned.apk"

if [[ $DEBUG -eq 1 ]]; then
  KEYSTORE="$ANDROID_DIR/.keystore/debug.jks"
  KS_PASS=android
  KS_ALIAS=androiddebugkey
  [[ -f "$KEYSTORE" ]] || {
    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
      -storepass "$KS_PASS" -keypass "$KS_PASS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
  }
  FINAL="$OUT_DIR/chat-demo-debug.apk"
else
  KEYSTORE="${KEYSTORE:-$ANDROID_DIR/.keystore/release.jks}"
  KS_ALIAS="${KEYSTORE_ALIAS:-chat-demo}"
  # release 密码必须由调用方提供：签名库一旦以公开的默认口令生成，
  # 任何拿到该文件的人都能签出被系统视为同一应用的升级包。
  if [[ -z "${KEYSTORE_PASSWORD:-}" ]]; then
    echo "缺少 release 签名库密码：请设置 KEYSTORE_PASSWORD 环境变量。" >&2
    echo "首次生成签名库时它同时作为新库的口令，之后必须与库文件一起保密备份。" >&2
    exit 1
  fi
  KS_PASS="$KEYSTORE_PASSWORD"
  if [[ ! -f "$KEYSTORE" ]]; then
    echo "==> 未找到签名库，生成 $KEYSTORE"
    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
      -storepass "$KS_PASS" -keypass "$KS_PASS" \
      -keyalg RSA -keysize 4096 -validity 10000 \
      -dname "CN=DeepSeek Chat Demo,O=chat-demo,C=CN" >/dev/null 2>&1
  fi
  FINAL="$OUT_DIR/chat-demo-$VERSION.apk"
fi

echo "==> 签名"
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$FINAL" \
  "$OUT_DIR/aligned.apk"

"$BUILD_TOOLS/apksigner" verify --print-certs "$FINAL" | head -5

echo
echo "APK: $FINAL"
ls -lh "$FINAL"
