import type { ChatModel } from '../api/types.js'

/** 自定义提供商使用的协议；官方 DeepSeek 走 Anthropic 兼容接口，不在此列 */
export type ProviderProtocol = 'anthropic' | 'openai'

/**
 * OpenAI 兼容端点内部的两种接口形态。
 *
 * - `chatCompletions`：POST {baseUrl}/chat/completions（绝大多数中转站）
 * - `responses`：POST {baseUrl}/responses（OpenAI 官方新接口，支持内置搜索与推理摘要）
 *
 * 中转站对二者的支持并不一致，因此做成提供商级开关而不是自动探测：
 * 探测失败会多发一次请求，而且错误被吞掉后很难排查。
 */
export type OpenAIEndpoint = 'chatCompletions' | 'responses'

/** 一个自定义模型 */
export type CustomModel = {
  id: string
  /** 发给 API 的 model 字段 */
  modelId: string
  displayName: string
  /** 是否向模型声明工具（MCP 与搜索）；关闭时只做纯文本对话 */
  supportsTools: boolean
}

/** 一台自定义提供商 */
export type CustomProvider = {
  id: string
  name: string
  protocol: ProviderProtocol
  /** 形如 https://api.example.com/v1，请求时在末尾拼 /chat/completions 或 /messages */
  baseUrl: string
  apiKey: string
  models: CustomModel[]
  enabled: boolean
  /** 仅 protocol === 'openai' 时生效；缺省按 chatCompletions 处理 */
  openaiEndpoint?: OpenAIEndpoint
  /**
   * 多轮对话时把历史助手消息的思考过程回传给服务端。
   * 缺省为 true：官方端点靠它维持推理连贯性；个别端点不接受该字段时手动关掉。
   */
  includeReasoning?: boolean
  /**
   * 使用提供商自带的联网搜索（Responses 的 web_search 工具、Chat Completions 的
   * web_search_options）。多数中转站会静默忽略，按需开启。
   */
  builtInSearch?: boolean
}

/**
 * 当前选中的模型。官方是深内置入的两个；自定义指向某台提供商下的某个模型。
 * 缺省时用 official + deepseek-flash，保证升级后行为不变。
 */
export type ModelSelection =
  | { kind: 'official'; model: ChatModel }
  | { kind: 'custom'; providerId: string; modelId: string }

/** 官方可选模型，与 ChatModel 保持一致 */
export const OFFICIAL_MODELS: { model: ChatModel; label: string }[] = [
  { model: 'deepseek-flash', label: 'DeepSeek Flash' },
  { model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]

export const DEFAULT_SELECTION: ModelSelection = { kind: 'official', model: 'deepseek-flash' }

/**
 * 实际发起请求的目标：官方或某台自定义提供商的具体模型。
 * resolve 失败（提供商被删、模型被删）时回退到官方默认模型。
 */
export type ResolvedTarget =
  | { kind: 'official'; model: ChatModel }
  | {
      kind: 'custom'
      provider: CustomProvider
      model: CustomModel
    }

/** 自定义模型的推理强度固定为 high，不提供选择 */
export const CUSTOM_REASONING_EFFORT = 'high'

/** 官方模型的展示名 */
export const officialModelLabel = (model: ChatModel) =>
  OFFICIAL_MODELS.find((item) => item.model === model)?.label ?? model
