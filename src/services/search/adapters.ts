import { API_ORIGIN } from '../api/client.js'
import { nativeFetch } from '../http/nativeFetch.js'
import {
  boolOf,
  numberOf,
  valueOf,
  type ScrapeOutcome,
  type SearchOutcome,
  type SearchResultItem,
  type SearchServiceConfig,
} from './types.js'

/**
 * 各家搜索服务的请求与解析。
 *
 * 请求一律走 nativeFetch：APK 里由原生桥代发，网页版直接用 fetch。
 * 第三方搜索 API 基本都不返回 CORS 头，浏览器的裸 fetch 会被预检拦下。
 *
 * 结果条数与字段映射照 rikkahub 的实现对齐，便于排查差异。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** 发一次 JSON 请求，非 2xx 时尽量取出服务端的错误说明 */
const requestJson = async (
  url: string,
  {
    method = 'POST',
    headers = {},
    body,
    signal,
  }: {
    method?: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: unknown
    signal: AbortSignal
  }
): Promise<unknown> => {
  const response = await nativeFetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    let message = text || `${response.status} ${response.statusText}`
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) {
        const error = isRecord(parsed.error) ? parsed.error : null
        const detail =
          (error && str(error.message)) ||
          str(parsed.message) ||
          str(parsed.msg) ||
          (isRecord(parsed.ResponseMetadata) && isRecord(parsed.ResponseMetadata.Error)
            ? str(parsed.ResponseMetadata.Error.Message)
            : '')
        if (detail) {
          message = detail
        }
      }
    } catch {
      // 非 JSON 错误体直接用原文
    }
    throw new Error(message)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('搜索服务返回的不是 JSON')
  }
}

const toItem = (raw: {
  title?: string
  url?: string
  text?: string
  publishedDate?: string
  highlights?: string[]
}): SearchResultItem => ({
  title: raw.title ?? '',
  url: raw.url ?? '',
  text: raw.text ?? '',
  ...(raw.publishedDate ? { publishedDate: raw.publishedDate } : {}),
  ...(raw.highlights && raw.highlights.length > 0 ? { highlights: raw.highlights } : {}),
})

/** 丢掉没有 URL 的条目，避免模型拿到无法引用的结果 */
const clean = (items: SearchResultItem[], limit: number): SearchResultItem[] =>
  items.filter((item) => item.url.trim() !== '').slice(0, limit)

/* ---------- 各服务实现 ---------- */

type SearchContext = {
  config: SearchServiceConfig
  query: string
  resultSize: number
  signal: AbortSignal
}

type ScrapeContext = {
  config: SearchServiceConfig
  url: string
  signal: AbortSignal
}

const SEARCH_QUERY_DESCRIPTION =
  'Concise search keywords, not a full sentence. Write them in the language the best sources are written in.'

export { SEARCH_QUERY_DESCRIPTION }

/* ---- DeepSeek ---- */

const deepseekSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson(`${API_ORIGIN}/v1/tools/search`, {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { query, count: Math.min(Math.max(resultSize, 1), 50) },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.results : undefined).flatMap((raw) => {
    if (!isRecord(raw)) {
      return []
    }
    const summary = str(raw.summary)
    const snippet = str(raw.snippet)
    return [
      toItem({
        title: str(raw.title),
        url: str(raw.url),
        text: summary || snippet,
        publishedDate: str(raw.date) || undefined,
      }),
    ]
  })
  return { items: clean(items, resultSize) }
}

const deepseekScrape = async ({
  config,
  url,
  signal,
}: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson(`${API_ORIGIN}/v1/tools/fetch`, {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { url },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  return { url, content: str(record.content), title: str(record.title) || undefined }
}

/* ---- Tavily ---- */

const tavilySearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://api.tavily.com/search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: {
      query,
      max_results: resultSize,
      search_depth: valueOf(config, 'depth', 'advanced'),
      include_answer: boolOf(config, 'includeAnswer', true) ? 'advanced' : false,
      include_images: true,
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const items = arr(record.results).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.content) })]
      : []
  )
  const images = arr(record.images).flatMap((value) => (typeof value === 'string' ? [value] : []))
  const answer = str(record.answer)
  return {
    ...(answer ? { answer } : {}),
    items: clean(items, resultSize),
    ...(images.length > 0 ? { images } : {}),
  }
}

const tavilyScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson('https://api.tavily.com/extract', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { urls: [url] },
    signal,
  })
  const first = arr(isRecord(payload) ? payload.results : undefined).find(isRecord)
  return {
    url: (first && str(first.url)) || url,
    content: first ? str(first.raw_content) : '',
  }
}

/* ---- Exa ---- */

const exaSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://api.exa.ai/search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: {
      query,
      numResults: resultSize,
      type: 'auto',
      contents: { text: { maxCharacters: 8000 }, highlights: { maxCharacters: 1200 } },
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const items = arr(record.results).flatMap((raw) =>
    isRecord(raw)
      ? [
          toItem({
            title: str(raw.title),
            url: str(raw.url),
            text: str(raw.text),
            publishedDate: str(raw.publishedDate) || undefined,
            highlights: arr(raw.highlights).flatMap((h) =>
              typeof h === 'string' ? [h] : []
            ),
          }),
        ]
      : []
  )
  const images = arr(record.results).flatMap((raw) =>
    isRecord(raw) && str(raw.image) ? [str(raw.image)] : []
  )
  // deep 搜索会在 output.content 里给带引用的总结
  const output = isRecord(record.output) ? record.output : null
  const answer = output ? str(output.content) : ''
  return {
    ...(answer ? { answer } : {}),
    items: clean(items, resultSize),
    ...(images.length > 0 ? { images } : {}),
  }
}

const exaScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson('https://api.exa.ai/contents', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { urls: [url], text: { maxCharacters: 8000 } },
    signal,
  })
  const first = arr(isRecord(payload) ? payload.results : undefined).find(isRecord)
  return {
    url: (first && str(first.url)) || url,
    content: first ? str(first.text) : '',
    title: first ? str(first.title) || undefined : undefined,
  }
}

/* ---- Brave ---- */

const braveSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const params = new URLSearchParams({ q: query, count: String(resultSize) })
  const payload = await requestJson(
    `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
    {
      method: 'GET',
      // Brave 用这个头而不是 Bearer
      headers: { 'X-Subscription-Token': valueOf(config, 'apiKey') },
      signal,
    }
  )
  const web = isRecord(payload) && isRecord(payload.web) ? payload.web : null
  const items = arr(web?.results).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.description) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

/* ---- Serper ---- */

const serperSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://google.serper.dev/search', {
    headers: { 'X-API-KEY': valueOf(config, 'apiKey') },
    body: { q: query, num: resultSize },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const items = arr(record.organic).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.link), text: str(raw.snippet) })]
      : []
  )
  // 答案框优先，其次知识图谱描述
  const answerBox = isRecord(record.answerBox) ? record.answerBox : null
  const graph = isRecord(record.knowledgeGraph) ? record.knowledgeGraph : null
  const answer =
    (answerBox && (str(answerBox.answer) || str(answerBox.snippet))) ||
    (graph ? str(graph.description) : '')
  return { ...(answer ? { answer } : {}), items: clean(items, resultSize) }
}

/* ---- 智谱 ---- */

const zhipuSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://open.bigmodel.cn/api/paas/v4/web_search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { search_query: query, search_engine: 'search_std', count: resultSize },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.search_result : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.link), text: str(raw.content) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

/* ---- 豆包 ---- */

const doubaoSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const key = valueOf(config, 'apiKey')
  const mode = valueOf(config, 'mode', 'custom')
  if (mode === 'global') {
    const payload = await requestJson('https://open.feedcoopapi.com/search_api/global_search', {
      headers: { Authorization: `Bearer ${key}` },
      body: {
        Query: query,
        DocCount: Math.min(Math.max(resultSize, 1), 20),
        MaxSnippetLength: 300,
        MaxImageCountPerDoc: 1,
      },
      signal,
    })
    const record = isRecord(payload) ? payload : {}
    assertDoubaoOk(record, true)
    const result = isRecord(record.Result) ? record.Result : {}
    const items = arr(result.Documents).flatMap((raw) => {
      if (!isRecord(raw)) {
        return []
      }
      const text = arr(raw.Snippet)
        .flatMap((s) => (isRecord(s) ? [str(s.Text)] : []))
        .filter(Boolean)
        .join('\n')
      return [toItem({ title: str(raw.Title), url: str(raw.Url), text })]
    })
    const images = arr(result.Documents).flatMap((raw) =>
      isRecord(raw)
        ? arr(raw.Snippet).flatMap((s) =>
            isRecord(s) && isRecord(s.Image) && str(s.Image.ImageUrl) ? [str(s.Image.ImageUrl)] : []
          )
        : []
    )
    return {
      items: clean(items, resultSize),
      ...(images.length > 0 ? { images: [...new Set(images)] } : {}),
    }
  }
  const payload = await requestJson('https://open.feedcoopapi.com/search_api/web_search', {
    headers: { Authorization: `Bearer ${key}` },
    body: {
      Query: query,
      SearchType: 'web',
      Count: Math.min(Math.max(resultSize, 1), 50),
      QueryControl: { QueryRewrite: false },
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  assertDoubaoOk(record, false)
  const result = isRecord(record.Result) ? record.Result : {}
  const items = arr(result.WebResults).flatMap((raw) => {
    if (!isRecord(raw)) {
      return []
    }
    const summary = str(raw.Summary)
    return [
      toItem({
        title: str(raw.Title),
        url: str(raw.Url),
        text: summary.trim() ? summary : str(raw.Snippet),
      }),
    ]
  })
  return { items: clean(items, resultSize) }
}

/** 豆包把错误放在 ResponseMetadata.Error 里，HTTP 仍是 200 */
const assertDoubaoOk = (payload: Record<string, unknown>, global: boolean) => {
  const meta = isRecord(payload.ResponseMetadata) ? payload.ResponseMetadata : null
  const error = meta && isRecord(meta.Error) ? meta.Error : null
  const code = error ? num(error.Code) : undefined
  if (error && code !== undefined && code !== 0) {
    throw new Error(str(error.Message) || `豆包搜索失败（${code}）`)
  }
  if (global) {
    const result = isRecord(payload.Result) ? payload.Result : null
    const resultCode = result ? num(result.ErrorCode) : undefined
    if (result && resultCode !== undefined && resultCode !== 0) {
      throw new Error(str(result.ErrorMsg) || `豆包搜索失败（${resultCode}）`)
    }
  }
}

/* ---- 博查 ---- */

const bochaSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://api.bochaai.com/v1/web-search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: {
      query,
      summary: boolOf(config, 'summary', true),
      count: resultSize,
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const code = num(record.code)
  if (code !== undefined && code !== 200) {
    throw new Error(str(record.msg) || `博查搜索失败（${code}）`)
  }
  const data = isRecord(record.data) ? record.data : {}
  const pages = isRecord(data.webPages) ? data.webPages : {}
  const items = arr(pages.value).flatMap((raw) => {
    if (!isRecord(raw)) {
      return []
    }
    const summary = str(raw.summary)
    return [
      toItem({
        title: str(raw.name),
        url: str(raw.url),
        text: summary.trim() ? summary : str(raw.snippet),
      }),
    ]
  })
  return { items: clean(items, resultSize) }
}

/* ---- 秘塔 ---- */

const metasoSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://metaso.cn/api/v1/search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { q: query, scope: 'webpage', size: resultSize, includeSummary: false },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.webpages : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.link), text: str(raw.snippet) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

/* ---- Ollama ---- */

const ollamaSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson('https://ollama.com/api/web_search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    // 服务端只接受 5..10
    body: { query, max_results: Math.min(Math.max(resultSize, 5), 10) },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.results : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.content) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

const ollamaScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson('https://ollama.com/api/web_fetch', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { url },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  return { url, content: str(record.content), title: str(record.title) || undefined }
}

/* ---- Perplexity ---- */

const perplexitySearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const maxTokens = numberOf(config, 'maxTokens')
  const maxTokensPerPage = numberOf(config, 'maxTokensPerPage')
  const payload = await requestJson('https://api.perplexity.ai/search', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: {
      query,
      max_results: resultSize,
      ...(maxTokens && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
      ...(maxTokensPerPage && maxTokensPerPage > 0
        ? { max_tokens_per_page: maxTokensPerPage }
        : {}),
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const items = arr(record.results).flatMap((raw) => {
    if (!isRecord(raw)) {
      return []
    }
    const title = str(raw.title)
    const url = str(raw.url)
    if (!title.trim() || !url.trim()) {
      return []
    }
    return [toItem({ title, url, text: str(raw.snippet) || str(raw.text) })]
  })
  const answer = str(record.answer)
  return { ...(answer ? { answer } : {}), items: clean(items, resultSize) }
}

/* ---- LinkUp / RikkaHub（同一形状） ---- */

const linkupLike =
  (endpoint: string, label: string) =>
  async ({ config, query, resultSize, signal }: SearchContext): Promise<SearchOutcome> => {
    const payload = await requestJson(endpoint, {
      headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
      body: {
        q: query,
        depth: valueOf(config, 'depth', 'standard'),
        outputType: 'sourcedAnswer',
        // 官方示例里这个字段是字符串而不是布尔
        includeImages: 'false',
      },
      signal,
    })
    const record = isRecord(payload) ? payload : {}
    const items = arr(record.sources).flatMap((raw) =>
      isRecord(raw)
        ? [toItem({ title: str(raw.name), url: str(raw.url), text: str(raw.snippet) })]
        : []
    )
    const answer = str(record.answer)
    if (!answer && items.length === 0) {
      throw new Error(`${label} 没有返回结果`)
    }
    return { ...(answer ? { answer } : {}), items: clean(items, resultSize) }
  }

const linkupSearch = linkupLike('https://api.linkup.so/v1/search', 'LinkUp')
const rikkahubSearch = linkupLike('https://api.rikka-ai.com/v1/search', 'RikkaHub')

const linkupScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson('https://api.linkup.so/v1/fetch', {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { url, includeRawHtml: false, renderJs: false, extractImages: false },
    signal,
  })
  return { url, content: str(isRecord(payload) ? payload.markdown : undefined) }
}

/* ---- Jina ---- */

const jinaSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson(valueOf(config, 'searchUrl', 'https://s.jina.ai/'), {
    headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
    body: { q: query },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.data : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.description) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

const jinaScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson(valueOf(config, 'scrapeUrl', 'https://r.jina.ai/'), {
    headers: {
      Authorization: `Bearer ${valueOf(config, 'apiKey')}`,
      // 让服务端直接返回 Markdown 正文
      'X-Return-Format': 'markdown',
    },
    body: { url },
    signal,
  })
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null
  return {
    url: (data && str(data.url)) || url,
    content: data ? str(data.content) : '',
    title: data ? str(data.title) || undefined : undefined,
  }
}

/* ---- Firecrawl ---- */

const firecrawlSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const key = valueOf(config, 'apiKey')
  const payload = await requestJson('https://api.firecrawl.dev/v2/search', {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: { query, limit: resultSize, sources: ['web'] },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  const data = isRecord(record.data) ? record.data : {}
  const webItems = arr(data.web).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.description) })]
      : []
  )
  const newsItems = arr(data.news).flatMap((raw) => {
    if (!isRecord(raw)) {
      return []
    }
    // 新闻结果没有独立字段，日期只能拼进正文
    const snippet = str(raw.snippet)
    const date = str(raw.date)
    return [
      toItem({
        title: str(raw.title),
        url: str(raw.url),
        text: date ? `${snippet}\n${date}` : snippet,
      }),
    ]
  })
  return { items: clean([...webItems, ...newsItems], resultSize) }
}

const firecrawlScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const key = valueOf(config, 'apiKey')
  const payload = await requestJson('https://api.firecrawl.dev/v2/scrape', {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: {
      url,
      onlyMainContent: true,
      // 48 小时内的缓存可以直接复用
      maxAge: 172_800_000,
      formats: ['markdown'],
    },
    signal,
  })
  const record = isRecord(payload) ? payload : {}
  if (record.success !== true) {
    throw new Error('Firecrawl 抓取失败')
  }
  const data = isRecord(record.data) ? record.data : {}
  return { url, content: str(data.markdown) }
}

/* ---- SearXNG ---- */

const searxngSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const base = valueOf(config, 'url').trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('请先填写 SearXNG 实例地址')
  }
  const params = new URLSearchParams({ q: query, format: 'json' })
  const engines = valueOf(config, 'engines').trim()
  const language = valueOf(config, 'language').trim()
  if (engines) {
    params.set('engines', engines)
  }
  if (language) {
    params.set('language', language)
  }
  const username = valueOf(config, 'username')
  const password = valueOf(config, 'password')
  const basic: Record<string, string> =
    username && password ? { Authorization: `Basic ${btoa(`${username}:${password}`)}` } : {}
  const payload = await requestJson(`${base}/search?${params.toString()}`, {
    method: 'GET',
    headers: basic,
    signal,
  })
  const items = arr(isRecord(payload) ? payload.results : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.content) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

/* ---- Bing（抓 HTML） ---- */

/**
 * 抓一个 HTML 页面，手动跟随重定向。
 *
 * 原生 HttpBridge 明确不跟随重定向（MCP 的 endpoint 语义依赖原始响应），
 * 而 bing.com 会 302 到地区站点，因此这里自己跟几跳。
 * 浏览器里 fetch 已经跟完了，不会走到这段。
 */
const fetchHtml = async (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; text: string }> => {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    const response = await nativeFetch(current, { method: 'GET', headers, signal })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location')
      if (!location) {
        break
      }
      current = new URL(location, current).toString()
      continue
    }
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, text }
  }
  throw new Error('页面重定向次数过多')
}

/**
 * Bing 没有公开查询 API，这里抓结果页并用正则取 li.b_algo 里的链接与摘要。
 * 浏览器环境没有 DOM 解析器，也不需要——只取三处固定结构。
 */
const bingSearch = async ({
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const params = new URLSearchParams({ q: query })
  const { ok, status, text: html } = await fetchHtml(
    `https://www.bing.com/search?${params.toString()}`,
    {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      // 不带 UA 时 Bing 会返回精简页，拿不到结果
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      // 固定区域设置，避免每次都先跳一次
      Cookie: 'SRCHHPGUSR=ULSR=1',
    },
    signal
  )
  if (!ok || !html) {
    throw new Error(`Bing 返回 ${status}`)
  }
  const items: SearchResultItem[] = []
  // 每个结果是一段 <li class="b_algo">…</li>，先粗切再逐段取字段
  const blocks = html.split(/<li class="b_algo"/).slice(1)
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!anchor) {
      continue
    }
    const url = decodeHtml(anchor[1])
    const title = stripTags(anchor[2])
    const caption = /<p[^>]*class="[^"]*b_(?:caption|lineclamp)[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block)
    items.push(toItem({ title, url, text: caption ? stripTags(caption[1]) : '' }))
    if (items.length >= resultSize) {
      break
    }
  }
  if (items.length === 0) {
    throw new Error('Bing 没有解析到结果，可能被风控拦截了')
  }
  return { items }
}

