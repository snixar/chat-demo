import { ApiError } from './client.js'
import { nativeFetch } from '../http/nativeFetch.js'
import { readServerSentEvents } from './sse.js'
import type {
  AssistantBlockParam,
  CustomTool,
  MessageParam,
  MessageStreamEvent,
  StopReason,
  TextCitation,
} from './types.js'

/**
 * OpenAI Responses API 适配层（POST {baseUrl}/responses）。
 *
 * 与 Chat Completions 的主要差异：
 * - 系统提示走 `instructions`，对话走 `input` 数组，每个内容是独立 item 而非 message；
 * - 函数工具是扁平定义（`type/name/parameters` 同一层），内置搜索用 `{type:"web_search"}`；
 * - 思考过程是独立的 `reasoning` item，多轮时作为 input 原样回传；
 * - 流式事件名以 `response.` 开头，正文增量是 `response.output_text.delta`。
 *
 * 这里只做协议翻译，产出与官方 Anthropic 流一致的 MessageStreamEvent，
 * 因此上层的 applyEvent / 视图推导 / UI 全部复用。
 */

type ResponsesTextPart = { type: 'input_text'; text: string }
type ResponsesImagePart = { type: 'input_image'; image_url: string }
type ResponsesContentPart = ResponsesTextPart | ResponsesImagePart

/** user 消息的 content：字符串，或文本/附件/工具结果的块数组 */
type UserContent = Extract<MessageParam, { role: 'user' }>['content']

