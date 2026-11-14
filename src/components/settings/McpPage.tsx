import { useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  addServer,
  importServersJson,
  removeServer,
  updateServer,
  useMcp,
} from '../../services/mcp/store.js'
import { resetConnection, testConnection } from '../../services/mcp/tools.js'
import type { McpServerConfig, McpTransport } from '../../services/mcp/client.js'
import { screenStyles as styles } from './SettingsScreen.js'
import { ImportIcon, PlusIcon } from './settingsIcons.js'

/**
 * MCP 服务器列表。布局沿用 rikkahub：一台服务器一张独立卡片，
 * 左侧状态图标、右侧大标题 + 状态点 + 传输方式标签，错误信息内联在卡片里。
 * 配色与字号用 DeepSeek 的值。
 */
export const McpPage = ({ onOpenServer }: { onOpenServer: (id: string) => void }) => {
  const t = useTranslate()
  const servers = useMcp((state) => state.servers)
  const [importing, setImporting] = useState(false)

  if (importing) {
    return <ImportForm onDone={() => setImporting(false)} />
  }

  return (
    <>
      {servers.length === 0 ? (
        <div className={styles.empty}>
          <span>{t('settingsMcpEmptyTitle')}</span>
          <span className={styles.emptyHint}>{t('settingsMcpEmptyDescription')}</span>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} onClick={() => onOpenServer(server.id)} />
          ))}
        </div>
      )}

      <button
        type="button"
        className={styles.addRow}
        onClick={() => {
          const server = addServer({
            name: '',
            url: '',
            transport: 'streamableHttp',
            headers: [],
            enabled: true,
          })
          onOpenServer(server.id)
        }}
      >
        <PlusIcon />
        {t('settingsMcpAdd')}
      </button>
      <button type="button" className={styles.addRow} onClick={() => setImporting(true)}>
        <ImportIcon />
        {t('settingsMcpImport')}
      </button>
    </>
  )
}

const ServerCard = ({ server, onClick }: { server: McpServerConfig; onClick: () => void }) => {
  const t = useTranslate()
  const connection = useMcp((state) => state.connections[server.id])
  const status = !server.enabled ? 'idle' : (connection?.status ?? 'idle')
  const failed = status === 'error'

  return (
    <button type="button" className={styles.serverCard} onClick={onClick}>
      <span className={styles.serverState}>{failed ? <ErrorIcon /> : <ServerIcon />}</span>
      <span className={styles.serverBody}>
        <span className={styles.serverHead}>
          <span className={styles.serverName}>
            {server.name || server.url || t('settingsMcpUnnamed')}
          </span>
          <span
            className={clsx(
              styles.serverDot,
              status === 'idle' && styles.serverDotIdle,
              failed && styles.serverDotError
            )}
          />
        </span>
        <span className={styles.tag}>
          {t(
            server.transport === 'sse'
              ? 'settingsMcpTransportSse'
              : 'settingsMcpTransportStreamable'
          )}
        </span>
        {failed && connection?.error ? (
          <span className={styles.serverError}>{connection.error}</span>
        ) : null}
      </span>
    </button>
  )
}

/**
 * 服务器详情。布局沿用 rikkahub：顶部两个页签（基本设置 / 工具），
 * 表单是「标题 + 灰色说明 + 整宽控件」的纵向流，用分隔线切分。
 */
