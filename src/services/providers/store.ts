import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import {
  DEFAULT_SELECTION,
  officialModelLabel,
  type CustomModel,
  type CustomProvider,
  type ModelSelection,
  type OpenAIEndpoint,
  type ResolvedTarget,
} from './types.js'

/**
 * 自定义提供商与模型选择都存在 localStorage：它们是本机配置，不随会话走、
 * 也不进历史归档，和 API Key、MCP 服务器同层。
 */
const PROVIDERS_KEY = 'chat-demo:providers'
const SELECTION_KEY = 'chat-demo:model-selection'

const readText = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeText = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const isProtocol = (value: unknown) => value === 'anthropic' || value === 'openai'

/** 缺省视为 chatCompletions：老版本配置里没有这个字段 */
const isEndpoint = (value: unknown) =>
  value === undefined || value === 'chatCompletions' || value === 'responses'

const isOptionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'

const isModel = (value: unknown): value is CustomModel => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const model = value as Partial<CustomModel>
  return (
    typeof model.id === 'string' &&
    typeof model.modelId === 'string' &&
    typeof model.displayName === 'string' &&
    typeof model.supportsTools === 'boolean'
  )
}

const isProvider = (value: unknown): value is CustomProvider => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const provider = value as Partial<CustomProvider>
  return (
    typeof provider.id === 'string' &&
    typeof provider.name === 'string' &&
    isProtocol(provider.protocol) &&
    typeof provider.baseUrl === 'string' &&
    typeof provider.apiKey === 'string' &&
    typeof provider.enabled === 'boolean' &&
    isEndpoint(provider.openaiEndpoint) &&
    isOptionalBoolean(provider.includeReasoning) &&
    isOptionalBoolean(provider.builtInSearch) &&
    Array.isArray(provider.models) &&
    provider.models.every(isModel)
  )
}

const readProviders = (): CustomProvider[] => {
  const raw = readText(PROVIDERS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    // 早期版本点「添加提供商」就会落一条空记录，这里顺手清掉
    return parsed.filter(isProvider).filter((provider) => provider.name || provider.baseUrl)
  } catch {
    return []
  }
}

const readSelection = (): ModelSelection => {
  const raw = readText(SELECTION_KEY)
  if (!raw) {
    return DEFAULT_SELECTION
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_SELECTION
    }
    const selection = parsed as Partial<ModelSelection>
    if (selection.kind === 'official' && typeof selection.model === 'string') {
      return { kind: 'official', model: selection.model }
    }
    if (
      selection.kind === 'custom' &&
      typeof selection.providerId === 'string' &&
      typeof selection.modelId === 'string'
    ) {
      return { kind: 'custom', providerId: selection.providerId, modelId: selection.modelId }
    }
    return DEFAULT_SELECTION
  } catch {
    return DEFAULT_SELECTION
  }
}

type ProvidersState = {
  providers: CustomProvider[]
  selection: ModelSelection
}

export const useProviders = create<ProvidersState>(() => ({
  providers: readProviders(),
  selection: readSelection(),
}))

const commitProviders = (providers: CustomProvider[]) => {
  writeText(PROVIDERS_KEY, JSON.stringify(providers))
  useProviders.setState({ providers })
}

export const addProvider = (input: Omit<CustomProvider, 'id'> & { id?: string }) => {
  const provider: CustomProvider = { ...input, id: input.id ?? newProviderId() }
  commitProviders([...useProviders.getState().providers, provider])
  return provider
}

export const updateProvider = (id: string, patch: Partial<Omit<CustomProvider, 'id'>>) => {
  commitProviders(
    useProviders
      .getState()
      .providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider))
  )
}

export const removeProvider = (id: string) => {
  commitProviders(useProviders.getState().providers.filter((provider) => provider.id !== id))
  // 选中的模型被删时回退到官方，避免留下悬空引用
  const { selection } = useProviders.getState()
  if (selection.kind === 'custom' && selection.providerId === id) {
    setModelSelection(DEFAULT_SELECTION)
  }
}

export const newModelId = () => createId().replace(/-/g, '').slice(0, 12)

export const newProviderId = () => createId().replace(/-/g, '').slice(0, 12)

export const setModelSelection = (selection: ModelSelection) => {
  writeText(SELECTION_KEY, JSON.stringify(selection))
  useProviders.setState({ selection })
}

/**
 * 把当前选择解析成可用的请求目标。提供商或模型已不存在时返回官方默认，
 * 这样删除配置后不会让对话卡死。
 */
export const resolveModelTarget = (): ResolvedTarget => {
  const { providers, selection } = useProviders.getState()
  if (selection.kind === 'official') {
    return { kind: 'official', model: selection.model }
  }
  const provider = providers.find((item) => item.id === selection.providerId)
  const model = provider?.models.find((item) => item.id === selection.modelId)
  if (!provider || !model) {
    // 配置被删时回退到官方默认模型，避免对话卡死
    return { kind: 'official', model: 'deepseek-flash' }
  }
  return { kind: 'custom', provider, model }
}

/** 当前模型在界面上的展示名 */
export const currentModelLabel = (): string => {
  const target = resolveModelTarget()
  if (target.kind === 'official') {
    return officialModelLabel(target.model)
  }
  return target.model.displayName || target.model.modelId
}

/** 当前选择是否是某个自定义提供商下的模型 */
export const isSelected = (providerId: string, modelId: string) => {
  const { selection } = useProviders.getState()
  return (
    selection.kind === 'custom' &&
    selection.providerId === providerId &&
    selection.modelId === modelId
  )
}

/** OpenAI 兼容端点形态；Anthropic 协议下恒为 chatCompletions（无意义） */
export const openaiEndpointOf = (provider: CustomProvider): OpenAIEndpoint =>
  provider.protocol === 'openai' ? (provider.openaiEndpoint ?? 'chatCompletions') : 'chatCompletions'

/** 是否回传历史思考；缺省开启 */
export const includeReasoningOf = (provider: CustomProvider) => provider.includeReasoning !== false

/** 是否使用提供商自带的联网搜索；缺省关闭 */
export const builtInSearchOf = (provider: CustomProvider) => provider.builtInSearch === true
