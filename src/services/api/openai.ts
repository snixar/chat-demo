import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import type {
  AssistantBlockParam,
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  StopReason,
  TextCitation,
} from './types.js'

/**
 * OpenAI 兼容协议（Chat Completions）适配层。
 *
 * 只做协议翻译，不碰聊天逻辑：
 * - 请求侧：把内部 MessageParam[] 转成 OpenAI 的 messages
 * - 响应侧：把 OpenAI 的 SSE 增量转成内部的 MessageStreamEvent
 *
 * 这样 applyEvent / reply.ts / 视图推导 / UI 全部沿用现有实现。
 */

type OpenAITextPart = { type: 'text'; text: string }
type OpenAIImagePart = { type: 'image_url'; image_url: { url: string } }
type OpenAIContentPart = OpenAITextPart | OpenAIImagePart

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIRequest = {
  model: string
  messages: OpenAIMessage[]
  stream: true
  /** 自定义模型固定 high */
  reasoning_effort?: string
  /** 部分实现用这个字段开关思维链 */
  thinking?: { type: 'enabled' | 'disabled' }
  tools?: {
    type: 'function'
    function: { name: string; description?: string; parameters: unknown }
  }[]
  [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/* ---------- 请求转换 ---------- */

/**
 * 内部 user 内容块转 OpenAI。附件块（image/document）用的是 Anthropic 的 file_id，
 * OpenAI 兼容端点无法识别，因此自定义模型下不参与请求。
 */
const toUserContent = (blocks: { type: string; text?: string }[]) =>
  blocks.flatMap((block): OpenAIContentPart[] =>
    block.type === 'text' && typeof block.text === 'string'
      ? [{ type: 'text', text: block.text }]
      : []
  )

/**
 * 把内部的 assistant 内容块转成 OpenAI 的 assistant 消息。
 * tool_use → tool_calls；thinking 不回传（OpenAI 兼容端点普遍不接受）。
 */
const toAssistantMessage = (blocks: AssistantBlockParam[]): OpenAIMessage => {
  const text: string[] = []
  const toolCalls: OpenAIToolCall[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      text.push(block.text)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }
  const content = text.join('')
  return {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/** 内部消息列表转 OpenAI messages；工具结果单独成 role:"tool" 消息 */
const toMessages = (messages: MessageParam[]): OpenAIMessage[] => {
  const result: OpenAIMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      // Chat Engine 的扩展角色，OpenAI 兼容端点不认识，折叠成 system 说明
      result.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      result.push(toAssistantMessage(message.content))
      continue
    }
    if (typeof message.content === 'string') {
      result.push({ role: 'user', content: message.content })
      continue
    }
    // 工具结果与文本可能混在同一条 user 消息里，按类型拆开
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content,
        })
      }
    }
    const parts = toUserContent(
      message.content.filter((block) => block.type !== 'tool_result') as {
        type: string
        text?: string
      }[]
    )
    if (parts.length > 0) {
      result.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      })
    }
  }
  return result
}

/**
 * 构造 OpenAI 请求体。reasoningEffort 只在开启思考时传，固定 high。
 */
