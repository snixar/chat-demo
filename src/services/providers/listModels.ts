import { mcpFetch } from '../mcp/client.js'
import type { ProviderProtocol } from './types.js'

/**
 * 拉取提供商的模型列表（GET {baseUrl}/models）。
 *
 * 走 mcpFetch 而不是裸 fetch：自定义提供商的地址常在局域网或自建服务上，
 * 往往没有 CORS 头，APK 里也默认禁止明文 http。原生桥能绕开这两个限制，
 * 浏览器里 mcpFetch 会自动退化为普通 fetch。
 */

export type RemoteModel = {
  id: string
  /** 提供商给出的展示名，缺省时用 id */
  name: string
  ownedBy?: string
}

type OpenAIModelEntry = {
  id?: unknown
  object?: unknown
  owned_by?: unknown
}

type AnthropicModelEntry = {
  id?: unknown
  display_name?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 从响应体里取出模型数组：兼容 OpenAI 的 {data:[...]} 与 Anthropic 的 {data:[...]} */
const extractModels = (payload: unknown): RemoteModel[] => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return []
  }
  const models: RemoteModel[] = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) {
      continue
    }
    const id = (raw as OpenAIModelEntry).id
    if (typeof id !== 'string' || !id.trim()) {
      continue
    }
    // Anthropic 用 display_name，OpenAI 没有展示名字段
    const displayName = (raw as AnthropicModelEntry).display_name
    const ownedBy = (raw as OpenAIModelEntry).owned_by
    models.push({
      id,
      name: typeof displayName === 'string' && displayName.trim() ? displayName : id,
      ...(typeof ownedBy === 'string' && ownedBy ? { ownedBy } : {}),
    })
  }
  // 按名称排序，便于查找
  return models.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 请求模型列表。baseUrl 末尾的斜杠会被去掉再拼 /models。
 * 失败时抛出带可读原因的 Error，由界面直接展示。
 */
export const fetchProviderModels = async ({
  protocol,
  baseUrl,
  apiKey,
  signal,
}: {
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  signal: AbortSignal
}): Promise<RemoteModel[]> => {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  // 两种协议都接受 Bearer；Anthropic 官方也支持 Authorization 头
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(apiKey
      ? protocol === 'anthropic'
        ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` }
        : { Authorization: `Bearer ${apiKey}` }
      : {}),
  }
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
  }

  const response = await mcpFetch(url, { method: 'GET', headers, signal })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || `${response.status} ${response.statusText}`
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed) && isRecord(parsed.error)) {
        const detail = parsed.error.message
        if (typeof detail === 'string' && detail) {
          message = detail
        }
      }
    } catch {
      // 非 JSON 错误体直接用原文
    }
    throw new Error(message)
  }
  const payload = (await response.json()) as unknown
  return extractModels(payload)
}
