import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import clsx from 'clsx'

import { useChatStore } from '../../services/chat/store.js'
import { clearHistory, exportHistory, importHistory } from '../../services/chat/backup.js'
import { saveBlob } from '../../services/native.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { Group, Row, screenStyles as styles } from './SettingsScreen.js'

/* ---------- 数据：导入导出 / 删除 ---------- */

type Status = (TranslationMessage & { error?: boolean }) | null

export const DataPage = () => {
  const t = useTranslate()
  return (
    <>
      <Group title={t('historyImport')}>
        <ImportHistory />
        <ExportHistory />
      </Group>
      <Group title={t('deleteAllSessions')}>
        <DeleteAll />
      </Group>
    </>
  )
}

const errorStatus = (key: TranslationKey, error: unknown): Status => {
  const message = error instanceof Error ? error.message : String(error)
  return { key, params: { message }, error: true }
}

const ImportHistory = () => {
  const t = useTranslate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importing = useChatStore((state) => state.importingHistory)
  const [status, setStatus] = useState<Status>(null)
  const [pending, setPending] = useState<File | null>(null)

  const confirm = async () => {
    if (!pending) {
      return
    }
    const file = pending
    setPending(null)
    setStatus(null)
    try {
      const count = await importHistory(file)
      setStatus(
        count === 1 ? { key: 'historyImportedOne' } : { key: 'historyImported', params: { count } }
      )
    } catch (error) {
      setStatus(errorStatus('historyImportFailed', error))
    }
  }

  return (
    <>
      <Row
        label={t('historyImport')}
        description={t('historyImportDescription')}
        control={
          <Button
            variant="outlined"
            size="m"
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
          >
            {t('upload')}
          </Button>
        }
      />
      {status ? (
        <div className={clsx(styles.row, styles.rowStatic)}>
          <span className={status.error ? styles.errorText : styles.rowDescription}>
            {t(status.key, status.params)}
          </span>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            setPending(file)
          }
        }}
      />
      {pending ? (
        <Modal
          title={t('historyImportConfirmTitle')}
          closable
          onClose={() => setPending(null)}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Button variant="outlined" size="m" onClick={() => setPending(null)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" size="m" onClick={() => void confirm()}>
                {t('confirm')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>{t('historyImportConfirmDescription')}</p>
        </Modal>
      ) : null}
    </>
  )
}

const ExportHistory = () => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      await saveBlob(blob, name)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row
        label={t('exportAllLabel')}
        description={t('historyExportDescription')}
        control={
          <Button
            variant="outlined"
            size="m"
            disabled={empty || busy}
            onClick={() => void onExport()}
          >
            {t('exportAllDownload')}
          </Button>
        }
      />
      {status ? (
        <div className={clsx(styles.row, styles.rowStatic)}>
          <span className={styles.errorText}>{t(status.key, status.params)}</span>
        </div>
      ) : null}
    </>
  )
}

const DeleteAll = () => {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    setBusy(true)
    try {
      await clearHistory()
      showToast(t('historyDeleted'))
      setConfirming(false)
    } catch {
      showToast(t('historyDeleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Row
        label={t('deleteAllSessions')}
        control={
          <Button variant="dangerOutlined" size="m" onClick={() => setConfirming(true)}>
            {t('delete')}
          </Button>
        }
      />
      {confirming ? (
        <Modal
          title={t('deleteAllSessionsModalTitle')}
          closable
          onClose={() => (busy ? undefined : setConfirming(false))}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Button
                variant="outlined"
                size="m"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" size="m" disabled={busy} onClick={() => void confirm()}>
                {busy ? t('historyDeleting') : t('delete')}
              </Button>
            </div>
          }
        >
          <p className={styles.hint}>{t('deleteAllSessionsModalDescription')}</p>
        </Modal>
      ) : null}
    </>
  )
}
