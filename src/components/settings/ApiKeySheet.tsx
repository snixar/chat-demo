import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { BottomSheet } from '../base/BottomSheet.js'
import { Button } from '../base/Button.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { closeApiKeySheet, useApiKeySheet } from './apiKeySheetState.js'
import styles from './ApiKeySheet.module.css'

/**
 * API Key 编辑弹窗（底部面板）。
 *
 * 对齐设置页其他项：点行弹出选择面板，而不是跳到二级页面。
 * 输入后先用 GET /models 校验，通过才落盘并关闭。
 */
export const ApiKeySheet = () => {
  const t = useTranslate()
  const open = useApiKeySheet((state) => state.open)
  const apiKey = useSettings((state) => state.apiKey)
  const isMobile = useIsMobile()
  // 打开面板即视为处于编辑状态；移动端不自动聚焦，避免一开面板就弹键盘
  const form = useApiKeyForm(closeApiKeySheet)

  return (
    <BottomSheet open={open} title={t('apiKeyLabel')} onClose={closeApiKeySheet}>
      <div className={styles.keyBody}>
        {apiKey ? (
          <div className={styles.keyCurrent}>
            <span className={styles.keyCurrentLabel}>{t('apiKeyCurrent')}</span>
            <span className={styles.keyMask}>{'•'.repeat(Math.min(apiKey.length, 24))}</span>
          </div>
        ) : (
          <p className={styles.keyHint}>{t('apiKeySheetHint')}</p>
        )}
        <input
          className={styles.keyInput}
          type="password"
          placeholder={t('apiKeyPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!isMobile}
          value={form.value}
          onChange={(event) => form.setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void form.submit()
            }
          }}
        />
        {form.error ? <span className={styles.keyError}>{form.error}</span> : null}
        <Button
          className={styles.keySubmit}
          size="l"
          disabled={form.verifying || !form.value.trim()}
          onClick={() => void form.submit()}
        >
          {form.verifying ? t('apiKeyVerifying') : t('confirm')}
        </Button>
        <p className={styles.keyFoot}>{t('apiKeyPageHint')}</p>
      </div>
    </BottomSheet>
  )
}
