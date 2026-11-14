import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { BottomSheet } from '../base/BottomSheet.js'
import { pickCamera, pickGallery } from '../../services/native.js'
import { useMcp } from '../../services/mcp/store.js'
import { useChatStore } from '../../services/chat/store.js'
import { resolveServerIds, useNewChatMcp } from './newChatMcp.js'
import { McpServerPicker } from './McpServerPicker.js'
import { ModelPicker, useCurrentModelLabel } from './ModelPicker.js'
import styles from './AttachmentSheet.module.css'

/**
 * 附件入口面板，布局对齐 rikkahub 的 FilesPicker：
 * 主页面是拍照 / 相册 / 文件三张卡片，下面一行「MCP 服务器」入口（带已启用数量角标），
 * 点进去是服务器选择子页面，返回键回主页面。
 */
export const AttachmentSheet = ({
  open,
  onClose,
  onCamera,
  onGallery,
  onFile,
  sessionId,
}: {
  open: boolean
  onClose: () => void
  onCamera: () => void
  onGallery: () => void
  onFile: () => void
  sessionId: string | null
}) => {
  const t = useTranslate()
  const [page, setPage] = useState<'main' | 'model' | 'mcp'>('main')

  // 关闭时回到主页面，否则下次打开会停在上次的子页面
  const close = () => {
    setPage('main')
    onClose()
  }

  if (page === 'model') {
    return (
      <BottomSheet
        open={open}
        title={t('modelPickerTitle')}
        onClose={close}
        padded
        headerAction={
          <button
            type="button"
            className={styles.backButton}
            aria-label={t('back')}
            onClick={() => setPage('main')}
          >
            <ArrowLeftIcon />
          </button>
        }
      >
        <ModelPicker onPicked={close} />
      </BottomSheet>
    )
  }

  if (page === 'mcp') {
    return (
      <BottomSheet
        open={open}
        title={t('settingsMcpTitle')}
        onClose={close}
        padded
        headerAction={
          <button
            type="button"
            className={styles.backButton}
            aria-label={t('back')}
            onClick={() => setPage('main')}
          >
            <ArrowLeftIcon />
          </button>
        }
      >
        <McpServerPicker sessionId={sessionId} />
      </BottomSheet>
    )
  }

  return (
    <BottomSheet open={open} onClose={close} padded>
      <div className={styles.row}>
        <button type="button" className={styles.card} onClick={onCamera}>
          <CameraIcon />
          <span className={styles.label}>{t('attachCamera')}</span>
        </button>
        <button type="button" className={styles.card} onClick={onGallery}>
          <GalleryIcon />
          <span className={styles.label}>{t('attachGallery')}</span>
        </button>
        <button type="button" className={styles.card} onClick={onFile}>
          <FileIcon />
          <span className={styles.label}>{t('attachFile')}</span>
        </button>
      </div>
      <ModelEntryRow onClick={() => setPage('model')} />
      <McpEntryRow sessionId={sessionId} onClick={() => setPage('mcp')} />
    </BottomSheet>
  )
}

/** 主面板的模型入口：图标 + 名称 + 当前模型名 + 箭头 */
const ModelEntryRow = ({ onClick }: { onClick: () => void }) => {
  const t = useTranslate()
  const label = useCurrentModelLabel()
  return (
    <button type="button" className={styles.entry} onClick={onClick}>
      <span className={styles.entryIcon}>
        <ModelIcon />
      </span>
      <span className={styles.entryLabel}>{t('modelPickerTitle')}</span>
      <span className={styles.entryValue}>{label}</span>
      <span className={styles.entryChevron}>
        <ChevronIcon />
      </span>
    </button>
  )
}

/** 主面板底部的一行 MCP 入口：图标 + 名称 + 已启用数量 + 箭头 */
const McpEntryRow = ({ onClick, sessionId }: { onClick: () => void; sessionId: string | null }) => {
  const t = useTranslate()
  const count = useMcpEnabledCount(sessionId)
  return (
    <button type="button" className={styles.entry} onClick={onClick}>
      <span className={styles.entryIcon}>
        <McpIcon />
      </span>
      <span className={styles.entryLabel}>{t('settingsMcpTitle')}</span>
      {count > 0 ? <span className={styles.badge}>{count}</span> : null}
      <span className={styles.entryChevron}>
        <ChevronIcon />
      </span>
    </button>
  )
}

/**
 * 拍照 / 相册走原生（浏览器里退化为文件选择），返回的 File 交给调用方统一处理。
 */
export const useAttachmentPicker = (
  onFiles: (files: File[]) => void,
  onFileFallback: () => void
) => ({
  camera: () => {
    void pickCamera().then((files) => {
      if (files.length > 0) {
        onFiles(files)
      }
    })
  },
  gallery: () => {
    void pickGallery().then((files) => {
      if (files.length > 0) {
        onFiles(files)
      }
    })
  },
  file: onFileFallback,
})

/** 本会话已启用的 MCP 服务器数量，用于入口角标 */
const useMcpEnabledCount = (sessionId: string | null) => {
  const servers = useMcp((state) => state.servers.filter((item) => item.enabled))
  const sessionIds = useChatStore((state) =>
    sessionId !== null && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]?.mcpServerIds
      : undefined
  )
  const newChatIds = useNewChatMcp((state) => state.serverIds)
  const ids =
    sessionId === null ? resolveServerIds(newChatIds) : (sessionIds ?? resolveServerIds(null))
  return servers.filter((server) => ids.includes(server.id)).length
}

/* ---------- 图标 ---------- */

export const McpIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <rect x="3" y="4" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3" y="12" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="6.5" cy="7" r="0.9" fill="currentColor" />
    <circle cx="6.5" cy="15" r="0.9" fill="currentColor" />
  </svg>
)

const ModelIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <path
      d="M11 3l7.5 4.2v7.6L11 19l-7.5-4.2V7.2z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
    <path d="M11 11l7.5-4.2M11 11v8M11 11L3.5 6.8" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

export const ArrowLeftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
    <path
      d="M12 4l-6 6 6 6"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const ChevronIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M6 3.5L10.5 8L6 12.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const CameraIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
    <path
      d="M4 9.5h3l1.6-2.4h8.8L19 9.5h3v11H4z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <circle cx="13" cy="14.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
  </svg>
)

const GalleryIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
    <rect x="3.5" y="5.5" width="19" height="15" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="9.5" cy="10.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M4.5 18l5-5 4 4 3-2.5 5 4.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const FileIcon = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
    <path
      d="M14.5 3.5H7.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9.5z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M14.5 3.5v6h6" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
)