export const McpServerPage = ({ serverId, onDone }: { serverId: string; onDone: () => void }) => {
  const t = useTranslate()
  const server = useMcp((state) => state.servers.find((item) => item.id === serverId))
  const connection = useMcp((state) => state.connections[serverId])
  const [tab, setTab] = useState<'basic' | 'tools'>('basic')
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'streamableHttp')
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>(server?.headers ?? [])
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  if (!server) {
    return null
  }

  /**
   * 保存并立即连接一次。成功后回到列表（那里能看到状态点与工具数），
   * 失败则留在当前页展示原因，方便修改地址。
   */
  const onSave = async () => {
    setBusy(true)
    setMessage(null)
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      setMessage({ ok: false, text: t('settingsMcpUrlRequired') })
      setBusy(false)
      return
    }
    try {
      new URL(trimmedUrl)
    } catch {
      setMessage({ ok: false, text: t('settingsMcpUrlInvalid') })
      setBusy(false)
      return
    }
    updateServer(server.id, {
      name: name.trim(),
      url: trimmedUrl,
      transport,
      headers: headers.filter((item) => item.name.trim()),
      enabled,
    })
    // 地址与鉴权变化后旧连接不可用
    resetConnection(server.id)
    try {
      // 保存后立刻握手一次，结果写进连接状态，返回列表即可看到工具数
      await testConnection(server.id)
      onDone()
    } catch (error) {
      setMessage({
        ok: false,
        text: t('settingsMcpTestFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setBusy(false)
    }
  }

  const onDelete = () => {
    resetConnection(server.id)
    removeServer(server.id)
    onDone()
  }

  const tools = connection?.tools ?? []

  return (
    <>
      <div className={styles.tabs}>
        <button
          type="button"
          className={clsx(styles.tab, tab === 'basic' && styles.tabActive)}
          onClick={() => setTab('basic')}
        >
          {t('settingsMcpTabBasic')}
        </button>
        <button
          type="button"
          className={clsx(styles.tab, tab === 'tools' && styles.tabActive)}
          onClick={() => setTab('tools')}
        >
          {t('settingsMcpTabTools')}
        </button>
      </div>

      {tab === 'basic' ? (
        <>
          <div className={styles.switchRow}>
            <div style={{ flex: 1 }}>
              <div className={styles.fieldTitle}>{t('settingsMcpEnabled')}</div>
              <div className={styles.fieldHint}>{t('settingsMcpEnabledDescription')}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={t('settingsMcpEnabled')}
              className={clsx(styles.switch, enabled && styles.switchOn)}
              onClick={() => setEnabled((value) => !value)}
            />
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldTitle}>{t('settingsMcpName')}</div>
            <div className={styles.fieldHint}>{t('settingsMcpNameHint')}</div>
            <input
              className={styles.input}
              value={name}
              placeholder={t('settingsMcpNamePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldTitle}>{t('settingsMcpTransport')}</div>
            <div className={styles.fieldHint}>{t('settingsMcpTransportHint')}</div>
            <div className={styles.segmented}>
              <button
                type="button"
                className={clsx(
                  styles.segment,
                  transport === 'streamableHttp' && styles.segmentSelected
                )}
                onClick={() => setTransport('streamableHttp')}
              >
                {transport === 'streamableHttp' ? <CheckIcon /> : null}
                {t('settingsMcpTransportStreamable')}
              </button>
              <button
                type="button"
                className={clsx(styles.segment, transport === 'sse' && styles.segmentSelected)}
                onClick={() => setTransport('sse')}
              >
                {transport === 'sse' ? <CheckIcon /> : null}
                {t('settingsMcpTransportSse')}
              </button>
            </div>
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldTitle}>{t('settingsMcpUrl')}</div>
            <div className={styles.fieldHint}>{t('settingsMcpUrlHint')}</div>
            <input
              className={styles.input}
              value={url}
              placeholder="http://localhost:3001/mcp"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <div className={styles.fieldBlock}>
            <div className={styles.fieldTitle}>{t('settingsMcpHeaders')}</div>
            <div className={styles.fieldHint}>{t('settingsMcpHeadersHint')}</div>
            {headers.map((header, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input
                  className={styles.input}
                  style={{ flex: 1, minHeight: 46 }}
                  value={header.name}
                  placeholder="Authorization"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setHeaders((prev) =>
                      prev.map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item
                      )
                    )
                  }
                />
                <input
                  className={styles.input}
                  style={{ flex: 1.4, minHeight: 46 }}
                  value={header.value}
                  placeholder="Bearer xxx"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setHeaders((prev) =>
                      prev.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item
                      )
                    )
                  }
                />
                <button
                  type="button"
                  className={styles.backButton}
                  aria-label={t('delete')}
                  onClick={() => setHeaders((prev) => prev.filter((_, i) => i !== index))}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles.blockButton}
              style={{ marginTop: 12 }}
              onClick={() => setHeaders((prev) => [...prev, { name: '', value: '' }])}
            >
              <PlusIcon />
              {t('settingsMcpAddHeader')}
            </button>
          </div>

          {message ? (
            <p className={message.ok ? styles.hint : styles.errorText}>{message.text}</p>
          ) : null}

          <div className={styles.actions}>
            <button type="button" className={styles.actionDanger} onClick={onDelete}>
              {t('delete')}
            </button>
            <button type="button" disabled={busy} onClick={() => void onSave()}>
              {busy ? t('settingsMcpSaving') : t('save')}
            </button>
          </div>
        </>
      ) : (
        <>
          {tools.length === 0 ? (
            <p className={styles.hint}>{t('settingsMcpToolsUnavailable')}</p>
          ) : (
            <div>
              {tools.map((tool) => {
                const disabled = (server.disabledTools ?? []).includes(tool.name)
                return (
                  <div key={tool.name} className={styles.toolCard}>
                    <div className={styles.toolHead}>
                      <span className={styles.toolName}>{tool.name}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!disabled}
                        aria-label={tool.name}
                        className={clsx(styles.switch, !disabled && styles.switchOn)}
                        onClick={() =>
                          updateServer(server.id, {
                            disabledTools: disabled
                              ? (server.disabledTools ?? []).filter((item) => item !== tool.name)
                              : [...(server.disabledTools ?? []), tool.name],
                          })
                        }
                      />
                    </div>
                    {tool.description ? (
                      <span className={styles.toolDesc}>{tool.description}</span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </>
  )
}

/** 批量导入：接受 {"mcpServers": {...}} 或直接 {...} 片段 */
const ImportForm = ({ onDone }: { onDone: () => void }) => {
  const t = useTranslate()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const result = importServersJson(text)
    if (result.error) {
      setError(
        result.error === 'invalid-json'
          ? t('settingsMcpImportInvalid')
          : t('settingsMcpImportEmpty')
      )
      return
    }
    onDone()
  }

  return (
    <>
      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('settingsMcpImport')}</div>
        <div className={styles.fieldHint}>{t('settingsMcpImportHint')}</div>
        <textarea
          className={clsx(styles.input, styles.textarea)}
          value={text}
          placeholder={
            '{\n  "mcpServers": {\n    "files": { "url": "http://localhost:3001/mcp" }\n  }\n}'
          }
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
        />
      </div>
      {error ? <p className={styles.errorText}>{error}</p> : null}
      <div className={styles.actions}>
        <button type="button" onClick={onDone}>
          {t('cancel')}
        </button>
        <button type="button" disabled={!text.trim()} onClick={submit}>
          {t('settingsMcpImport')}
        </button>
      </div>
    </>
  )
}

/* ---------- 图标 ---------- */

const ServerIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <rect x="3" y="4" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3" y="12" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="6.5" cy="7" r="0.9" fill="currentColor" />
    <circle cx="6.5" cy="15" r="0.9" fill="currentColor" />
  </svg>
)

const ErrorIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 6.5v5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="11" cy="15.2" r="0.9" fill="currentColor" />
  </svg>
)

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M3 8.5l3.2 3L13 5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
    <path
      d="M4 5.5h10M7.5 5.5V4h3v1.5M5.5 5.5l.6 8.5h5.8l.6-8.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