export const buildOpenAIRequest = (
  body: CreateMessageRequest,
  model: string,
  reasoningEffort: string | undefined
): OpenAIRequest => {
  const tools = body.tools.flatMap((tool) => {
    // 服务端工具（deepseek_web_search / deepseek_read_url）在 OpenAI 兼容端点下由客户端实现，
    // 到这里仍然只是普通函数声明
    if ('input_schema' in tool) {
      return [
        {
          type: 'function' as const,
          function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.input_schema,
          },
        },
      ]
    }
    // 服务端内置工具没有 input_schema，OpenAI 兼容端点无法声明，跳过
    return []
  })

  return {
    model,
    messages: [{ role: 'system', content: body.system }, ...toMessages(body.messages)],
    stream: true,
    ...(body.thinking.type === 'enabled'
      ? {
          // 两个字段都发：前者是 OpenAI 系普遍认的强度，后者让兼容 DeepSeek 语义的服务端也生效
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          thinking: { type: 'enabled' as const },
        }
      : { thinking: { type: 'disabled' as const } }),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/* ---------- 响应转换 ---------- */

type OpenAIDelta = {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
}

type OpenAIChunk = {
  id?: string
  model?: string
  choices?: {
    index?: number
    delta?: OpenAIDelta
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const mapFinishReason = (reason: string | null | undefined): StopReason => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  return 'end_turn'
}

/**
 * POST {baseUrl}/chat/completions（stream: true），把 OpenAI 的增量翻译成内部事件。
 *
 * 内部事件要求按 content_block_start → content_block_delta* → content_block_stop 的顺序，
 * 因此这里维护一个「当前块」状态机：思考块与文本块各自占用一个 index，工具调用按 index 分别跟踪。
 */
export async function* streamOpenAIMessage(
  apiKey: string,
  baseUrl: string,
  body: OpenAIRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })
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
    throw new ApiError('protocol', 'OpenAI-compatible response has no body')
  }

  const messageId = `openai-${Date.now()}`
  /** 当前正在输出的块：thinking(0) 或 text(1)，两者互斥 */
  let openKind: 'thinking' | 'text' | null = null
  let nextIndex = 0
  let thinkingIndex = -1
  let textIndex = -1
  /** 工具调用：OpenAI 用工具自己的 index，这里映射成独立的块 index */
  const toolIndexes = new Map<number, number>()
  const toolArgs = new Map<number, string>()
  const toolNames = new Map<number, string>()
  const toolIds = new Map<number, string>()
  let finished = false

  yield {
    type: 'message_start',
    message: { id: messageId, model: body.model },
  }

  const stopBlock = (): MessageStreamEvent[] => {
    if (openKind === null) {
      return []
    }
    const index = openKind === 'thinking' ? thinkingIndex : textIndex
    openKind = null
    return [{ type: 'content_block_stop', index }]
  }

  const startBlock = (kind: 'thinking' | 'text'): MessageStreamEvent[] => {
    if (openKind === kind) {
      return []
    }
    const events = stopBlock()
    const index = nextIndex++
    if (kind === 'thinking') {
      thinkingIndex = index
    } else {
      textIndex = index
    }
    openKind = kind
    const block: OutputBlockStart =
      kind === 'thinking'
        ? { type: 'thinking', thinking: '', signature: '' }
        : { type: 'text', text: '' }
    events.push({ type: 'content_block_start', index, content_block: block })
    return events
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    // 流结束标记
    if (data.trim() === '[DONE]') {
      break
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (!isRecord(chunk)) {
      continue
    }
    const parsed = chunk as OpenAIChunk
    const choice = parsed.choices?.[0]
    if (!choice) {
      // 部分实现把 usage 单独放在最后一帧
      if (parsed.usage) {
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: {
            input_tokens: parsed.usage.prompt_tokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: parsed.usage.completion_tokens ?? 0,
          },
        }
        finished = true
      }
      continue
    }
    const delta = choice.delta ?? {}

    // 思维链
    if (isString(delta.reasoning_content) && delta.reasoning_content) {
      for (const event of startBlock('thinking')) {
        yield event
      }
      yield {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      }
    }

    // 正文
    if (isString(delta.content) && delta.content) {
      for (const event of startBlock('text')) {
        yield event
      }
      const citations = readCitations(delta)
      yield {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
      for (const citation of citations) {
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'citations_delta', citation },
        }
      }
    }

    // 工具调用：分片下发参数，先收 id/name，再累积 arguments
    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0
      if (call.id) {
        toolIds.set(key, call.id)
      }
      if (call.function?.name) {
        toolNames.set(key, call.function.name)
      }
      const partial = call.function?.arguments
      if (isString(partial)) {
        toolArgs.set(key, (toolArgs.get(key) ?? '') + partial)
      }
      // 第一次见到这个工具时开块；参数可能已经在这同一帧里带了一部分
      if (!toolIndexes.has(key) && toolIds.has(key) && toolNames.has(key)) {
        for (const event of stopBlock()) {
          yield event
        }
        const index = nextIndex++
        toolIndexes.set(key, index)
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: toolIds.get(key) ?? `call_${key}`,
            name: toolNames.get(key) ?? '',
            input: {},
          },
        }
      }
      if (toolIndexes.has(key) && isString(partial)) {
        yield {
          type: 'content_block_delta',
          index: toolIndexes.get(key) ?? 0,
          delta: { type: 'input_json_delta', partial_json: partial },
        }
      }
    }

    if (choice.finish_reason) {
      if (finished) {
        continue
      }
      for (const event of stopBlock()) {
        yield event
      }
      // 关闭所有工具块
      for (const index of toolIndexes.values()) {
        yield { type: 'content_block_stop', index }
      }
      toolIndexes.clear()
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: mapFinishReason(choice.finish_reason),
          stop_sequence: null,
        },
        ...(parsed.usage
          ? {
              usage: {
                input_tokens: parsed.usage.prompt_tokens ?? 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: parsed.usage.completion_tokens ?? 0,
              },
            }
          : {}),
      }
      finished = true
    }
  }

  if (!finished) {
    // 流在 finish_reason 之前断掉：按已收到的内容收尾，交给上层判断
    for (const event of stopBlock()) {
      yield event
    }
    throw new ApiError('interrupted', '')
  }

  yield { type: 'message_stop' }
}

/**
 * 部分兼容实现会把引用放在 delta.citations（结构同 Anthropic）。
 * 标准 OpenAI 没有这个字段，取不到就返回空数组。
 */
const readCitations = (delta: unknown): TextCitation[] => {
  if (!isRecord(delta) || !Array.isArray(delta.citations)) {
    return []
  }
  return delta.citations.filter(
    (item): item is TextCitation =>
      isRecord(item) &&
      item.type === 'web_search_result_location' &&
      isString(item.url) &&
      (item.title === null || isString(item.title))
  )
}
