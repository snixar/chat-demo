import { create } from 'zustand'
import { useMcp } from '../../services/mcp/store.js'

/**
 * 新对话（尚未创建会话）时的 MCP 服务器选择。
 *
 * 会话创建后选择存在 `Session.mcpServerIds` 里；但欢迎页还没有 session，
 * 用户在发首条消息前就可能想先关掉某个服务器。这里临存这份选择，
 * 由 sendMessage 在创建会话时带进去。
 *
 * 语义是「记住用户上次的选择」：发完消息后**不清空**，因此下一个新对话
 * 沿用同一份开关状态，而不是每开一个新对话又把所有服务器全部打开。
 * 只有在首次使用（从未设置过）时才回退到「全部已启用」。
 */
export const useNewChatMcp = create<{ serverIds: string[] | null }>(() => ({ serverIds: null }))

/** 当前应生效的服务器 id：有自定义用自定义，否则用全部已启用的 */
export const resolveServerIds = (custom: string[] | null): string[] =>
  custom ??
  useMcp
    .getState()
    .servers.filter((item) => item.enabled)
    .map((item) => item.id)

export const toggleNewChatServer = (serverId: string, enabled: boolean) => {
  useNewChatMcp.setState((state) => {
    const current = resolveServerIds(state.serverIds)
    return {
      serverIds: enabled
        ? [...new Set([...current, serverId])]
        : current.filter((id) => id !== serverId),
    }
  })
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
    useNewChatMcp.setState({ serverIds })
  }
}
