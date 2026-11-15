import type { CustomTool } from '../api/types.js'
import { McpClient, McpError, parseQualifiedToolName, type McpTool } from './client.js'
import { enabledServers, setConnection, useMcp } from './store.js'

/**
 * MCP 工具注册表：维护每个服务器的长期连接，聚合工具清单，并负责把一次 tool_use
 * 路由到正确的服务器执行。
 *
 * 连接按需建立并复用（MCP 握手有开销，同一会话可能连续调用多个工具），
 * 服务器配置变化或调用失败时丢弃连接，下次使用时重建。
 */

type Entry = { client: McpClient; tools: McpTool[] }

const clients = new Map<string, Entry>()
/** 同一服务器的并发连接只建一次 */
const connecting = new Map<string, Promise<Entry>>()

/** 建立（或复用）连接并拉取工具清单 */
const ensureConnection = async (serverId: string): Promise<Entry> => {
  const existing = clients.get(serverId)
  if (existing) {
    return existing
  }
  const pending = connecting.get(serverId)
  if (pending) {
    return pending
  }
  const server = useMcp.getState().servers.find((item) => item.id === serverId)
  if (!server) {
    throw new McpError('protocol', `Unknown MCP server: ${serverId}`)
  }
  setConnection(serverId, { status: 'connecting', tools: [] })
  const task = (async () => {
    const client = new McpClient(server)
    try {
      await client.connect()
      const tools = await client.listTools()
      const entry: Entry = { client, tools }
      clients.set(serverId, entry)
      setConnection(serverId, {
        status: 'ready',
        tools,
        serverName: client.serverName,
      })
      return entry
    } catch (error) {
      client.close()
      const message = error instanceof Error ? error.message : String(error)
      setConnection(serverId, { status: 'error', tools: [], error: message })
      throw error
    } finally {
      connecting.delete(serverId)
    }
  })()
  connecting.set(serverId, task)
  return task
}

/** 丢弃连接，用于配置变更或强制重连 */
export const resetConnection = (serverId: string) => {
  clients.get(serverId)?.client.close()
  clients.delete(serverId)
  setConnection(serverId, undefined)
}

export const resetAllConnections = () => {
  for (const [id] of clients) {
    resetConnection(id)
  }
}

/** 测试连接：只看能否握手、拿到多少工具，不建立长期连接 */
export const testConnection = async (serverId: string) => {
  const server = useMcp.getState().servers.find((item) => item.id === serverId)
  if (!server) {
    throw new McpError('protocol', `Unknown MCP server: ${serverId}`)
  }
  const client = new McpClient(server)
  try {
    await client.connect()
    const tools = await client.listTools()
    const serverName = client.serverName
    setConnection(serverId, { status: 'ready', tools, serverName })
    clients.set(serverId, { client, tools })
    return { tools, serverName }
  } catch (error) {
    client.close()
    const message = error instanceof Error ? error.message : String(error)
    setConnection(serverId, { status: 'error', tools: [], error: message })
    throw error
  }
}

/**
 * 连接所有启用的服务器并汇总工具。单个服务器失败只记录状态，不影响其他服务器：
 * MCP 服务器常常不常开，一个连不上不应该让整轮对话失败。
 */
export const loadAllTools = async (
  serverIds?: string[]
): Promise<{ tools: McpTool[]; failures: string[] }> => {
  // 传入 serverIds 时只连这些（会话级开关）；否则用全部启用的服务器
  const servers =
    serverIds === undefined
      ? enabledServers()
      : enabledServers().filter((server) => serverIds.includes(server.id))
  const tools: McpTool[] = []
  const failures: string[] = []
  await Promise.all(
    servers.map(async (server) => {
      try {
        const entry = await ensureConnection(server.id)
        const disabled = new Set(server.disabledTools ?? [])
        tools.push(...entry.tools.filter((tool) => !disabled.has(tool.name)))
      } catch {
        failures.push(server.id)
      }
    })
  )
  return { tools, failures }
}

/** 已连接服务器的工具，不做网络请求；用于构造请求时快速取用 */
export const getReadyTools = (): McpTool[] =>
  enabledServers().flatMap((server) => {
    const disabled = new Set(server.disabledTools ?? [])
    return (clients.get(server.id)?.tools ?? []).filter((tool) => !disabled.has(tool.name))
  })