/** input 数组里的 item */
type ResponsesItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string | ResponsesContentPart[] }
  | { type: 'reasoning'; summary: { type: 'summary_text'; text: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export type ResponsesRequestOptions = {
  model: string
  system: string
  messages: MessageParam[]
  /** 自定义工具（MCP），按扁平 function 声明 */
  tools: CustomTool[]
  /** 是否请求推理摘要 */
  thinking: boolean
  /** 推理强度，如 high */
  reasoningEffort?: string
  /** 是否把历史助手消息里的思考作为 reasoning item 回传 */
  includeReasoning: boolean
  /** 是否声明提供商自带的联网搜索 */
  builtInSearch: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/* ---------- 请求构造 ---------- */

/**
 * 用户消息的内容块转 responses。附件用的是 Anthropic 的 file_id，
 * Responses 端点无法识别，因此只保留文本。
 */
const toUserContent = (blocks: { type: string; text?: string }[]): ResponsesContentPart[] =>
  blocks.flatMap((block): ResponsesContentPart[] =>
    block.type === 'text' && typeof block.text === 'string'
      ? [{ type: 'input_text', text: block.text }]
      : []
  )

/**
 * assistant 的内容块展开成多个 item。
 *
 * 顺序要求：reasoning 必须排在对应的 message 之前，function_call 排在正文之后；
 * 多个工具调用各自成项，结果另起 function_call_output。
 */
const toAssistantItems = (blocks: AssistantBlockParam[], includeReasoning: boolean) => {
  const items: ResponsesItem[] = []
  const summary: { type: 'summary_text'; text: string }[] = []
  const text: string[] = []
  const calls: { call_id: string; name: string; arguments: string }[] = []

  const flushReasoning = () => {
    if (summary.length > 0) {
      items.push({ type: 'reasoning', summary: [...summary] })
      summary.length = 0
    }
  }
  const flushText = () => {
    if (text.length > 0) {
      items.push({ type: 'message', role: 'assistant', content: text.join('') })
      text.length = 0
    }
  }

  for (const block of blocks) {
    if (block.type === 'thinking') {
      // 只有开启回传时才作为 reasoning item 发出；空思考没有信息量
      if (includeReasoning && block.thinking.trim()) {
        flushText()
        summary.push({ type: 'summary_text', text: block.thinking })
      }
      continue
    }
    if (block.type === 'text') {
      flushReasoning()
      text.push(block.text)
      continue
    }
    if (block.type === 'tool_use') {
      flushReasoning()
      flushText()
      calls.push({
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  flushReasoning()
  flushText()
  items.push(...calls.map((call) => ({ type: 'function_call' as const, ...call })))
  return items
}

/** 工具结果单独成 item，不能混在 user 消息里 */
const toUserItems = (content: UserContent) => {
  const items: ResponsesItem[] = []
  if (typeof content === 'string') {
    if (content) {
      items.push({ type: 'message', role: 'user', content })
    }
    return items
  }
  const texts: ResponsesContentPart[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      items.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: block.content,
      })
      continue
    }
    texts.push(...toUserContent([block]))
  }
  if (texts.length > 0) {
    items.push({
      type: 'message',
      role: 'user',
      content: texts.length === 1 && texts[0].type === 'input_text' ? texts[0].text : texts,
    })
  }
  return items
}

/** 内部消息列表转 responses 的 input 数组 */
const toInput = (messages: MessageParam[], includeReasoning: boolean): ResponsesItem[] => {
  const items: ResponsesItem[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      // Chat Engine 的扩展角色，Responses 不认识，折叠成一条 system 说明
      items.push({ type: 'message', role: 'user', content: `[system] ${message.content}` })
      continue
    }
    if (message.role === 'assistant') {
      items.push(...toAssistantItems(message.content, includeReasoning))
      continue
    }
    items.push(...toUserItems(message.content))
  }
  return items
}

export const buildResponsesRequest = (options: ResponsesRequestOptions) => {
  const { model, system, messages, tools, thinking, reasoningEffort } = options
  const toolDefs: Record<string, unknown>[] = tools.map((tool) => ({
    type: 'function',
    // Responses 的函数工具是扁平的，不像 Chat Completions 那样嵌在 function 对象里
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema,
    // 不传会默认严格模式，可选字段会被强制，这里显式关掉
    strict: false,
  }))
  if (options.builtInSearch) {
    toolDefs.push({ type: 'web_search' })
  }

  return {
    model,
    instructions: system,
    input: toInput(messages, options.includeReasoning),
    stream: true,
    // 不在服务端保存会话：多轮靠客户端回传 input
    store: false,
    ...(thinking
      ? {
          reasoning: {
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
            summary: 'auto',
          },
        }
      : {}),
    ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
  }
}

/* ---------- 响应转换 ---------- */

const mapStatus = (status: string | undefined, incompleteReason: string | null): StopReason => {
  if (status === 'incomplete' || incompleteReason === 'max_output_tokens') {
    return 'max_tokens'
  }
  if (status === 'failed' || status === 'cancelled') {
    return 'end_turn'
  }
  return 'end_turn'
}

/** 从 output_text 的 annotations 里取引用，结构同 Anthropic 的 web_search_result_location */
const readCitations = (annotations: unknown): TextCitation[] => {
  if (!Array.isArray(annotations)) {
    return []
  }
  return annotations.flatMap((item): TextCitation[] => {
    if (!isRecord(item) || item.type !== 'url_citation') {
      return []
    }
    const url = isString(item.url) ? item.url : ''
    if (!url) {
      return []
    }
    return [
      {
        type: 'web_search_result_location',
        url,
        title: isString(item.title) ? item.title : null,
        cited_text: '',
        encrypted_index: '',
      },
    ]
  })
}

const readUsage = (usage: unknown) => {
  if (!isRecord(usage)) {
    return undefined
  }
  const cached = isRecord(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0
  return {
    input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: typeof cached === 'number' ? cached : 0,
    output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  }
}

/**
 * POST {baseUrl}/responses（stream: true），把 responses 的流式事件翻译成内部事件。
 *
 * 各事件与内部块的对应：
 * - response.output_item.added(reasoning) → 开思考块
 * - response.reasoning_summary_text.delta → thinking_delta
 * - response.output_text.delta → text_delta
 * - response.output_item.added(function_call) → 开工具块
 * - response.function_call_arguments.delta → input_json_delta
 * - response.completed → message_delta + message_stop
 */
export async function* streamResponsesMessage(
  apiKey: string,
  baseUrl: string,
  body: ReturnType<typeof buildResponsesRequest>,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let response: Response
  try {
    // 走统一出口：APK 里由原生桥代发，避开第三方端点的 CORS 预检
    response = await nativeFetch(
      `${baseUrl.replace(/\/$/, '')}/responses`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      },
      true
    )
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && isRecord(parsed.error) && isString(parsed.error.message)) {
        message = parsed.error.message
      }
    } catch {
      // 非 JSON 错误体直接用原文
    }
    throw new ApiError('http', message, response.status)
  }
  if (!response.body) {
    throw new ApiError('protocol', 'Responses API response has no body')
  }

  const messageId = `responses-${Date.now()}`
  let nextIndex = 0
  /** item_id → 已打开的块 index */
  const openBlocks = new Map<string, { index: number; kind: 'thinking' | 'text' | 'tool' }>()
  /** function_call 的 item_id → call_id */
  const callIds = new Map<string, string>()
  /** 已经通过 delta 收到过参数的工具 item，用于避免 done 里重复追加 */
  const sentToolArgs = new Set<string>()
  let finished = false

  yield { type: 'message_start', message: { id: messageId, model: body.model } }

  const stopAll = (): MessageStreamEvent[] => {
    const events: MessageStreamEvent[] = []
    // 按 index 顺序关闭，避免上层看到乱序的 content_block_stop
    const entries = [...openBlocks.values()].sort((a, b) => a.index - b.index)
    for (const entry of entries) {
      events.push({ type: 'content_block_stop', index: entry.index })
    }
    openBlocks.clear()
    return events
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data.trim() === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (!isRecord(payload)) {
      continue
    }
    const type = isString(payload.type) ? payload.type : ''
    const itemId = isString(payload.item_id) ? payload.item_id : undefined

    if (type === 'response.output_item.added') {
      const item = isRecord(payload.item) ? payload.item : null
      const itemType = item && isString(item.type) ? item.type : ''
      const id = item && isString(item.id) ? item.id : ''
      if (itemType === 'reasoning' && id) {
        const index = nextIndex++
        openBlocks.set(id, { index, kind: 'thinking' })
        yield {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      } else if (itemType === 'function_call' && id) {
        const callId = item && isString(item.call_id) ? item.call_id : id
        callIds.set(id, callId)
        const index = nextIndex++
        openBlocks.set(id, { index, kind: 'tool' })
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: callId,
            name: item && isString(item.name) ? item.name : '',
            input: {},
          },
        }
      }
      continue
    }

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const entry = itemId ? openBlocks.get(itemId) : undefined
      if (entry && entry.kind === 'thinking' && isString(payload.delta)) {
        yield {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'thinking_delta', thinking: payload.delta },
        }
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      // 正文块可能没有 output_item.added（只在 content_part.added 里出现），
      // 因此第一次见到 delta 时补开块
      const key = itemId ?? 'text'
      let entry = openBlocks.get(key)
      if (!entry || entry.kind !== 'text') {
        const index = nextIndex++
        entry = { index, kind: 'text' }
        openBlocks.set(key, entry)
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
      }
      if (isString(payload.delta) && payload.delta) {
        yield {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'text_delta', text: payload.delta },
        }
      }
      continue
    }

    if (type === 'response.output_text.done') {
      const key = itemId ?? 'text'
      const entry = openBlocks.get(key)
      if (entry && entry.kind === 'text') {
        const citations = readCitations(payload.annotations)
        for (const citation of citations) {
          yield {
            type: 'content_block_delta',
            index: entry.index,
            delta: { type: 'citations_delta', citation },
          }
        }
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const entry = itemId ? openBlocks.get(itemId) : undefined
      if (entry && entry.kind === 'tool' && isString(payload.delta)) {
        if (itemId) {
          sentToolArgs.add(itemId)
        }
        yield {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'input_json_delta', partial_json: payload.delta },
        }
      }
      continue
    }

    if (type === 'response.function_call_arguments.done') {
      const entry = itemId ? openBlocks.get(itemId) : undefined
      // 多数实现已通过 delta 增量拼好参数；只有那些一个 delta 都不发、
      // 仅在 done 里给完整 arguments 的实现才需要补发。两者都发会导致
      // 参数被拼接两遍，模型拿到非法 JSON 后反复重试。
      if (
        entry &&
        entry.kind === 'tool' &&
        !sentToolArgs.has(itemId ?? '') &&
        isString(payload.arguments) &&
        payload.arguments
      ) {
        yield {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'input_json_delta', partial_json: payload.arguments },
        }
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const item = isRecord(payload.item) ? payload.item : null
      const id = item && isString(item.id) ? item.id : itemId
      if (id) {
        const entry = openBlocks.get(id)
        if (entry) {
          yield { type: 'content_block_stop', index: entry.index }
          openBlocks.delete(id)
        }
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const responseBody = isRecord(payload.response) ? payload.response : null
      const status = responseBody && isString(responseBody.status) ? responseBody.status : undefined
      const incomplete = isRecord(responseBody?.incomplete_details)
        ? responseBody.incomplete_details.reason
        : null
      for (const event of stopAll()) {
        yield event
      }
      const usage = readUsage(responseBody?.usage)
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: mapStatus(status, typeof incomplete === 'string' ? incomplete : null),
          stop_sequence: null,
        },
        ...(usage ? { usage } : {}),
      }
      finished = true
      break
    }

    if (type === 'response.failed' || type === 'error') {
      const responseBody = isRecord(payload.response) ? payload.response : null
      const error = responseBody && isRecord(responseBody.error) ? responseBody.error : null
      const detail = error && isString(error.message) ? error.message : isString(payload.message) ? payload.message : ''
      throw new ApiError('stream', detail || 'Responses API reported a failure')
    }
  }

  if (!finished) {
    for (const event of stopAll()) {
      yield event
    }
    throw new ApiError('interrupted', '')
  }

  yield { type: 'message_stop' }
}
