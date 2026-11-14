import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import styles from './BottomSheet.module.css'

/** 当前打开的底部面板，后打开的在末尾；Esc 只关闭最上层 */
const openSheets: (() => void)[] = []

/** 关闭最上层底部面板，返回是否有面板被关闭；原生返回键优先调用 */
export const closeTopSheet = () => {
  const close = openSheets.at(-1)
  close?.()
  return close !== undefined
}

export const hasOpenSheet = () => openSheets.length > 0

/**
 * 底部弹出面板：遮罩 + 从下往上滑入的卡片，点遮罩或按 Esc 关闭。
 * 用于设置项的取值选择和输入框的附件入口。
 */
export const BottomSheet = ({
  open,
  title,
  description,
  children,
  onClose,
  /** 内容与边缘是否留白；选择器类内容通常自带 padding */
  padded = true,
  /** 标题左侧的操作，如子页面的返回按钮 */
  headerAction,
}: {
  open: boolean
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  onClose: () => void
  padded?: boolean
  headerAction?: ReactNode
}) => {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) {
      return
    }
    const close = () => onCloseRef.current()
    openSheets.push(close)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openSheets.at(-1) === close) {
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      const index = openSheets.indexOf(close)
      if (index >= 0) {
        openSheets.splice(index, 1)
      }
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) {
    return null
  }

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true">
        <div className={styles.handle} />
        {!title ? <div className={styles.spacer} /> : null}
        {title ? (
          <div className={styles.header}>
            {headerAction ? <div className={styles.headerAction}>{headerAction}</div> : null}
            <div className={styles.headerText}>
              <div className={styles.title}>{title}</div>
              {description ? <div className={styles.description}>{description}</div> : null}
            </div>
          </div>
        ) : null}
        <div className={clsx(styles.body, padded && styles.bodyPadded)}>{children}</div>
      </div>
    </div>,
    document.body
  )
}

/** 面板里的一行可选项：左侧文字，选中时右侧打勾 */
export const SheetOption = ({
  label,
  description,
  selected,
  onClick,
  icon,
}: {
  label: string
  description?: string
  selected: boolean
  onClick: () => void
  icon?: ReactNode
}) => (
  <button
    type="button"
    className={styles.option}
    role="menuitemradio"
    aria-checked={selected}
    onClick={onClick}
  >
    {icon ? <span className={styles.optionIcon}>{icon}</span> : null}
    <span className={styles.optionText}>
      <span className={styles.optionLabel}>{label}</span>
      {description ? <span className={styles.optionDescription}>{description}</span> : null}
    </span>
    {selected ? (
      <span className={styles.check}>
        <CheckIcon />
      </span>
    ) : null}
  </button>
)

const CheckIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
    <path
      d="M3.5 9.5l3.5 3.5 7.5-8"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
