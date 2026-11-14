import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useMcp } from '../../services/mcp/store.js'
import { toggleSessionServer, useChatStore } from '../../services/chat/store.js'
import { resolveServerIds, toggleNewChatServer, useNewChatMcp } from './newChatMcp.js'
import styles from './McpServerPicker.module.css'

/**
 * MCP 服务器选择页（嵌在附件面板的子页面里），布局对齐 rikkahub 的 McpPicker：
 * 每台服务器一整行 —— 左侧状态图标、名称、状态说明与工具数、右侧开关。
 * 整行可点，开关只反映状态。
 */
export const McpServerPicker = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const servers = useMcp((state) => state.servers.filter((item) => item.enabled))
  const connections = useMcp((state) => state.connections)
  const sessionIds = useChatStore((state) =>
    sessionId !== null && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]?.mcpServerIds
      : undefined
  )
  const newChatIds = useNewChatMcp((state) => state.serverIds)
  const streaming = useChatStore((state) =>
    sessionId === null ? false : Object.hasOwn(state.streaming, sessionId)
  )

  const enabledIds =
    sessionId === null ? resolveServerIds(newChatIds) : (sessionIds ?? resolveServerIds(null))

  if (servers.length === 0) {
    return (
      <div className={styles.empty}>
        <span>{t('settingsMcpEmptyTitle')}</span>
        <span className={styles.emptyHint}>{t('settingsMcpPickerEmptyHint')}</span>
      </div>
    )
  }

  const toggle = (serverId: string, enabled: boolean) => {
    if (sessionId === null) {
      // 新对话：先存到临存选择里，首条消息发出时带入会话
      toggleNewChatServer(serverId, enabled)
      return
    }
    toggleSessionServer(sessionId, serverId, enabled)
  }

  return (
    <div className={styles.list}>
      {servers.map((server, index) => {
        const checked = enabledIds.includes(server.id)
        const connection = connections[server.id]
        const status = connection?.status ?? 'idle'
        const toolCount = connection?.tools.length ?? 0
        const totalTools = connection?.tools.length ?? 0
        const errorMessage = connection?.error

        return (
          <button
            key={server.id}
            type="button"
            className={clsx(
              styles.item,
              index === 0 && styles.first,
              index === servers.length - 1 && styles.last
            )}
            aria-pressed={checked}
            disabled={streaming}
            onClick={() => toggle(server.id, !checked)}
          >
            <span className={styles.leading}>
              <StatusIcon status={status} hasError={Boolean(errorMessage)} />
            </span>
            <span className={styles.body}>
              <span className={styles.titleRow}>
                <span className={styles.name}>{server.name}</span>
                {status === 'ready' ? (
                  <span className={styles.tag}>
                    {t('settingsMcpToolTag', { enabled: toolCount, total: totalTools })}
                  </span>
                ) : null}
              </span>
              <span
                className={clsx(styles.status, errorMessage && styles.statusError)}
                title={errorMessage}
              >
                {errorMessage ?? statusLabel(status, t)}
              </span>
            </span>
            <span className={styles.trailing}>
              <span
                role="switch"
                aria-checked={checked}
                className={clsx(styles.switch, checked && styles.switchOn)}
              />
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** 状态文案与 rikkahub 一致：Idle / Connecting / Connected / Error */
const statusLabel = (
  status: string,
  t: (
    key:
      | 'settingsMcpStatusIdle'
      | 'settingsMcpStatusConnecting'
      | 'settingsMcpStatusReady'
      | 'settingsMcpStatusError'
  ) => string
) => {
  if (status === 'ready') {
    return t('settingsMcpStatusReady')
  }
  if (status === 'connecting') {
    return t('settingsMcpStatusConnecting')
  }
  if (status === 'error') {
    return t('settingsMcpStatusError')
  }
  return t('settingsMcpStatusIdle')
}

const StatusIcon = ({ status, hasError }: { status: string; hasError: boolean }) => {
  if (status === 'connecting') {
    return <span className={styles.spinner} />
  }
  if (status === 'error' || hasError) {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="12" cy="16.4" r="0.95" fill="currentColor" />
      </svg>
    )
  }
  if (status === 'ready') {
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="4" y="5" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <rect x="4" y="13" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7.5" cy="8" r="0.9" fill="currentColor" />
        <circle cx="7.5" cy="16" r="0.9" fill="currentColor" />
      </svg>
    )
  }
  // 未连接：括号占位图标，与 rikkahub 的 Icon1stBracket 语义一致
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h2M15 4h2a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
