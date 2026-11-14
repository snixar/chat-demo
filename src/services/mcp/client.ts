/**
 * MCP（Model Context Protocol）客户端，支持两种传输：
 *
 * - **Streamable HTTP**（2025-03-26 起的推荐方式）：所有消息 POST 到同一个 endpoint，
 *   服务端可以直接返回 JSON，也可以返回 text/event-stream 把响应作为 SSE 事件流下发；
 *   客户端通过响应头 `Mcp-Session-Id` 维持会话。
 * - **SSE**（2024-11-05 的旧方式）：先 GET 建立一条长连接，服务端用 `endpoint` 事件告知
 *   用来 POST 消息的地址，之后所有 JSON-RPC 响应都从这条 SSE 流回来。
 *
 * 两种传输共用 JSON-RPC 2.0 语义，因此这里只实现差异部分，握手、能力协商、工具调用统一。
 * 只实现本应用需要的子集：initialize、tools/list、tools/call、ping、notifications/initialized。
 */

export type McpTransport = 'streamableHttp' | 'sse'

/** 传输层拿到的原始 JSON-RPC 响应 */
type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type McpTool = {
  /** 服务端给出的原始名称 */
  name: string
  /** 本应用里使用的唯一名称（带服务器前缀，满足 API 的工具命名约束） */
  qualifiedName: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

export type McpServerConfig = {
  id: string
  name: string
  url: string
  transport: McpTransport
  /** 附加请求头，如 Authorization；值原样发送 */
  headers: { name: string; value: string }[]
  enabled: boolean
  /** 被单独停用的工具名（服务器原始名）；未列出的一律启用 */
  disabledTools?: string[]
}

export type McpConnectionStatus = 'idle' | 'connecting' | 'ready' | 'error'

/** MCP 错误统一包装，便于界面区分是传输、协议还是工具执行失败 */
export class McpError extends Error {
  constructor(
    readonly kind: 'network' | 'protocol' | 'timeout' | 'tool',
    message: string
  ) {
    super(message)
    this.name = 'McpError'
  }
}

const PROTOCOL_VERSION = '2025-03-26'
const CLIENT_INFO = { name: 'chat-demo', version: '0.1.1' }
/** initialize 与 tools/* 的超时；工具调用本身可能很慢，给得更宽 */
const REQUEST_TIMEOUT = 20_000
const TOOL_TIMEOUT = 120_000

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 单个 MCP 服务器的会话。负责握手、发送请求、把响应按 id 分发给等待者。
 * 对象不持有跨连接状态：重连时由调用方新建实例。
 */
export class McpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private sessionId: string | null = null
  /** SSE 传输下用于 POST 消息的地址，由服务端的 endpoint 事件给出 */
  private messageEndpoint: string | null = null
  /** SSE 传输的长连接；断开后需要重连 */
  private eventSource: AbortController | null = null
  /** 记录连接期间收到的协议版本，便于诊断 */
  private serverInfo: { name?: string; version?: string } = {}
  private closed = false

  constructor(private readonly config: McpServerConfig) {}

  get serverName() {
    return this.serverInfo.name ?? this.config.name
  }

  /** 握手：initialize → notifications/initialized */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.config.transport === 'sse') {
      await this.openSseStream(signal)
    }
    const init = await this.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: CLIENT_INFO,
      },
      REQUEST_TIMEOUT,
      signal
    )
    if (isRecord(init) && isRecord(init.serverInfo)) {
      const info = init.serverInfo
      this.serverInfo = {
        ...(typeof info.name === 'string' ? { name: info.name } : {}),
        ...(typeof info.version === 'string' ? { version: info.version } : {}),
      }
    }
    await this.notify('notifications/initialized', {})
  }

  /** 拉取工具清单 */
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const result = await this.request('tools/list', {}, REQUEST_TIMEOUT, signal)
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      return []
    }
    const tools: McpTool[] = []
    for (const item of result.tools) {
      if (!isRecord(item) || typeof item.name !== 'string') {
        continue
      }
      const schema = isRecord(item.inputSchema) ? item.inputSchema : { type: 'object' }
      tools.push({
        name: item.name,
        qualifiedName: qualifyToolName(this.config.id, item.name),
        description: typeof item.description === 'string' ? item.description : '',
        inputSchema: { ...schema, type: 'object' },
      })
    }
    return tools
  }

  /** 执行工具，返回文本化结果；失败时抛出 McpError('tool') */
  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const result = await this.request(
      'tools/call',
      { name, arguments: isRecord(args) ? args : {} },
      TOOL_TIMEOUT,
      signal
    )
    return formatToolResult(result)
  }

  /** 通知没有响应，失败不阻塞流程 */
  private async notify(method: string, params: unknown) {
    try {
      await this.post({ jsonrpc: '2.0', method, params }, 0)
    } catch {
      // 通知失败不影响会话；服务端可能只是不接受该通知
    }
  }

  private request(
    method: string,
    params: unknown,
    timeout: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new McpError('protocol', 'MCP client is closed'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpError('timeout', `MCP request timed out: ${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new McpError('protocol', 'MCP request aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.post({ jsonrpc: '2.0', id, method, params }, timeout).catch((error: unknown) => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
    })
  }

  /** 发送一条消息。Streamable HTTP 下响应可能就从这次请求返回 */
  private async post(payload: unknown, timeout: number): Promise<void> {
    const target = this.config.transport === 'sse' ? this.messageEndpoint : this.config.url
    if (!target) {
      throw new McpError('network', 'MCP message endpoint is not available')
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.authHeaders(),
    }
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
    }
    const response = await mcpFetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: timeout > 0 ? AbortSignal.timeout(timeout) : undefined,
    })
    if (!response.ok) {
      throw new McpError('network', `MCP HTTP ${response.status} ${response.statusText}`)
    }
    const session = response.headers.get('Mcp-Session-Id')
    if (session) {
      this.sessionId = session
    }
    const contentType = response.headers.get('Content-Type') ?? ''
    if (contentType.includes('text/event-stream')) {
      // Streamable HTTP 用 SSE 回传响应，读完即结束（与 SSE 传输的长连接不同）
      await this.readEventStream(response, false)
      return
    }
    const text = await response.text()
    if (!text.trim()) {
      // 202/204：仅表示已接收（多为通知）
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new McpError('protocol', 'MCP response is not valid JSON')
    }
    this.dispatchAll(parsed)
  }

  /** SSE 传输：GET 长连接，先等 endpoint 事件拿到 POST 地址 */
  private async openSseStream(signal?: AbortSignal): Promise<void> {
    this.eventSource = new AbortController()
    // AbortSignal.any 在目标浏览器版本里不可用，手工把外部 signal 接到内部控制器上
    if (signal) {
      const inner = this.eventSource
      if (signal.aborted) {
        inner.abort()
      } else {
        signal.addEventListener('abort', () => inner.abort(), { once: true })
      }
    }
    const merged = this.eventSource.signal
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...this.authHeaders(),
    }
    const response = await mcpFetch(
      this.config.url,
      {
        method: 'GET',
        headers,
        signal: merged,
      },
      true
    )
    if (!response.ok) {
      throw new McpError('network', `MCP SSE ${response.status} ${response.statusText}`)
    }
    if (!response.body) {
      throw new McpError('protocol', 'MCP SSE response has no body')
    }
    // 不 await：连接是长驻的，读循环在后台推进
    void this.readEventStream(response, true).catch(() => {
      // 连接中断由后续请求的超时体现
    })
    const deadline = Date.now() + REQUEST_TIMEOUT
    while (!this.messageEndpoint && Date.now() < deadline) {
      if (merged.aborted) {
        throw new McpError('network', 'MCP SSE connection aborted')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!this.messageEndpoint) {
      throw new McpError('timeout', 'MCP SSE endpoint event was not received')
    }
  }

  /**
   * 解析 SSE 流。MCP 的 SSE 每帧是一条 JSON-RPC 消息，event 名默认为 message，
   * SSE 传输下另有一个 endpoint 事件携带 POST 地址。
   * longLived 为 true 时只在流结束时收尾，否则读到 message 完成即可返回。
   */
  private async readEventStream(response: Response, longLived: boolean): Promise<void> {
    if (!response.body) {
      return
    }
    const decoder = new TextDecoder()
    const events = readSse(response.body)
    for await (const event of events) {
      if (event.event === 'endpoint') {
        // 地址可能是相对路径，按原始 URL 解析
        this.messageEndpoint = new URL(event.data.trim(), this.config.url).toString()
        continue
      }
      if (!event.data.trim()) {
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      this.dispatchAll(parsed)
      if (!longLived && !this.pending.size) {
        return
      }
    }
    if (longLived && !this.closed) {
      throw new McpError('network', 'MCP SSE stream ended')
    }
    // 非长连接时把解码器剩余内容交出去
    decoder.decode()
  }

  /** 响应可能是单条，也可能是批量数组 */
  private dispatchAll(payload: unknown) {
    if (Array.isArray(payload)) {
      payload.forEach((item) => this.dispatch(item))
      return
    }
    this.dispatch(payload)
  }

  private dispatch(payload: unknown) {
    if (!isRecord(payload)) {
      return
    }
    const message = payload as JsonRpcResponse
    // 服务端主动发来的请求（如 sampling、roots）不在本应用能力范围内，直接忽略
    if (message.id === undefined) {
      return
    }
    const id = typeof message.id === 'number' ? message.id : Number(message.id)
    if (!Number.isFinite(id)) {
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (message.error) {
      const detail =
        typeof message.error.message === 'string' ? message.error.message : 'unknown error'
      pending.reject(new McpError('protocol', `${detail} (${message.error.code})`))
      return
    }
    pending.resolve(message.result)
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const { name, value } of this.config.headers) {
      if (name.trim() && value) {
        headers[name.trim()] = value
      }
    }
    return headers
  }

  close() {
    this.closed = true
    this.eventSource?.abort()
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new McpError('protocol', 'MCP client closed'))
    }
    this.pending.clear()
  }
}

/**
 * 工具名要满足 API 的约束（字母开头，只含字母数字和 _ -），而 MCP 工具名与服务器
 * 都可能包含不符合的字符，因此统一转成 `mcp__<serverId>__<tool>`。serverId 是本地生成的
 * 短 id，天然符合约束。
 */
export const qualifyToolName = (serverId: string, toolName: string) => {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return `mcp__${sanitize(serverId)}__${sanitize(toolName)}`
}

/** 从限定名里还原服务器与工具原名 */
export const parseQualifiedToolName = (qualified: string) => {
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified)
  return match ? { serverId: match[1], toolName: match[2] } : null
}

/** 把 tools/call 的返回值转成文本，兼容 content 数组与纯对象 */
const formatToolResult = (result: unknown): string => {
  if (!isRecord(result)) {
    return typeof result === 'string' ? result : JSON.stringify(result ?? null)
  }
  if (result.isError === true) {
    throw new McpError('tool', extractContentText(result.content) || 'MCP tool returned an error')
  }
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item)) {
        continue
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if (item.type === 'image' || item.type === 'audio') {
        // 二进制内容不进入文本上下文，留一个占位说明
        parts.push(`[${String(item.type)} content omitted]`)
      } else if (item.type === 'resource' && isRecord(item.resource)) {
        const text = item.resource.text
        parts.push(typeof text === 'string' ? text : '[embedded resource]')
      } else {
        parts.push(JSON.stringify(item))
      }
    }
  }
  if (isRecord(result.structuredContent)) {
    parts.push(JSON.stringify(result.structuredContent))
  }
  return parts.join('\n').trim()
}

const extractContentText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/* ---------- SSE 解析 ---------- */

type SseEvent = { event: string; data: string }

/**
 * 按 WHATWG 规范解析 text/event-stream。与 services/api/sse.ts 的思路一致，
 * 但这里是独立的小实现：MCP 的帧都很小，不需要该模块的分片处理，且要暴露 event 名。
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let data = ''
  const flush = (): SseEvent | null => {
    if (!data) {
      return null
    }
    const event = { event: eventName || 'message', data }
    eventName = ''
    data = ''
    return event
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.search(/\r\n|\r|\n/)
      while (index >= 0) {
        const line = buffer.slice(0, index)
        const width = buffer.startsWith('\r\n', index) ? 2 : 1
        buffer = buffer.slice(index + width)
        if (line === '') {
          const event = flush()
          if (event) {
            yield event
          }
        } else if (line.startsWith(':')) {
          // 注释/保活
        } else {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) {
            value = value.slice(1)
          }
          if (field === 'event') {
            eventName = value
          } else if (field === 'data') {
            data = data ? `${data}\n${value}` : value
          }
        }
        index = buffer.search(/\r\n|\r|\n/)
      }
    }
    // 流结束时把残留的最后一帧交出去
    if (buffer) {
      const colon = buffer.indexOf(':')
      const field = colon === -1 ? buffer : buffer.slice(0, colon)
      let value = colon === -1 ? '' : buffer.slice(colon + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
      if (field === 'data') {
        data = data ? `${data}\n${value}` : value
      }
    }
    const last = flush()
    if (last) {
      yield last
    }
  } finally {
    reader.releaseLock()
  }
}

/* ---------- 传输出口 ---------- */

/**
 * 原生 HTTP 桥（见 HttpBridge.java）。两种模式：
 * - 普通请求一次性拿回状态、响应头与完整响应体；
 * - 流式请求（SSE 长连接）先拿状态与响应头，之后逐块推送文本，直到 end / error。
 * 浏览器里没有桥对象，直接走 fetch。
 */
type NativeMcpBridge = {
  request: (argumentJson: string) => void
  cancel?: (requestId: string) => void
}

type NativeHead = {
  status: number
  statusText?: string
  headers?: Record<string, string>
}

let nativeRequestSeq = 0

/** 流式请求的页面侧状态机 */
type StreamState = {
  controller: ReadableStreamDefaultController<Uint8Array>
  encoder: TextEncoder
  closed: boolean
}

const streamStates = new Map<string, StreamState>()
const nativeResultWaiters = new Map<string, (payload: string) => void>()

/** 把原生回调挂到 window，只挂一次 */
const ensureNativeHooks = () => {
  if (window.__mcpFetchResult) {
    return
  }
  window.__mcpFetchResult = (id: string, payload: string) => {
    const resolve = nativeResultWaiters.get(id)
    nativeResultWaiters.delete(id)
    resolve?.(payload)
  }
  window.__mcpFetchHead = (id: string, payload: string) => {
    const state = streamStates.get(id)
    if (!state) {
      return
    }
    try {
      // 先把头信息交给等待者，流本身已由 nativeFetchStream 建好
      nativeResultWaiters.get(id)?.(payload)
      nativeResultWaiters.delete(id)
    } catch {
      // 关闭中的流忽略后续写入
    }
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
        state.controller.error(new McpError('network', message))
      } catch {
        // 已关闭
      }
    }
  }
}

/** 普通请求：等完整响应 */
const nativeFetchOnce = (bridge: NativeMcpBridge, url: string, init: RequestInit) =>
  new Promise<string>((resolve) => {
    ensureNativeHooks()
    const requestId = `mcp-${++nativeRequestSeq}`
    nativeResultWaiters.set(requestId, resolve)
    init.signal?.addEventListener(
      'abort',
      () => {
        bridge.cancel?.(requestId)
        if (nativeResultWaiters.delete(requestId)) {
          resolve(JSON.stringify({ status: 0, error: 'aborted' }))
        }
      },
      { once: true }
    )
    bridge.request(
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
const nativeFetchStream = (bridge: NativeMcpBridge, url: string, init: RequestInit) =>
  new Promise<{ head: NativeHead; body: ReadableStream<Uint8Array> }>((resolve) => {
    ensureNativeHooks()
    const requestId = `mcp-${++nativeRequestSeq}`
    const encoder = new TextEncoder()
    let head: NativeHead | null = null
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamStates.set(requestId, { controller, encoder, closed: false })
      },
      cancel() {
        streamStates.delete(requestId)
        bridge.cancel?.(requestId)
      },
    })
    nativeResultWaiters.set(requestId, (payload) => {
      // 头信息到达：先解析，再把 body 交给调用方
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
        bridge.cancel?.(requestId)
        streamStates.delete(requestId)
        if (nativeResultWaiters.delete(requestId)) {
          resolve({ head: { status: 0, statusText: 'aborted' }, body })
        }
      },
      { once: true }
    )
    bridge.request(
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
 * 统一出口。Android 壳里走原生 HTTP（绕过 CORS 与明文限制），浏览器里直接用 fetch。
 * streaming 为 true 时用流式模式：SSE 是长连接，必须边读边处理。
 */
async function mcpFetch(url: string, init: RequestInit, streaming = false): Promise<Response> {
  const bridge = typeof window === 'undefined' ? undefined : window.AndroidMcp
  if (!bridge?.request) {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted) {
        throw error
      }
      throw new McpError('network', error instanceof Error ? error.message : String(error))
    }
  }

  if (streaming) {
    const { head, body } = await nativeFetchStream(bridge, url, init)
    if (head.status === 0) {
      throw new McpError('network', head.statusText ?? 'MCP stream failed')
    }
    return new Response(body, {
      status: head.status,
      statusText: head.statusText ?? '',
      headers: new Headers(head.headers ?? {}),
    })
  }

  const raw = await nativeFetchOnce(bridge, url, init)
  const parsed = JSON.parse(raw) as {
    status: number
    statusText?: string
    headers?: Record<string, string>
    body?: string
    error?: string
    bodyBase64?: boolean
  }
  if (parsed.error) {
    throw new McpError('network', parsed.error)
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
