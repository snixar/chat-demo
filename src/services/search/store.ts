import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { useSettings } from '../settings.js'
import { canScrape, runScrape, runSearch } from './adapters.js'
import {
  SEARCH_SERVICES,
  defaultValues,
  serviceMeta,
  valueOf,
  type SearchOutcome,
  type SearchServiceConfig,
  type SearchServiceId,
  type SearchServiceMeta,
} from './types.js'

/**
 * 搜索服务配置存在 localStorage：本机偏好，不随会话走，也不进历史归档。
 *
 * 默认行为对齐 rikkahub：不配置任何服务时，用 DeepSeek 的搜索接口并复用
 * 已经填好的 DeepSeek API Key——这样填完 Key 就能直接联网搜索，无需额外设置。
 */

const SERVICES_KEY = 'chat-demo:search-services'
const SELECTED_KEY = 'chat-demo:search-selected'

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

const isServiceId = (value: unknown): value is SearchServiceId =>
  typeof value === 'string' && SEARCH_SERVICES.some((item) => item.id === value)

const isConfig = (value: unknown): value is SearchServiceConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const config = value as Partial<SearchServiceConfig>
  return (
    typeof config.id === 'string' &&
    isServiceId(config.serviceId) &&
    typeof config.name === 'string' &&
    typeof config.enabled === 'boolean' &&
    typeof config.values === 'object' &&
    config.values !== null
  )
}

const readServices = (): SearchServiceConfig[] => {
  const raw = readText(SERVICES_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isConfig) : []
  } catch {
    return []
  }
}

const readSelected = (): string | null => {
  const raw = readText(SELECTED_KEY)
  return raw && raw !== 'auto' ? raw : null
}

type SearchState = {
  services: SearchServiceConfig[]
  /** 选中的服务实例 id；null 表示自动（默认 DeepSeek） */
  selectedId: string | null
}

export const useSearchServices = create<SearchState>(() => ({
  services: readServices(),
  selectedId: readSelected(),
}))

const commit = (services: SearchServiceConfig[]) => {
  writeText(SERVICES_KEY, JSON.stringify(services))
  useSearchServices.setState({ services })
}

export const addSearchService = (serviceId: SearchServiceId): SearchServiceConfig => {
  const meta = serviceMeta(serviceId)
  const config: SearchServiceConfig = {
    id: createId().replace(/-/g, '').slice(0, 12),
    serviceId,
    name: meta.label,
    values: defaultValues(meta),
    enabled: true,
  }
  commit([...useSearchServices.getState().services, config])
  return config
}

export const updateSearchService = (
  id: string,
  patch: Partial<Omit<SearchServiceConfig, 'id'>>
) => {
  commit(
    useSearchServices.getState().services.map((item) => {
      if (item.id !== id) {
        return item
      }
      // values 单独合并，避免整块覆盖掉其他字段
      return { ...item, ...patch, values: { ...item.values, ...(patch.values ?? {}) } }
    })
  )
}

export const removeSearchService = (id: string) => {
  commit(useSearchServices.getState().services.filter((item) => item.id !== id))
  if (useSearchServices.getState().selectedId === id) {
    setSelectedSearchService(null)
  }
}

export const setSelectedSearchService = (id: string | null) => {
  if (id === null) {
    writeText(SELECTED_KEY, 'auto')
  } else {
    writeText(SELECTED_KEY, id)
  }
  useSearchServices.setState({ selectedId: id })
}

/**
 * 解析出实际要用的搜索服务。
 *
 * 顺序：
 * 1. 用户显式选中的实例（且已启用）；
 * 2. 第一台已启用的实例；
 * 3. 都没有时回退到 DeepSeek，用官方 API Key —— 填了 Key 就能搜。
 *
 * 返回 null 表示既没有配置也没有 Key，此时不注册搜索工具。
 */
export const resolveSearchService = (): SearchServiceConfig | null => {
  const { services, selectedId } = useSearchServices.getState()
  const enabled = services.filter((item) => item.enabled)
  if (selectedId) {
    const picked = enabled.find((item) => item.id === selectedId)
    if (picked) {
      return picked
    }
  }
  if (enabled.length > 0) {
    return enabled[0]
  }
  // 回退：DeepSeek + 官方 Key
  const officialKey = useSettings.getState().apiKey ?? ''
  if (officialKey.trim()) {
    return {
      id: 'default-deepseek',
      serviceId: 'deepseek',
      name: 'DeepSeek',
      values: { apiKey: officialKey },
      enabled: true,
    }
  }
  return null
}

