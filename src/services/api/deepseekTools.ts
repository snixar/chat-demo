import { API_ORIGIN } from './client.js'

/**
 * DeepSeek 的搜索与抓取是独立的 JSON API，与聊天用的模型协议无关：
 * - POST /v1/tools/search  { query, count?, ... }
 * - POST /v1/tools/fetch   { url }
 *
 * 官方模型直接用服务端内置的 deepseek_web_search / deepseek_read_url 工具；
 * 自定义模型那边没有这些内置工具，就由客户端调这两个接口，再把结果喂回模型。
 * 鉴权用 DeepSeek 的 API Key（Bearer），与当前选中的模型无关。
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

/** 与客户端工具声明里用到的名称；两处必须一致 */
export const SEARCH_TOOL_NAME = 'deepseek_search'
export const FETCH_TOOL_NAME = 'deepseek_fetch'

export type SearchResultItem = {
  title?: string
  url?: string
  snippet?: string
  content?: string
  [key: string]: unknown
}

const postJson = async (path: string, apiKey: string, body: unknown, signal: AbortSignal) => {
  const response = await fetch(`${TOOLS_BASE_URL}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Search API ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as unknown
}

/**
 * 把搜索结果压成模型易读的文本：标题 + URL + 摘要。
 * 服务端字段可能变化，这里只取常见的几个并保留原始 JSON 兜底。
 */
const formatSearchResults = (payload: unknown): string => {
  const items = extractItems(payload)
  if (items.length === 0) {
    return 'No results found.'
  }
  return items
    .map((item, index) => {
      const title = typeof item.title === 'string' ? item.title : ''
      const url = typeof item.url === 'string' ? item.url : ''
      const snippet =
        typeof item.snippet === 'string'
          ? item.snippet
          : typeof item.content === 'string'
            ? item.content
            : ''
      return [
        `[${index + 1}] ${title || url}`,
        url ? `URL: ${url}` : '',
        snippet ? snippet.slice(0, 1200) : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

const extractItems = (payload: unknown): SearchResultItem[] => {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is SearchResultItem => typeof item === 'object' && item !== null
    )
  }
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const record = payload as Record<string, unknown>
  for (const key of ['results', 'data', 'items', 'search_results']) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is SearchResultItem => typeof item === 'object' && item !== null
      )
    }
  }
  return [payload as SearchResultItem]
}

/** 网页搜索：返回可读的搜索结果文本 */
export const searchWeb = async (
  apiKey: string,
  query: string,
  signal: AbortSignal
): Promise<string> => {
  const payload = await postJson('search', apiKey, { query, count: 8 }, signal)
  return formatSearchResults(payload)
}

/** 抓取网页：返回正文文本 */
export const fetchUrl = async (
  apiKey: string,
  url: string,
  signal: AbortSignal
): Promise<string> => {
  const payload = await postJson('fetch', apiKey, { url }, signal)
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    for (const key of ['content', 'text', 'data']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        // 正文可能很长，截断避免撑爆上下文
        return value.slice(0, 20_000)
      }
    }
  }
  return typeof payload === 'string'
    ? payload.slice(0, 20_000)
    : JSON.stringify(payload).slice(0, 20_000)
}