const stripTags = (html: string): string =>
  decodeHtml(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

const decodeHtml = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

/* ---- Grok（走 xAI Responses） ---- */

const grokSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const payload = await requestJson(
    valueOf(config, 'customUrl', 'https://api.x.ai/v1/responses'),
    {
      headers: { Authorization: `Bearer ${valueOf(config, 'apiKey')}` },
      body: {
        model: valueOf(config, 'model', 'grok-4-1-fast-non-reasoning'),
        input: [
          { role: 'system', content: valueOf(config, 'systemPrompt') },
          { role: 'user', content: query },
        ],
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        store: false,
      },
      signal,
    }
  )
  const record = isRecord(payload) ? payload : {}
  const output = arr(record.output).find(
    (item) => isRecord(item) && item.type === 'message' && item.role === 'assistant'
  )
  const message = isRecord(output) ? output : null
  const textPart = arr(message?.content).find(
    (part) => isRecord(part) && part.type === 'output_text'
  )
  const textPartRecord = isRecord(textPart) ? textPart : null
  const answer = textPartRecord ? str(textPartRecord.text) : ''
  // 引用里只有 URL，没有可用的标题，直接用 URL 当标题
  const items = arr(textPartRecord?.annotations).flatMap((raw) => {
    if (!isRecord(raw) || raw.type !== 'url_citation') {
      return []
    }
    const url = str(raw.url)
    return url ? [toItem({ title: url, url, text: '' })] : []
  })
  const unique = [...new Map(items.map((item) => [item.url, item])).values()]
  return { ...(answer ? { answer } : {}), items: clean(unique, resultSize) }
}

