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
  /** 拍照：拉起系统相机，结果以 base64 + mime + 文件名回调 */
  takePhoto: (requestId: string) => void
  /** 相册：拉起系统图片选择器 */
  pickImage: (requestId: string) => void
}

/** 原生选择器回传的一次结果 */
type PickedFile = { name: string; mime: string; base64: string }

/** 原生 HTTP 桥，供 MCP 客户端绕过 CORS 与明文限制，见 HttpBridge.java */
type McpBridge = { request: (argumentJson: string) => void }

declare global {
  interface Window {
    AndroidShell?: Bridge
    AndroidMcp?: McpBridge
    /** 原生侧打开 blob: 地址时回调，由页面读取字节后交给原生 */
    __androidOpenBlob?: (url: string) => void
    /** 原生返回键优先调用；返回 true 表示页面已处理 */
    __androidHandleBack?: () => boolean
    /** 原生 HTTP 结果回调，见 services/mcp/client.ts */
    __mcpFetchResult?: (id: string, payload: string) => void
    __mcpFetchHead?: (id: string, payload: string) => void
    __mcpFetchChunk?: (id: string, chunk: string) => void
    __mcpFetchEnd?: (id: string) => void
    __mcpFetchError?: (id: string, message: string) => void
    /** 拍照/相册的结果回调，见 MainActivity.deliverPickedFile */
    __androidPickedFile?: (id: string, payload: string) => void
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

/**
 * 浏览器里可以直接在标签页打开的类型：位图与 PDF。
 * SVG 虽然是图片，但作为顶层文档会执行其中脚本，必须走下载；
 * HTML / JS / 其他文档同理。见 openBlob 的同源说明。
 */
const INLINE_OPENABLE = /^(image\/(png|jpeg|gif|webp|bmp|avif|tiff)|application\/pdf)$/i

/**
 * 浏览器里新标签打开；原生壳交给系统查看器。
 *
 * blob: 地址继承创建者的源，若把用户上传的 HTML/SVG 直接 window.open，
 * 它会在本应用的源上执行脚本，读到 localStorage 里的 API Key。
 * 因此只有位图和 PDF 才内联打开，其余类型一律改为下载。
 */
export const openBlob = async (url: string, name = 'attachment') => {
  if (!bridge()) {
    let blob: Blob
    try {
      blob = await (await fetch(url)).blob()
    } catch {
      // 读取失败时保持原样，不做提示：原件缺失时界面已有占位
      return
    }
    if (INLINE_OPENABLE.test(blob.type)) {
      window.open(url, '_blank', 'noreferrer')
      return
    }
    await saveBlob(blob, name)
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

/* ---------- 拍照 / 相册 ---------- */

let pickSeq = 0
const pickWaiters = new Map<string, (file: PickedFile | null) => void>()

/** 原生侧回传选择结果；payload 为 JSON 字符串，空表示取消 */
const ensurePickHook = () => {
  if (window.__androidPickedFile) {
    return
  }
  window.__androidPickedFile = (id: string, payload: string) => {
    const resolve = pickWaiters.get(id)
    pickWaiters.delete(id)
    if (!payload) {
      resolve?.(null)
      return
    }
    try {
      resolve?.(JSON.parse(payload) as PickedFile)
    } catch {
      resolve?.(null)
    }
  }
}

const base64ToFile = (picked: PickedFile): File => {
  const binary = atob(picked.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], picked.name || 'photo.jpg', {
    type: picked.mime || 'image/jpeg',
  })
}

const pickNative = (mode: 'camera' | 'gallery'): Promise<File[]> => {
  const api = bridge()
  const method = mode === 'camera' ? api?.takePhoto : api?.pickImage
  if (!api || !method) {
    return Promise.resolve([])
  }
  ensurePickHook()
  const requestId = `pick-${++pickSeq}`
  return new Promise<File[]>((resolve) => {
    pickWaiters.set(requestId, (picked) => {
      resolve(picked ? [base64ToFile(picked)] : [])
    })
    method.call(api, requestId)
  })
}

/**
 * 拍照。浏览器里没有原生相机，退化为图片文件选择（capture 属性在部分移动浏览器
 * 会直接调起相机，桌面端则是普通文件选择）。
 */
export const pickCamera = async (): Promise<File[]> => {
  if (!bridge()?.takePhoto) {
    return pickViaInput('image/*')
  }
  return pickNative('camera')
}

/** 相册：原生走系统图片选择器，浏览器里用 input[accept=image/*] */
export const pickGallery = async (): Promise<File[]> => {
  if (!bridge()?.pickImage) {
    return pickViaInput('image/*')
  }
  return pickNative('gallery')
}

/** 浏览器兜底：动态创建 input 让用户选图 */
const pickViaInput = (accept: string): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = false
    input.style.display = 'none'
    document.body.appendChild(input)
    const cleanup = () => {
      input.remove()
    }
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      cleanup()
    }
    // 用户取消时不会触发 change，靠窗口重新获得焦点清理
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files?.length) {
            resolve([])
            cleanup()
          }
        }, 500)
      },
      { once: true }
    )
    input.click()
  })
