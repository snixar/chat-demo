/**
 * 原生 HTTP 传输（见 android/.../HttpBridge.java）。
 *
 * 网页版直接用 fetch；APK 里页面跑在 https://appassets.androidplatform.net/ 上，
 * 第三方 API 与 MCP 服务器通常不返回 CORS 头，浏览器 fetch 会被预检拦下，
 * 而 WebView 又默认禁止明文 http。桥对象存在时改由原生 HttpURLConnection 代发，
 * 页面只拿到状态、响应头与响应体（流式时逐块推送）。
 *
 * 两种模式：
 * - 普通请求一次性拿回完整响应体，适合 /models 这类小 JSON；
 * - 流式请求先回状态与响应头，之后逐块推送文本，适合 SSE 长连接。
 */

type NativeBridge = {
  request: (argumentJson: string) => void
  cancel?: (requestId: string) => void
}

/** 桥层失败（连接失败、原生侧报错、中止），由调用方决定包装成哪种错误 */
export class NativeHttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeHttpError'
  }
}

type NativeHead = {
  status: number
  statusText?: string
  headers?: Record<string, string>
}

let requestSeq = 0

/** 流式请求的页面侧状态机 */
type StreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  closed: boolean
}

const streamStates = new Map<string, StreamState>()
const resultWaiters = new Map<string, (payload: string) => void>()

const bridge = (): NativeBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window.AndroidMcp as NativeBridge | undefined)

/** 是否可用原生 HTTP（APK 内为 true） */
export const hasNativeHttp = () => bridge()?.request !== undefined

/** 把原生回调挂到 window，只挂一次 */
const ensureHooks = () => {
  if (window.__mcpFetchResult) {
    return
  }
  window.__mcpFetchResult = (id: string, payload: string) => {
    const resolve = resultWaiters.get(id)
    resultWaiters.delete(id)
    resolve?.(payload)
  }
  window.__mcpFetchHead = (id: string, payload: string) => {
    if (!streamStates.has(id)) {
      return
    }
    // 先把头信息交给等待者，流本身在 nativeFetchStream 里已经建好
    resultWaiters.get(id)?.(payload)
    resultWaiters.delete(id)
  }
  window.__mcpFetchChunk = (id: string, chunk: string) => {
    const state = streamStates.get(id)
    if (!state || state.closed) {
      return
    }
    try {
      state.controller.enqueue(state.encoder.encode(chunk))
    } catch {
      state.closed = true
    }
  }
  window.__mcpFetchEnd = (id: string) => {
    const state = streamStates.get(id)
    streamStates.delete(id)
    if (state && !state.closed) {
      state.closed = true
      try {
        state.controller.close()
      } catch {
        // 已关闭
      }
    }
  }
  window.__mcpFetchError = (id: string, message: string) => {
    const state = streamStates.get(id)
    streamStates.delete(id)
    if (state && !state.closed) {
      state.closed = true
      try {
        state.controller.error(new NativeHttpError(message))
      } catch {
        // 已关闭
      }
    }
  }
}

/** 普通请求：等完整响应 */
const fetchOnce = (native: NativeBridge, url: string, init: RequestInit) =>
  new Promise<string>((resolve) => {
    ensureHooks()
    const requestId = `http-${++requestSeq}`
    resultWaiters.set(requestId, resolve)
    init.signal?.addEventListener(
      'abort',
      () => {
        native.cancel?.(requestId)
        if (resultWaiters.delete(requestId)) {
          resolve(JSON.stringify({ status: 0, error: 'aborted' }))
        }
      },
      { once: true }
    )
    native.request(
      JSON.stringify({
        url,
        method: init.method ?? 'GET',
        headers: normalizeHeaders(init.headers),
        body: typeof init.body === 'string' ? init.body : null,
        requestId,
      })
    )
  })

/** 流式请求：响应头先回来，响应体以增量推入 ReadableStream */
const fetchStream = (native: NativeBridge, url: string, init: RequestInit) =>
  new Promise<{ head: NativeHead; body: ReadableStream<Uint8Array> }>((resolve) => {
    ensureHooks()
    const requestId = `http-${++requestSeq}`
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamStates.set(requestId, { controller, encoder, closed: false })
      },
      cancel() {
        streamStates.delete(requestId)
        native.cancel?.(requestId)
      },
    })
    resultWaiters.set(requestId, (payload) => {
      let head: NativeHead
      try {
        head = JSON.parse(payload) as NativeHead
      } catch {
        head = { status: 0, statusText: 'bad head' }
      }
      resolve({ head, body })
    })
    init.signal?.addEventListener(
      'abort',
      () => {
        native.cancel?.(requestId)
        streamStates.delete(requestId)
        if (resultWaiters.delete(requestId)) {
          resolve({ head: { status: 0, statusText: 'aborted' }, body })
        }
      },
      { once: true }
    )
    native.request(
      JSON.stringify({
        url,
        method: init.method ?? 'GET',
        headers: normalizeHeaders(init.headers),
        body: typeof init.body === 'string' ? init.body : null,
        requestId,
        stream: true,
      })
    )
  })

/**
 * 统一出口，语义与 fetch 一致。没有原生桥时退化为普通 fetch。
 * streaming 为 true 时用流式模式：SSE 必须边读边处理，否则要等连接结束才有内容。
 */
export async function nativeFetch(
  url: string,
  init: RequestInit,
  streaming = false
): Promise<Response> {
  const native = bridge()
  if (!native?.request) {
    return fetch(url, init)
  }
  // 桥只接受字符串 body；multipart（附件上传）仍然走 fetch，官方 API 允许该源
  if (init.body != null && typeof init.body !== 'string') {
    return fetch(url, init)
  }

  if (streaming) {
    const { head, body } = await fetchStream(native, url, init)
    if (head.status === 0) {
      throw new NativeHttpError(head.statusText || 'request aborted')
    }
    return new Response(body, {
      status: head.status,
      statusText: head.statusText ?? '',
      headers: new Headers(head.headers ?? {}),
    })
  }

  const raw = await fetchOnce(native, url, init)
  const parsed = JSON.parse(raw) as {
    status: number
    statusText?: string
    headers?: Record<string, string>
    body?: string
    error?: string
    bodyBase64?: boolean
  }
  if (parsed.error) {
    throw new NativeHttpError(parsed.error)
  }
  const responseBody = parsed.body
  const body = responseBody
    ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            parsed.bodyBase64 ? decodeBase64(responseBody) : new TextEncoder().encode(responseBody)
          )
          controller.close()
        },
      })
    : null
  return new Response(body, {
    status: parsed.status,
    statusText: parsed.statusText ?? '',
    headers: new Headers(parsed.headers ?? {}),
  })
}

const normalizeHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  const result: Record<string, string> = {}
  if (!headers) {
    return result
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value
    }
    return result
  }
  return { ...headers }
}

const decodeBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