/* ---- Tinyfish ---- */

const tinyfishSearch = async ({
  config,
  query,
  resultSize,
  signal,
}: SearchContext): Promise<SearchOutcome> => {
  const params = new URLSearchParams({ query })
  const payload = await requestJson(`https://api.search.tinyfish.ai?${params.toString()}`, {
    method: 'GET',
    headers: { 'X-API-Key': valueOf(config, 'apiKey') },
    signal,
  })
  const items = arr(isRecord(payload) ? payload.results : undefined).flatMap((raw) =>
    isRecord(raw)
      ? [toItem({ title: str(raw.title), url: str(raw.url), text: str(raw.snippet) })]
      : []
  )
  return { items: clean(items, resultSize) }
}

const tinyfishScrape = async ({ config, url, signal }: ScrapeContext): Promise<ScrapeOutcome> => {
  const payload = await requestJson('https://api.fetch.tinyfish.ai', {
    headers: { 'X-API-Key': valueOf(config, 'apiKey') },
    body: { urls: [url], format: 'markdown' },
    signal,
  })
  const first = arr(isRecord(payload) ? payload.results : undefined).find(isRecord)
  return {
    url: (first && str(first.url)) || url,
    content: first ? str(first.text) : '',
    title: first ? str(first.title) || undefined : undefined,
  }
}

