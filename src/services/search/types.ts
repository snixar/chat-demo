/**
 * 搜索服务：由本应用在客户端调用第三方搜索 API，把结果作为工具结果喂回模型。
 *
 * 与「提供商自带搜索」是两条互斥的路径：
 * - 自带搜索由模型提供商云端执行（Responses 的 web_search 等），只在支持的端点上有效；
 * - 这里由客户端执行，因此任何模型（含不支持联网的中转站）都能用。
 *
 * 服务清单与各家的请求/解析细节对齐 rikkahub 的 search 模块，便于横向对照。
 * 唯一的例外是 rikkahub 的 Custom JS（依赖 QuickJS 沙箱），在浏览器里只能用 eval
 * 执行用户脚本，风险过高，因此不提供。
 */

/** 服务标识，与 rikkahub 的 @SerialName 保持一致 */
export type SearchServiceId =
  | 'deepseek'
  | 'tavily'
  | 'exa'
  | 'brave'
  | 'serper'
  | 'zhipu'
  | 'doubao'
  | 'bocha'
  | 'metaso'
  | 'ollama'
  | 'perplexity'
  | 'linkup'
  | 'jina'
  | 'firecrawl'
  | 'searxng'
  | 'bing_local'
  | 'grok'
  | 'tinyfish'
  | 'rikkahub'

/** 一条搜索结果 */
export type SearchResultItem = {
  title: string
  url: string
  text: string
  publishedDate?: string
  highlights?: string[]
}

/** 一次搜索的产出；answer 是服务商给出的 AI 总结（部分服务才有） */
export type SearchOutcome = {
  answer?: string
  items: SearchResultItem[]
  images?: string[]
}

/** 抓取一个网页的正文 */
export type ScrapeOutcome = {
  url: string
  content: string
  title?: string
}

/** 配置表单的字段描述，由通用表单渲染，避免为每家服务手写一套 UI */
export type SearchFieldSpec = {
  key: string
  label: string
  kind: 'text' | 'password' | 'number' | 'switch' | 'select'
  hint?: string
  placeholder?: string
  /** 未填写时的默认值（select 的默认项也放这里） */
  fallback?: string
  options?: { value: string; label: string }[]
}

export type SearchServiceMeta = {
  id: SearchServiceId
  label: string
  /** 是否必须填 API Key */
  needsKey: boolean
  /** 是否支持抓取网页正文（不支持时工具只声明 search_web） */
  hasScrape: boolean
  /** 列表里的一句话说明 */
  hint: string
  fields: SearchFieldSpec[]
}

const apiKeyField: SearchFieldSpec = {
  key: 'apiKey',
  label: 'API Key',
  kind: 'password',
  placeholder: 'sk-...',
}

