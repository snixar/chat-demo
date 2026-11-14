import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useMcp } from '../../services/mcp/store.js'
import {
  openMcpServer,
  popSettingsRoute,
  pushSettingsRoute,
  useSettingsDialog,
  type SettingsRoute,
} from './settingsDialogState.js'
import { DataPage, ApiKeyPage } from './SettingsPages.js'
import { McpPage, McpServerPage } from './McpPage.js'
import styles from './SettingsScreen.module.css'
import { ChevronIcon, BackIcon, CloseIcon } from './settingsIcons.js'
import { SettingPickerSheet, type SettingPicker } from './SettingPickers.js'

/**
 * 设置页（全屏）。UI 对齐 DeepSeek 客户端：浅灰底、白色圆角卡片、分组灰标题。
 * 路由栈在 store 里，原生返回键与侧边栏入口都能控制它。
 */
const routeTitles = {
  root: 'settings',
  apiKey: 'apiKeyLabel',
  data: 'settingsDataTitle',
  mcp: 'settingsMcpTitle',
} satisfies Record<Exclude<SettingsRoute['name'], 'mcpServer'>, TranslationKey>

export const SettingsScreen = () => {
  const open = useSettingsDialog((state) => state.open)
  const stack = useSettingsDialog((state) => state.stack)
  const route = stack.at(-1) ?? { name: 'root' as const }
  const t = useTranslate()
  // 服务器名可能在别处被改，订阅列表以便标题同步
  const servers = useMcp((state) => state.servers)

  if (!open) {
    return null
  }

  const serverName =
    route.name === 'mcpServer'
      ? servers.find((item) => item.id === route.serverId)?.name
      : undefined
  const title =
    route.name === 'mcpServer' ? serverName || t('settingsMcpTitle') : t(routeTitles[route.name])

  return (
    <div className={styles.page} role="dialog" aria-modal="true" aria-label={title}>
      <header className={styles.topBar}>
        <button
          type="button"
          className={styles.backButton}
          aria-label={stack.length > 1 ? t('back') : t('close')}
          onClick={popSettingsRoute}
        >
          {stack.length > 1 ? <BackIcon /> : <CloseIcon />}
        </button>
        <h1 className={styles.topTitle}>{title}</h1>
      </header>
      <div className={styles.scroll}>
        {route.name === 'root' ? <RootPage /> : null}
        {route.name === 'apiKey' ? <ApiKeyPage /> : null}
        {route.name === 'data' ? <DataPage /> : null}
        {route.name === 'mcp' ? <McpPage onOpenServer={openMcpServer} /> : null}
        {route.name === 'mcpServer' ? (
          <McpServerPage serverId={route.serverId} onDone={popSettingsRoute} />
        ) : null}
      </div>
    </div>
  )
}

/** 一级页：分组卡片 */
const RootPage = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const locale = useSettings((state) => state.locale)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const location = useSettings((state) => state.location)
  const apiKey = useSettings((state) => state.apiKey)
  const servers = useMcp((state) => state.servers)
  const [picker, setPicker] = useState<SettingPicker | null>(null)

  const themeLabel = t(
    themePreference === 'light'
      ? 'avatarMenuSettingsDialogThemeSelectLightOption'
      : themePreference === 'dark'
        ? 'avatarMenuSettingsDialogThemeSelectDarkOption'
        : 'avatarMenuSettingsDialogThemeSelectSystemOption'
  )
  const localeLabel = t(locale === 'zh-CN' ? 'settingsLocaleZhCN' : 'settingsLocaleEnUS')
  const ttsLabel = t(ttsVoice === 'stella' ? 'settingsTtsVoiceStella' : 'settingsTtsVoiceTide')
  const locationLabel = location
    ? t(location.region === 'CN' ? 'settingsLocationChina' : 'settingsLocationOverseas')
    : t('settingsLocationNotSet')
  const mcpValue =
    servers.length > 0
      ? t('settingsMcpConfigured', { count: servers.length })
      : t('settingsMcpEmptyValue')

  return (
    <>
      <Group>
        <Row
          icon={<SunIcon />}
          label={t('avatarMenuSettingsDialogThemeItemLabel')}
          value={themeLabel}
          onClick={() => setPicker('theme')}
        />
        <Row
          icon={<GlobeIcon />}
          label={t('settingsLocalePreference')}
          value={localeLabel}
          onClick={() => setPicker('locale')}
        />
        <Row
          icon={<SpeakerIcon />}
          label={t('settingsTtsVoice')}
          value={ttsLabel}
          onClick={() => setPicker('tts')}
        />
        <Row
          icon={<PinIcon />}
          label={t('settingsLocation')}
          value={locationLabel}
          onClick={() => setPicker('location')}
        />
      </Group>

      <Group title={t('settingDialogAsideDataOptionLabel')}>
        <Row
          icon={<KeyIcon />}
          label={t('apiKeyLabel')}
          description={t('settingsApiKeyHint')}
          value={apiKey ? '••••••••' : t('apiKeyNotSet')}
          onClick={() => pushSettingsRoute({ name: 'apiKey' })}
        />
        <Row
          icon={<DatabaseIcon />}
          label={t('settingsDataTitle')}
          description={t('settingsDataDescription')}
          onClick={() => pushSettingsRoute({ name: 'data' })}
        />
      </Group>

      <Group title={t('settingsGroupExtensions')}>
        <Row
          icon={<PlugIcon />}
          label={t('settingsMcpTitle')}
          description={t('settingsMcpEntryDescription')}
          value={mcpValue}
          onClick={() => pushSettingsRoute({ name: 'mcp' })}
        />
      </Group>

      <SettingPickerSheet picker={picker} onClose={() => setPicker(null)} />
    </>
  )
}