/* ---------- 分派 ---------- */

type Adapter = {
  search: (context: SearchContext) => Promise<SearchOutcome>
  scrape?: (context: ScrapeContext) => Promise<ScrapeOutcome>
}

const ADAPTERS: Record<string, Adapter> = {
  deepseek: { search: deepseekSearch, scrape: deepseekScrape },
  tavily: { search: tavilySearch, scrape: tavilyScrape },
  exa: { search: exaSearch, scrape: exaScrape },
  brave: { search: braveSearch },
  serper: { search: serperSearch },
  zhipu: { search: zhipuSearch },
  doubao: { search: doubaoSearch },
  bocha: { search: bochaSearch },
  metaso: { search: metasoSearch },
  ollama: { search: ollamaSearch, scrape: ollamaScrape },
  perplexity: { search: perplexitySearch },
  linkup: { search: linkupSearch, scrape: linkupScrape },
  jina: { search: jinaSearch, scrape: jinaScrape },
  firecrawl: { search: firecrawlSearch, scrape: firecrawlScrape },
  searxng: { search: searxngSearch },
  bing_local: { search: bingSearch },
  grok: { search: grokSearch },
  tinyfish: { search: tinyfishSearch, scrape: tinyfishScrape },
  rikkahub: { search: rikkahubSearch },
}

/** 执行一次搜索；未实现的服务直接报错，让模型知道换路 */
export const runSearch = async (context: SearchContext): Promise<SearchOutcome> => {
  const adapter = ADAPTERS[context.config.serviceId]
  if (!adapter) {
    throw new Error(`不支持的搜索服务：${context.config.serviceId}`)
  }
  return adapter.search(context)
}

/** 该服务能否抓取正文 */
export const canScrape = (config: SearchServiceConfig): boolean =>
  ADAPTERS[config.serviceId]?.scrape !== undefined

/** 执行一次抓取 */
export const runScrape = async (context: ScrapeContext): Promise<ScrapeOutcome> => {
  const adapter = ADAPTERS[context.config.serviceId]
  if (!adapter?.scrape) {
    throw new Error(`${context.config.serviceId} 不支持抓取网页`)
  }
  return adapter.scrape(context)
}
