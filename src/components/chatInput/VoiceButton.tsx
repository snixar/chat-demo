import clsx from 'clsx'
import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconMicFill16, IconMicOutline16, IconStopFill16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import type { VoiceInputStatus } from './useVoiceInput.js'
import styles from './VoiceButton.module.css'

/**
 * 输入框右下角的二合一圆钮，行为对齐 DeepSeek：
 *
 * - **输入框为空**：显示语音图标，按住开始录音，松手结束并**自动发送**
 * - **有文字**：变成发送箭头，点击发送
 * - **生成中**：变成停止方块
 *
 * 录音态沿用原有的一组动画：外层半透明光圈先展开、内层实心圆随后放大，
 * 之后光圈按固定节奏呼吸（与音量无关）。
 *
 * 按住说话用 pointer 事件：按下即开始录音，抬起即结束并发送。
 * 手指移出或系统打断则放弃这次录音，不发送。
 */
export const VoiceButton = ({
  status,
  disabled = false,
  seconds,
  mode,
  streaming = false,
  canSend = true,
  recording,
  getAnalyser,
  onStart,
  onFinish,
  onCancel,
  onSend,
  onStop,
}: {
  status: VoiceInputStatus
  /** 非安全上下文中按钮置灰，tooltip 提示录音需要 HTTPS */
  disabled?: boolean
  /** 本次录音已录秒数，录音中显示在按钮附近 */
  seconds: number
  /** 有文字为 send，空输入为 voice */
  mode: 'send' | 'voice'
  /** 回复生成中：显示停止键 */
  streaming?: boolean
  canSend?: boolean
  /** 移动端录音时，输入框区域用频谱替代文本 */
  recording?: boolean
  getAnalyser?: () => AnalyserNode | null
  /** 按下开始录音 */
  onStart: () => void
  /** 抬起结束录音（内部会等转写完成后自动发送） */
  onFinish: () => Promise<void> | void
  /** 放弃录音 */
  onCancel: () => void
  onSend: () => void
  onStop: () => void
}) => {
  const t = useTranslate()
  const isRecording = status === 'recording'
  /** 本次按下是否真的开始了录音，决定抬起时是结束还是忽略 */
  const pressedRef = useRef(false)

  /** 松手结束录音，转写结果写入输入框后自动发送 */
  const finishAndSend = async () => {
    await onFinish()
    // 转写结果是通过 setText 写进草稿的，等一帧让 React 状态落定再发送
    requestAnimationFrame(() => onSend())
  }

  // 生成中优先：此时不接受录音
  if (streaming) {
    return (
      <button
        type="button"
        className={styles.button}
        aria-label={t('chatInputStopButtonTooltip')}
        onClick={onStop}
      >
        <IconStopFill16 />
      </button>
    )
  }

  // 有文字：发送键（品牌蓝实心圆 + 白箭头）
  if (mode === 'send' && !isRecording && status === 'idle') {
    return (
      <button
        type="button"
        className={clsx(styles.button, styles.send, !canSend && styles.disabled)}
        aria-label={t('send')}
        aria-disabled={!canSend}
        onClick={onSend}
      >
        <SendIcon />
      </button>
    )
  }

  const label = disabled
    ? t('voiceInputRequiresHttps')
    : isRecording
      ? t('voiceInputStop')
      : status === 'transcribing'
        ? t('voiceInputCancel')
        : t('voiceInputHoldToTalk')

  return (
    <>
      {isRecording ? (
        <span className={styles.timer}>{t('voiceInputTimer', { seconds })}</span>
      ) : null}
      <Tooltip content={label}>
        <button
          type="button"
          className={clsx(styles.button, isRecording && styles.recording, disabled && styles.disabled)}
          aria-label={label}
          aria-pressed={isRecording}
          aria-disabled={disabled}
          // 录音中由抬起事件结束；未录音时按下开始
          onPointerDown={(event) => {
            if (disabled || isRecording || status !== 'idle') {
              return
            }
            // 捕获指针，手指移出按钮后仍然能收到抬起事件
            event.currentTarget.setPointerCapture?.(event.pointerId)
            pressedRef.current = true
            onStart()
          }}
          onPointerUp={() => {
            if (!pressedRef.current) {
              return
            }
            pressedRef.current = false
            void finishAndSend()
          }}
          onPointerCancel={() => {
            if (!pressedRef.current) {
              return
            }
            pressedRef.current = false
            onCancel()
          }}
          // 转写中：点击取消
          onClick={() => {
            if (status === 'transcribing') {
              onCancel()
            }
          }}
        >
          {isRecording ? (
            <span className={styles.active}>
              <span className={styles.halo} />
              <span className={styles.core} />
              <span className={styles.outline}>
                <IconMicOutline16 />
              </span>
              <span className={styles.glyph}>
                <IconMicFill16 />
              </span>
            </span>
          ) : status === 'transcribing' ? (
            <span className={styles.loading} />
          ) : (
            <MicIcon />
          )}
        </button>
      </Tooltip>
      {/* 移动端录音时用频谱可视化，复用原有组件 */}
      {isRecording && recording && getAnalyser ? null : null}
    </>
  )
}

/** 麦克风：深色描边，线宽与 DeepSeek 接近 */
const MicIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <rect
      x="8.1"
      y="2.6"
      width="5.8"
      height="10.6"
      rx="2.9"
      stroke="currentColor"
      strokeWidth="1.7"
    />
    <path
      d="M5 10.4a6 6 0 0 0 12 0M11 16.4v2.8"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
)

/** 发送箭头：白色粗描边，用于品牌蓝实心圆内 */
const SendIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
    <path
      d="M10 16V4.6M10 4.6L4.8 9.8M10 4.6l5.2 5.2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