/** 转成 API 的工具声明 */
export const toCustomTools = (tools: McpTool[]): CustomTool[] =>
  tools.map((tool) => ({
    name: tool.qualifiedName,
    description: tool.description || tool.name,
    input_schema: tool.inputSchema,
  }))

/**
 * 找到某工具所属的服务器。
 *
 * 必须在这里也校验「服务器已启用」与「工具未被停用」：clients 缓存里可能还留着
 * 用户刚关掉的服务器或工具的连接，而声明阶段（getReadyTools / loadAllTools）已经把它们
 * 过滤掉了。若执行阶段不校验，模型只要写对名字就能调用界面上已经停用的工具。
 */
const findServerForTool = (qualifiedName: string) => {
  const parsed = parseQualifiedToolName(qualifiedName)
  if (!parsed) {
    return null
  }
  const server = enabledServers().find((item) => item.id === parsed.serverId)
  if (!server || server.disabledTools?.includes(parsed.toolName)) {
    return null
  }
  const entry = clients.get(parsed.serverId)
  const tool = entry?.tools.find((item) => item.qualifiedName === qualifiedName)
  if (!entry || !tool) {
    return null
  }
  return { serverId: parsed.serverId, tool }
}

/* ---------- 本地工具（内置能力，不经 MCP 服务器） ---------- */

/** 本地工具：由应用自己实现，例如调 DeepSeek 的搜索 API */
type LocalTool = {
  name: string
  description: string
  inputSchema: CustomTool['input_schema']
  run: (input: unknown, signal: AbortSignal) => Promise<string>
}

/**
 * 本地工具按会话隔离存放。
 *
 * 多个会话可以同时生成（streaming 以会话为键），而工具集取决于该会话使用的模型
 * 与搜索开关。若共用一份全局表，后开始的会话会清掉或覆盖先开始的那个，
 * 表现为「明明声明了却调不到」或「调到了没声明的工具」。
 */
const localToolsBySession = new Map<string, Map<string, LocalTool>>()

/** 注册一个会话的本地工具；同名覆盖，便于按当前开关动态调整 */
export const registerLocalTools = (sessionId: string, tools: LocalTool[]) => {
  localToolsBySession.set(sessionId, new Map(tools.map((tool) => [tool.name, tool])))
}

export const clearLocalTools = (sessionId: string) => {
  localToolsBySession.delete(sessionId)
}

/** 该会话的本地工具转成声明给模型的格式 */
export const localToolsDeclaration = (sessionId: string): CustomTool[] =>
  [...(localToolsBySession.get(sessionId)?.values() ?? [])].map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))

/**
 * 执行一个客户端工具：先查本会话的本地工具（搜索/抓取），再查 MCP 服务器。
 * 返回文本结果；失败时抛错，由调用方包成 is_error 的 tool_result ——
 * 模型能读到错误信息并自行决定下一步，比整轮失败更有用。
 *
 * declared 是本轮实际声明给模型的 MCP 工具名。执行时必须落在集合内：
 * 会话可能只启用了一部分服务器，或模型的工具声明被整体关闭，
 * 此时模型仍可能凭名字构造出 tool_use，不能让它绕过声明直接执行。
 */
export const callTool = async (
  sessionId: string,
  qualifiedName: string,
  input: unknown,
  signal: AbortSignal,
  declared: ReadonlySet<string>
) => {
  const local = localToolsBySession.get(sessionId)?.get(qualifiedName)
  if (local) {
    return local.run(input, signal)
  }
  if (!declared.has(qualifiedName)) {
    throw new McpError('tool', `Tool was not declared for this request: ${qualifiedName}`)
  }
  const target = findServerForTool(qualifiedName)
  if (!target) {
    throw new McpError('tool', `Unknown, disabled or disconnected tool: ${qualifiedName}`)
  }
  const entry = clients.get(target.serverId)
  if (!entry) {
    throw new McpError('tool', `MCP server is not connected: ${target.serverId}`)
  }
  return entry.client.callTool(target.tool.name, input, signal)
}

/** 当前是否有任何已连接的工具 */
export const hasReadyTools = () => getReadyTools().length > 0