/** 当前搜索服务的展示名；未配置时给出「默认 DeepSeek」 */
export const currentSearchLabel = (): string => {
  const { services, selectedId } = useSearchServices.getState()
  return searchLabelFrom(services, selectedId)
}

/**
 * 由给定的列表与选中项算出展示名。组件里订阅了这两项后调用它，
 * 避免再读一次 store 造成重复订阅或依赖数组告警。
 */
export const searchLabelFrom = (
  services: SearchServiceConfig[],
  selectedId: string | null
): string => {
  const enabled = services.filter((item) => item.enabled)
  const picked = selectedId ? enabled.find((item) => item.id === selectedId) : undefined
  const active = picked ?? enabled[0]
  if (active) {
    return active.name || serviceMeta(active.serviceId).label
  }
  // 没配置时靠官方 Key 回退到 DeepSeek
  return (useSettings.getState().apiKey ?? '').trim() ? 'DeepSeek' : ''
}

/** 当前是否具备可用的搜索能力 */
export const hasSearchService = (): boolean => resolveSearchService() !== null

/** 当前搜索服务是否支持抓取正文 */
export const currentCanScrape = (): boolean => {
  const config = resolveSearchService()
  return config ? canScrape(config) : false
}

/**
 * 把搜索结果整理成模型易读的文本。
 *
 * 每条结果都把 url 与 domain 明确列出，模型据此在正文里写
 * `[citation,domain](url)`——形如标准 Markdown 链接，渲染层能识别成来源角标。
 */
export const formatSearchOutcome = (outcome: SearchOutcome): string => {
  const parts: string[] = []
  if (outcome.answer) {
    parts.push(`Summary: ${outcome.answer}`)
  }
  if (outcome.items.length === 0) {
    parts.push('No results found.')
    return parts.join('\n\n')
  }
  const lines = outcome.items.map((item, index) => {
    const domain = domainOf(item.url)
    const head = `[${index + 1}] ${item.title || item.url}`
    const meta = [`index: ${index + 1}`, `url: ${item.url}`]
    if (domain) {
      meta.push(`domain: ${domain}`)
    }
    if (item.publishedDate) {
      meta.push(`publishedDate: ${item.publishedDate}`)
    }
    const body = item.text ? item.text.slice(0, 2000) : ''
    const highlights = item.highlights?.length
      ? `\nhighlights: ${item.highlights.join(' | ').slice(0, 1200)}`
      : ''
    return [head, meta.join(', '), body + highlights].filter(Boolean).join('\n')
  })
  parts.push(lines.join('\n\n'))
  if (outcome.images?.length) {
    parts.push(`images:\n${outcome.images.slice(0, 8).join('\n')}`)
  }
  return parts.join('\n\n')
}

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 执行搜索，返回给模型的文本 */
export const search = async (
  query: string,
  resultSize: number,
  signal: AbortSignal
): Promise<string> => {
  const config = resolveSearchService()
  if (!config) {
    throw new Error('还没有可用的搜索服务：请在设置里添加，或先填写 DeepSeek API Key')
  }
  assertUsable(config)
  const outcome = await runSearch({ config, query, resultSize, signal })
  return formatSearchOutcome(outcome)
}

/** 抓取网页正文，返回给模型的文本 */
export const scrape = async (url: string, signal: AbortSignal): Promise<string> => {
  const config = resolveSearchService()
  if (!config) {
    throw new Error('还没有可用的搜索服务：请在设置里添加，或先填写 DeepSeek API Key')
  }
  if (!canScrape(config)) {
    throw new Error(`${config.name || config.serviceId} 不支持抓取网页`)
  }
  assertUsable(config)
  const outcome = await runScrape({ config, url, signal })
  const content = outcome.content.trim()
  if (!content) {
    throw new Error('抓取没有返回正文')
  }
  // 正文可能很长，截断避免撑爆上下文
  const head = outcome.title ? `${outcome.title}\n${outcome.url}\n\n` : ''
  return `${head}${content.slice(0, 20_000)}`
}

/** 必填字段缺失时提前报错，比等 API 返回 401 更好懂 */
const assertUsable = (config: SearchServiceConfig) => {
  const meta: SearchServiceMeta = serviceMeta(config.serviceId)
  for (const field of meta.fields) {
    if (field.key === 'apiKey' && meta.needsKey && !valueOf(config, 'apiKey').trim()) {
      throw new Error(`${meta.label} 需要 API Key`)
    }
    if (field.key === 'url' && !valueOf(config, 'url').trim()) {
      throw new Error('请先填写实例地址')
    }
  }
}