/** 全部可选服务，顺序即设置页里的顺序 */
export const SEARCH_SERVICES: SearchServiceMeta[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    needsKey: true,
    hasScrape: true,
    hint: '官方 /v1/tools/search，支持 site:、after: 等查询操作符',
    fields: [apiKeyField],
  },
  {
    id: 'tavily',
    label: 'Tavily',
    needsKey: true,
    hasScrape: true,
    hint: '为 AI 优化的搜索，可返回总结与图片',
    fields: [
      apiKeyField,
      {
        key: 'depth',
        label: '搜索深度',
        kind: 'select',
        fallback: 'advanced',
        options: [
          { value: 'basic', label: 'basic' },
          { value: 'advanced', label: 'advanced' },
        ],
      },
      { key: 'includeAnswer', label: '返回 AI 总结', kind: 'switch', fallback: 'true' },
    ],
  },
  {
    id: 'exa',
    label: 'Exa',
    needsKey: true,
    hasScrape: true,
    hint: '语义搜索，可返回 AI 总结、发布时间与高亮片段',
    fields: [apiKeyField],
  },
  {
    id: 'brave',
    label: 'Brave',
    needsKey: true,
    hasScrape: false,
    hint: '独立索引的网页搜索',
    fields: [apiKeyField],
  },
  {
    id: 'serper',
    label: 'Serper',
    needsKey: true,
    hasScrape: false,
    hint: 'Google 结果代理，可返回答案框与知识图谱',
    fields: [apiKeyField],
  },
  {
    id: 'zhipu',
    label: '智谱',
    needsKey: true,
    hasScrape: false,
    hint: 'BigModel 网页搜索',
    fields: [apiKeyField],
  },
  {
    id: 'doubao',
    label: '豆包',
    needsKey: true,
    hasScrape: false,
    hint: '火山 Search Infinity，global 模式可返回图片',
    fields: [
      apiKeyField,
      {
        key: 'mode',
        label: '模式',
        kind: 'select',
        fallback: 'custom',
        options: [
          { value: 'custom', label: 'custom（web_search）' },
          { value: 'global', label: 'global（global_search）' },
        ],
      },
    ],
  },
  {
    id: 'bocha',
    label: '博查',
    needsKey: true,
    hasScrape: false,
    hint: '中文网页搜索，摘要质量较好',
    fields: [apiKeyField, { key: 'summary', label: '生成摘要', kind: 'switch', fallback: 'true' }],
  },
  {
    id: 'metaso',
    label: '秘塔',
    needsKey: true,
    hasScrape: false,
    hint: '秘塔网页搜索',
    fields: [apiKeyField],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    needsKey: true,
    hasScrape: true,
    hint: 'ollama.com 云端搜索（不是本地 Ollama）',
    fields: [apiKeyField],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    needsKey: true,
    hasScrape: false,
    hint: '返回 AI 总结与来源列表',
    fields: [
      apiKeyField,
      { key: 'maxTokens', label: '单次最大 Token', kind: 'number', placeholder: '留空则用服务端默认' },
      { key: 'maxTokensPerPage', label: '单页最大 Token', kind: 'number', placeholder: '留空' },
    ],
  },
  {
    id: 'linkup',
    label: 'LinkUp',
    needsKey: true,
    hasScrape: true,
    hint: '返回带引用的总结答案',
    fields: [
      apiKeyField,
      {
        key: 'depth',
        label: '深度',
        kind: 'select',
        fallback: 'standard',
        options: [
          { value: 'standard', label: 'standard' },
          { value: 'deep', label: 'deep' },
        ],
      },
    ],
  },
  {
    id: 'jina',
    label: 'Jina',
    needsKey: true,
    hasScrape: true,
    hint: 's.jina.ai 搜索 + r.jina.ai 抓取（转 Markdown）',
    fields: [
      apiKeyField,
      {
        key: 'searchUrl',
        label: '搜索地址',
        kind: 'text',
        fallback: 'https://s.jina.ai/',
      },
      { key: 'scrapeUrl', label: '抓取地址', kind: 'text', fallback: 'https://r.jina.ai/' },
    ],
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    needsKey: true,
    hasScrape: true,
    hint: '网页与新闻搜索，抓取输出 Markdown',
    fields: [apiKeyField],
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    needsKey: false,
    hasScrape: false,
    hint: '自建实例，需要在实例的 settings.yml 里开启 json 格式',
    fields: [
      {
        key: 'url',
        label: '实例地址',
        kind: 'text',
        placeholder: 'https://searx.example.com',
        hint: '实例的 settings.yml 需开启 json 输出格式',
      },
      { key: 'engines', label: '搜索引擎', kind: 'text', placeholder: 'google,bing（留空用实例默认）' },
      { key: 'language', label: '语言', kind: 'text', placeholder: 'zh-CN（留空用实例默认）' },
      { key: 'username', label: 'Basic Auth 用户名', kind: 'text', placeholder: '可选' },
      { key: 'password', label: 'Basic Auth 密码', kind: 'password', placeholder: '可选' },
    ],
  },
  {
    id: 'bing_local',
    label: 'Bing',
    needsKey: false,
    hasScrape: false,
    hint: '抓取 Bing 网页结果，无需 Key，但容易被风控拦截',
    fields: [],
  },
  {
    id: 'grok',
    label: 'Grok',
    needsKey: true,
    hasScrape: false,
    hint: 'xAI Responses 的内置搜索，返回总结与引用',
    fields: [
      apiKeyField,
      {
        key: 'model',
        label: '模型',
        kind: 'text',
        fallback: 'grok-4-1-fast-non-reasoning',
      },
      { key: 'customUrl', label: '接口地址', kind: 'text', fallback: 'https://api.x.ai/v1/responses' },
      {
        key: 'systemPrompt',
        label: '系统提示',
        kind: 'text',
        fallback: 'You are a helpful search assistant. Search the web to find accurate and up-to-date information. Provide a comprehensive answer with citations.',
      },
    ],
  },
  {
    id: 'tinyfish',
    label: 'Tinyfish',
    needsKey: true,
    hasScrape: true,
    hint: '搜索与抓取一体',
    fields: [apiKeyField],
  },
  {
    id: 'rikkahub',
    label: 'RikkaHub',
    needsKey: true,
    hasScrape: false,
    hint: 'RikkaHub 官方搜索服务',
    fields: [
      apiKeyField,
      {
        key: 'depth',
        label: '深度',
        kind: 'select',
        fallback: 'standard',
        options: [
          { value: 'standard', label: 'standard' },
          { value: 'deep', label: 'deep' },
        ],
      },
    ],
  },
]

export const serviceMeta = (id: SearchServiceId): SearchServiceMeta =>
  SEARCH_SERVICES.find((item) => item.id === id) ?? SEARCH_SERVICES[0]

/** 一个已添加的搜索服务实例（同一服务可以配多份，用于轮换 Key） */
export type SearchServiceConfig = {
  id: string
  serviceId: SearchServiceId
  /** 界面显示名，默认取服务名 */
  name: string
  /** 各字段的值，键为 SearchFieldSpec.key；apiKey 也在这里 */
  values: Record<string, string>
  enabled: boolean
}

/** 取字段值，未填时用默认值 */
export const valueOf = (
  config: SearchServiceConfig,
  key: string,
  fallback = ''
): string => {
  const raw = config.values[key]
  return raw !== undefined && raw !== '' ? raw : fallback
}

/** 取布尔字段 */
export const boolOf = (config: SearchServiceConfig, key: string, fallback: boolean): boolean => {
  const raw = config.values[key]
  if (raw === undefined || raw === '') {
    return fallback
  }
  return raw === 'true'
}

/** 取数字字段，非数字或空时返回 undefined */
export const numberOf = (config: SearchServiceConfig, key: string): number | undefined => {
  const raw = config.values[key]
  if (raw === undefined || raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 组装实例的表单默认值，用于新建时预填 */
export const defaultValues = (meta: SearchServiceMeta): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const field of meta.fields) {
    if (field.fallback) {
      values[field.key] = field.fallback
    }
  }
  return values
}
