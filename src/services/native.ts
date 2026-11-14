/**
 * 原生 Android 壳的适配层。
 *
 * 直接打开网页时这些能力都由浏览器提供；在 APK 里由 WebView 与 Java 桥接管：
 * - 页面跑在 https://appassets.androidplatform.net/ 上，blob: 地址无法被系统打开，
 *   改为把字节分块交给原生落盘，再以 content:// 打开或保存；
 * - 返回键先交给页面关闭浮层，没有可关闭的才退出应用；
 * - 系统栏配色跟随页面主题。
 *
 * 桥对象由 MainActivity 以 AndroidShell 注入，不存在时所有函数退化为浏览器默认行为。
 */

type Bridge = {
  beginFile: (name: string, mime: string, save: boolean) => string
  writeChunk: (token: string, base64: string) => boolean
  endFile: (token: string) => void
  abortFile: (token: string) => void
  setTheme: (dark: boolean) => void
}

declare global {
  interface Window {
    AndroidShell?: Bridge
    /** 原生侧打开 blob: 地址时回调，由页面读取字节后交给原生 */
    __androidOpenBlob?: (url: string) => void
    /** 原生返回键优先调用；返回 true 表示页面已处理 */
    __androidHandleBack?: () => boolean
  }
}

const bridge = () => (typeof window === 'undefined' ? undefined : window.AndroidShell)

/** 是否运行在原生壳中 */
export const isNativeApp = () => bridge() !== undefined

/** 把 Blob 转成 base64 分块写入原生临时文件；块大小需与 BlobBridge.CHUNK_BYTES 一致 */
const CHUNK_BYTES = 512 * 1024

const toBase64 = (bytes: Uint8Array): string => {
  // 逐块构造字符串，避免大文件用 apply 展开导致调用栈溢出
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/**
 * 交给原生保存或打开一个 Blob。
 * save 为 true 时弹出系统保存位置选择器（导出会话归档），否则用其他应用打开（附件原件）。
 */
export const deliverBlob = async (blob: Blob, name: string, save: boolean): Promise<boolean> => {
  const api = bridge()
  if (!api) {
    return false
  }
  const mime = blob.type || 'application/octet-stream'
  const token = api.beginFile(name, mime, save)
  if (!token) {
    return false
  }
  const buffer = new Uint8Array(await blob.arrayBuffer())
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    if (!api.writeChunk(token, toBase64(buffer.subarray(offset, offset + CHUNK_BYTES)))) {
      api.abortFile(token)
      return false
    }
  }
  api.endFile(token)
  return true
}

/** 浏览器里用 <a download> 触发下载；原生壳交给系统保存 */
export const saveBlob = async (blob: Blob, name: string) => {
  if (await deliverBlob(blob, name, true)) {
    return
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 浏览器里新标签打开；原生壳交给系统查看器 */
export const openBlob = async (url: string, name = 'attachment') => {
  if (!bridge()) {
    window.open(url, '_blank', 'noreferrer')
    return
  }
  try {
    const blob = await (await fetch(url)).blob()
    await deliverBlob(blob, name, false)
  } catch {
    // 读取失败时保持原样，不做提示：原件缺失时界面已有占位
  }
}

/** 注册原生回调：打开 blob 与返回键 */
export const bindNativeBack = (handler: () => boolean) => {
  window.__androidHandleBack = handler
  return () => {
    delete window.__androidHandleBack
  }
}

export const bindNativeBlobOpener = () => {
  window.__androidOpenBlob = (url) => {
    void openBlob(url)
  }
  return () => {
    delete window.__androidOpenBlob
  }
}

/** 同步系统栏深浅色；浏览器里无需处理 */
export const syncNativeTheme = (dark: boolean) => {
  bridge()?.setTheme(dark)
}
