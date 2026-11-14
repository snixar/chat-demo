import { useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useTranslate } from '../../i18n/index.js'
import { screenStyles as styles } from './SettingsScreen.js'

/** API Key 的编辑状态：输入框与下方的「确定」按钮共用 */
export const useApiKeyEditor = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const [editing, setEditing] = useState(false)
  const form = useApiKeyForm(() => setEditing(false))
  return { apiKey, editing, setEditing, form, showInput: !apiKey || editing }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** API Key：保存后显示掩码，点编辑才重新输入；校验通过才落盘 */
export const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, setEditing, form, showInput } = editor

  return (
    <div className={styles.page}>
      <div className={styles.field}>
        {apiKey && !editing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              className={styles.input}
              value={'*'.repeat(Math.min(apiKey.length, 32))}
              readOnly
            />
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={() => setEditing(true)}
            />
          </div>
        ) : (
          <>
            <input
              className={styles.input}
              type="password"
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              // 移动端打开时不弹键盘，点编辑后才聚焦
              autoFocus={!isMobile || editing}
              value={form.value}
              onChange={(event) => form.setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void form.submit()
                }
              }}
              onBlur={() => {
                // 修改时没输入就离开，回到已保存的状态
                if (apiKey && !form.value.trim()) {
                  setEditing(false)
                }
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                size="m"
                disabled={form.verifying || !form.value.trim()}
                onClick={() => void form.submit()}
              >
                {form.verifying ? t('apiKeyVerifying') : t('confirm')}
              </Button>
            </div>
          </>
        )}
        {showInput && form.error ? <span className={styles.errorText}>{form.error}</span> : null}
      </div>
    </div>
  )
}
