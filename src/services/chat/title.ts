import { streamMessage } from '../api/client.js'
import { buildOpenAIRequest, streamOpenAIMessage } from '../api/openai.js'
import { buildResponsesRequest, streamResponsesMessage } from '../api/responses.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import { officialModelLabel, type ResolvedTarget } from '../providers/types.js'
import { includeReasoningOf, openaiEndpointOf } from '../providers/store.js'
import { useSettings } from '../settings.js'

/**
 * 会话标题生成。
 *
 * 用**当前对话所用的模型**发一次极小的请求：官方走 anthropic 兼容接口，
 * 自定义提供商按它自己的协议与地址，因此标题的语言与质量跟正文一致。
 *
 * 只在第一次对话结束后调用一次（见 store 里的 firstRound 判断），
 * 之后不再生成——避免每轮都花一次请求。
 */

/** 标题的系统提示：明确只输出标题，避免模型附带解释 */
const TITLE_SYSTEM = '你是一个标题生成器，只输出标题本身，不要任何解释或标点包装。'

const MAX_TITLE_LENGTH = 24

/** 把首条用户消息交给模型起标题 */
const buildPrompt = (text: string) =>
  `请为下面这条用户消息生成一个简洁的标题，不超过 16 个字。只输出标题本身，不要引号、不要句号、不要解释。\n\n${text.slice(0, 2000)}`

/**
 * 去掉模型可能加上的包装：引号、书名号、`标题：` 前缀、句末标点。
 * 这些在客户端统一清理，不必依赖模型严格遵守格式。
 */
const normalizeTitle = (raw: string): string => {
  let text = raw.trim()
  // 多行时取第一段有效内容
  text = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  text = text.replace(/^(标题|title)\s*[:：]\s*/i, '')
  text = text.replace(/^["'“”「『《]+/, '').replace(/["'“”」』》]+$/, '')
  text = text.replace(/[。.！!？?，,；;]+$/, '')
  text = text.replace(/\s+/g, ' ').trim()
  // 超长时按字符截断，避免标题撑破侧边栏
  return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) : text
}

/** 把流里所有正文增量拼起来 */
const collectText = async (events: AsyncGenerator<{ type: string; [key: string]: unknown }>) => {
  let text = ''
  for await (const event of events) {
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text
      }
    }
  }
  return text
}

/** 按目标提供商构造标题请求并取回标题文本 */
export const requestSessionTitle = async (
  target: ResolvedTarget,
  firstMessage: string,
  signal: AbortSignal
): Promise<string> => {
  const messages: MessageParam[] = [{ role: 'user', content: buildPrompt(firstMessage) }]
  let raw = ''

  if (target.kind === 'official') {
    raw = await collectText(
      streamMessage(
        // 官方请求用设置里保存的 Key
        useSettings.getState().apiKey ?? '',
        {
          model: target.model,
          system: TITLE_SYSTEM,
          messages,
          thinking: { type: 'disabled' },
          safety_check: { level: 'high' },
          tools: [],
        },
        signal
      )
    )
  } else if (target.provider.protocol === 'anthropic') {
    raw = await collectText(
      streamMessage(
        target.provider.apiKey,
        {
          model: target.model.modelId,
          system: TITLE_SYSTEM,
          messages,
          thinking: { type: 'disabled' },
          safety_check: { level: 'high' },
          tools: [],
        } as unknown as CreateMessageRequest,
        signal,
        target.provider.baseUrl
      )
    )
  } else if (openaiEndpointOf(target.provider) === 'responses') {
    raw = await collectText(
      streamResponsesMessage(
        target.provider.apiKey,
        target.provider.baseUrl,
        buildResponsesRequest({
          model: target.model.modelId,
          system: TITLE_SYSTEM,
          messages,
          tools: [],
          thinking: false,
          includeReasoning: includeReasoningOf(target.provider),
          // 标题不需要联网，避免多花一次搜索的钱
          builtInSearch: false,
        }),
        signal
      )
    )
  } else {
    raw = await collectText(
      streamOpenAIMessage(
        target.provider.apiKey,
        target.provider.baseUrl,
        buildOpenAIRequest(
          {
            model: target.model.modelId,
            system: TITLE_SYSTEM,
            messages,
            thinking: { type: 'disabled' },
            safety_check: { level: 'high' },
            tools: [],
          } as unknown as CreateMessageRequest,
          target.model.modelId,
          undefined,
          {
            includeReasoning: includeReasoningOf(target.provider),
            // 标题不需要联网，避免多花一次搜索的钱
            builtInSearch: false,
          }
        ),
        signal
      )
    )
  }

  const title = normalizeTitle(raw)
  if (!title) {
    // 模型没给出可用文本时用首句兜底，比一直显示「新对话」好
    return normalizeTitle(firstMessage) || officialModelLabel('deepseek-flash')
  }
  return title
}