export const Group = ({ title, children }: { title?: string; children: ReactNode }) => (
  <section className={styles.group}>
    {title ? <div className={styles.groupTitle}>{title}</div> : null}
    <div className={styles.card}>{children}</div>
  </section>
)

export const Row = ({
  icon,
  label,
  description,
  value,
  control,
  dotClass,
  onClick,
}: {
  icon?: ReactNode
  label: string
  description?: string
  value?: string
  control?: ReactNode
  /** 状态点样式，显示在右侧值之前 */
  dotClass?: string
  onClick?: () => void
}) => {
  const content = (
    <>
      {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {description ? <span className={styles.rowDescription}>{description}</span> : null}
      </span>
      {control ? (
        <span className={styles.rowControl}>{control}</span>
      ) : (
        <>
          {dotClass ? <span className={clsx(styles.dot, dotClass)} /> : null}
          {value ? <span className={styles.rowValue}>{value}</span> : null}
          {onClick ? (
            <span className={styles.chevron}>
              <ChevronIcon />
            </span>
          ) : null}
        </>
      )}
    </>
  )
  if (!onClick) {
    return <div className={clsx(styles.row, styles.rowStatic)}>{content}</div>
  }
  return (
    <button type="button" className={styles.row} onClick={onClick}>
      {content}
    </button>
  )
}

/* ---------- 图标：设置页专用，24px 线性 ---------- */

const ico = (path: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
    {path}
  </svg>
)

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const SunIcon = () =>
  ico(
    <>
      <circle cx="10" cy="10" r="3.5" {...stroke} />
      <path
        d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M15.3 4.7l-1 1M5.7 14.3l-1 1"
        {...stroke}
      />
    </>
  )

const GlobeIcon = () =>
  ico(
    <>
      <circle cx="10" cy="10" r="7" {...stroke} />
      <path d="M3 10h14M10 3c2 2 2 12 0 14M10 3c-2 2-2 12 0 14" {...stroke} />
    </>
  )

const SpeakerIcon = () =>
  ico(
    <>
      <path d="M4 8v4h3l4 3V5L7 8H4z" {...stroke} />
      <path d="M14 7.5a3.5 3.5 0 0 1 0 5M16 5.5a6 6 0 0 1 0 9" {...stroke} />
    </>
  )

const PinIcon = () =>
  ico(
    <>
      <path d="M10 17s5-4.5 5-8.5A5 5 0 0 0 5 8.5C5 12.5 10 17 10 17z" {...stroke} />
      <circle cx="10" cy="8.5" r="1.8" {...stroke} />
    </>
  )

const KeyIcon = () =>
  ico(
    <>
      <circle cx="7" cy="12" r="3.5" {...stroke} />
      <path d="M9.5 9.5L16 3M13 6l2 2M14.5 4.5l2 2" {...stroke} />
    </>
  )

const DatabaseIcon = () =>
  ico(
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.5" {...stroke} />
      <path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5" {...stroke} />
      <path d="M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" {...stroke} />
    </>
  )

const PlugIcon = () =>
  ico(
    <>
      <path d="M7 3v4M13 3v4" {...stroke} />
      <path d="M5 7h10v2a5 5 0 0 1-10 0V7z" {...stroke} />
      <path d="M10 14v3.5" {...stroke} />
    </>
  )

export { styles as screenStyles }
