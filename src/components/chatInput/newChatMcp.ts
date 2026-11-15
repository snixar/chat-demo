import { create } from 'zustand'
import { useMcp } from '../../services/mcp/store.js'
import { parseStoredIds, pruneIds, serializeStoredIds } from '../../utils/persistedIds.js'

/**
 * 新对话（尚未创建会话）时的 MCP 服务器选择。
 *
 * 会话创建后选择存在 `Session.mcpServerIds` 里；但欢迎页还没有 session，
 * 用户在发首条消息前就可能想先关掉某个服务器。这里临存这份选择，
 * 由 sendMessage 在创建会话时带进去。
 *
 * 语义是「记住用户上次的选择」：发完消息后**不清空**，因此下一个新对话
 * 沿用同一份开关状态，而不是每开一个新对话又把所有服务器全部打开。
 * 只有从未设置过时才回退到「全部已启用」。
 *
 * 这份选择必须持久化：它只存在内存时，刷新页面或重开应用就回到 null，
 * 而 null 表示「全部启用」，用户会看到关掉的服务器又自己打开了。
 * 与其它本机偏好一致，存 localStorage（不属于会话内容，不进历史归档）。
 */
const KEY = 'chat-demo:new-chat-mcp'

const read = (): string[] | null => {
  try {
    return parseStoredIds(localStorage.getItem(KEY))
  } catch {
    return null
  }
}

const write = (serverIds: string[] | null) => {
  try {
    const value = serializeStoredIds(serverIds)
    if (value === null) {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

export const useNewChatMcp = create<{ serverIds: string[] | null }>(() => ({ serverIds: read() }))

/** 当前应生效的服务器 id：有自定义用自定义，否则用全部已启用的 */
export const resolveServerIds = (custom: string[] | null): string[] =>
  custom ??
  useMcp
    .getState()
    .servers.filter((item) => item.enabled)
    .map((item) => item.id)

/**
 * 记忆里可能残留已删除的服务器 id，用到时按现有配置过滤掉。
 * 新添加的服务器不在记忆里，因此默认是关闭的——由用户显式打开，
 * 比悄悄替用户多开一台服务器更安全。
 */
const commit = (serverIds: string[]) => {
  const existing = new Set(useMcp.getState().servers.map((server) => server.id))
  const next = pruneIds(serverIds, existing)
  write(next)
  useNewChatMcp.setState({ serverIds: next })
}

export const toggleNewChatServer = (serverId: string, enabled: boolean) => {
  const current = resolveServerIds(useNewChatMcp.getState().serverIds)
  commit(
    enabled ? [...new Set([...current, serverId])] : current.filter((id) => id !== serverId)
  )
}

/**
 * 记住这次会话实际使用的服务器集合，供下一个新对话沿用。
 *
 * 之前发送后会调用 reset 把它清回 null，而 null 表示「全部已启用」，
 * 于是每个新对话都会重新打开所有服务器——这就是「MCP 状态没保持」的原因。
 */
export const rememberNewChatServers = (serverIds: string[] | undefined) => {
  // undefined 表示该会话没显式记录过选择，保持当前值不动
  if (serverIds !== undefined) {
    commit(serverIds)
  }
}
