import { create } from 'zustand'
import { useMcp } from '../../services/mcp/store.js'

/**
 * 新对话（尚未创建会话）时的 MCP 服务器选择。
 *
 * 会话创建后选择存在 `Session.mcpServerIds` 里；但欢迎页还没有 session，
 * 用户在发首条消息前就可能想先关掉某个服务器。这里临存这份选择，
 * 由 sendMessage 在创建会话时带进去。
 *
 * null 表示「未自定义」，即使用全部已启用的服务器。
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

/** 发送成功后清空，下个新对话从默认值开始 */
export const resetNewChatMcp = () => useNewChatMcp.setState({ serverIds: null })
