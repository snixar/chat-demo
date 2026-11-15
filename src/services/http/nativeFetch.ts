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

/**
 * 等待原生侧回传响应头的上限。
 * SSE 长连接本身可以持续很久，但「连响应头都拿不到」只可能是连接或桥出了问题，
 * 必须有界，否则界面会停在「正在思考」而不给任何错误。
 */
const HEAD_TIMEOUT_MS = 90_000

/**
 * 流式响应静默多久算连接已死。
 *
 * 服务端在思考期间会定期发 ping / 注释保活，因此「一段时间内一个字节都没有」
 * 只可能是连接断了而 read 循环没收到 EOF。给 5 分钟：足够覆盖长时间无输出的推理，
 * 又不至于让用户无限等待。
 */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** 流式请求的页面侧状态机 */
type StreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  closed: boolean
  /** 最近一次收到数据的时间，用于静默超时判断 */
  lastActivity: number
  /** 静默看门狗定时器；流结束时统一清理 */
  idleTimer?: ReturnType<typeof setInterval>
}

/** 结束一个流状态：清定时器并标记关闭，返回 state 供调用方收尾 */
const closeStreamState = (id: string): StreamState | undefined => {
  const state = streamStates.get(id)
  streamStates.delete(id)
  if (state) {
    clearInterval(state.idleTimer)
  }
  return state
}

const streamStates = new Map<string, StreamState>()
const resultWaiters = new Map<string, (payload: string) => void>()

const bridge = (): NativeBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window.AndroidMcp as NativeBridge | undefined)

/** 是否可用原生 HTTP（APK 内为 true） */
export const hasNativeHttp = () => bridge()?.request !== undefined

/**
 * 把原生回调挂到 window。
 *
 * 必须每次都完整挂一遍：先前版本只用 __mcpFetchResult 判断「已挂过」，
 * 一旦这个符号被外部（调试、注入脚本或旧版本残留）写过，其余四个钩子就永远不会
 * 注册，流式响应只能收到响应头、收不到任何分片，界面会停在「正在思考」。
 * 重复赋值是幂等的，成本可以忽略。
 */
const ensureHooks = () => {
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
    state.lastActivity = Date.now()
    try {
      state.controller.enqueue(state.encoder.encode(chunk))
    } catch {
      state.closed = true
    }
  }
  window.__mcpFetchEnd = (id: string) => {
    const state = closeStreamState(id)
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
    const state = closeStreamState(id)
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
        streamStates.set(requestId, {
          controller,
          encoder,
          closed: false,
          lastActivity: Date.now(),
        })
        // 每秒检查一次是否长时间没有任何数据；判定为死连接后按错误结束流，
        // 让上层的读取循环抛错，而不是无限 await。
        const current = streamStates.get(requestId)
        if (current) {
          current.idleTimer = setInterval(() => {
            const state = streamStates.get(requestId)
            if (!state || state.closed) {
              return
            }
            if (Date.now() - state.lastActivity < STREAM_IDLE_TIMEOUT_MS) {
              return
            }
            streamStates.delete(requestId)
            clearInterval(state.idleTimer)
            state.closed = true
            native.cancel?.(requestId)
            try {
              state.controller.error(new NativeHttpError('response stream stalled'))
            } catch {
              // 已关闭
            }
          }, 1000)
        }
      },
      cancel() {
        closeStreamState(requestId)
        native.cancel?.(requestId)
      },
    })
    /**
     * 响应头看门狗：原生侧若因任何原因不再回调（连接卡死、桥被阻塞、
     * 回调钩子未注册），这里必须主动失败，否则界面会永久停在「正在思考」
     * 且没有任何错误提示。取 90s：慢模型的首字节也远早于此。
     */
    const headTimer = setTimeout(() => {
      if (resultWaiters.delete(requestId)) {
        native.cancel?.(requestId)
        streamStates.delete(requestId)
        try {
          body.cancel().catch(() => {})
        } catch {
          // 流可能已经关闭
        }
        resolve({ head: { status: 0, statusText: 'no response headers (timeout)' }, body })
      }
    }, HEAD_TIMEOUT_MS)
    resultWaiters.set(requestId, (payload) => {
      clearTimeout(headTimer)
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
        clearTimeout(headTimer)
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
