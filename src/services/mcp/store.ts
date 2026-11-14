import { create } from 'zustand'
import type { McpServerConfig, McpTool, McpTransport } from './client.js'
import { createId } from '../../utils/id.js'

/**
 * MCP 服务器配置存在 localStorage，与 API Key 同层：它们是本机偏好，不属于会话内容，
 * 因此不进 IndexedDB、不进历史归档。
 */
const KEY = 'chat-demo:mcp-servers'

const read = (): McpServerConfig[] => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isServerConfig) : []
  } catch {
    return []
  }
}

const isServerConfig = (value: unknown): value is McpServerConfig => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const server = value as Partial<McpServerConfig>
  return (
    typeof server.id === 'string' &&
    typeof server.name === 'string' &&
    typeof server.url === 'string' &&
    (server.transport === 'streamableHttp' || server.transport === 'sse') &&
    typeof server.enabled === 'boolean' &&
    Array.isArray(server.headers)
  )
}

const write = (servers: McpServerConfig[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(servers))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

type McpState = {
  servers: McpServerConfig[]
  /** 每个服务器的连接状态与工具清单；键为服务器 id */
  connections: Record<string, ServerConnection>
}

export type ServerConnection = {
  status: 'idle' | 'connecting' | 'ready' | 'error'
  tools: McpTool[]
  /** 服务器自身名称，握手后才知道 */
  serverName?: string
  error?: string
}

export const useMcp = create<McpState>(() => ({
  servers: read(),
  connections: {},
}))

const commit = (servers: McpServerConfig[]) => {
  write(servers)
  useMcp.setState({ servers })
}

/** 新建服务器：未指定 id 时生成，名称为空时用 URL 的主机名兜底 */
export const addServer = (input: Omit<McpServerConfig, 'id'> & { id?: string }) => {
  const server: McpServerConfig = {
    ...input,
    id: input.id ?? createId().replace(/-/g, '').slice(0, 12),
    name: input.name.trim() || hostOf(input.url) || input.url,
  }
  commit([...useMcp.getState().servers, server])
  return server
}

/** 更新配置；改了 URL 或传输方式要让调用方重新连接 */
export const updateServer = (id: string, patch: Partial<Omit<McpServerConfig, 'id'>>) => {
  commit(
    useMcp.getState().servers.map((server) => (server.id === id ? { ...server, ...patch } : server))
  )
}

export const removeServer = (id: string) => {
  commit(useMcp.getState().servers.filter((server) => server.id !== id))
  setConnection(id, undefined)
}

export const setConnection = (id: string, connection: ServerConnection | undefined) => {
  useMcp.setState((state) => {
    if (connection) {
      return { connections: { ...state.connections, [id]: connection } }
    }
    // 删除则重建对象，避免动态 delete
    return {
      connections: Object.fromEntries(
        Object.entries(state.connections).filter(([key]) => key !== id)
      ) as Record<string, ServerConnection>,
    }
  })
}

/** 所有已连接服务器的工具，用于声明给模型 */
export const enabledServers = () => useMcp.getState().servers.filter((server) => server.enabled)

/**
 * 批量导入 MCP 配置（兼容常见的 `mcpServers` JSON 片段）。返回新增数量。
 * 名称重复的跳过，已有配置不受影响。
 */
export const importServersJson = (text: string): { added: number; error?: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { added: 0, error: 'invalid-json' }
  }
  const container =
    typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed
      ? (parsed as { mcpServers: unknown }).mcpServers
      : parsed
  if (typeof container !== 'object' || container === null) {
    return { added: 0, error: 'no-servers' }
  }
  const existing = new Set(useMcp.getState().servers.map((server) => server.name))
  const added: McpServerConfig[] = []
  for (const [name, raw] of Object.entries(container as Record<string, unknown>)) {
    if (!name.trim() || existing.has(name)) {
      continue
    }
    if (typeof raw !== 'object' || raw === null) {
      continue
    }
    const entry = raw as Record<string, unknown>
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    if (!url) {
      continue
    }
    const transport: McpTransport = entry.type === 'sse' ? 'sse' : 'streamableHttp'
    const headers = Object.entries(
      typeof entry.headers === 'object' && entry.headers !== null
        ? (entry.headers as Record<string, unknown>)
        : {}
    ).flatMap(([key, value]) => (typeof value === 'string' ? [{ name: key, value }] : []))
    added.push({
      id: createId().replace(/-/g, '').slice(0, 12),
      name,
      url,
      transport,
      headers,
      enabled: true,
    })
    existing.add(name)
  }
  if (added.length === 0) {
    return { added: 0, error: 'no-servers' }
  }
  commit([...useMcp.getState().servers, ...added])
  return { added: added.length }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || ''
  } catch {
    return ''
  }
}
