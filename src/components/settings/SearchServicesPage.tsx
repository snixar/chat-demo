import { useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  addSearchService,
  removeSearchService,
  setSelectedSearchService,
  updateSearchService,
  useSearchServices,
} from '../../services/search/store.js'
import {
  SEARCH_SERVICES,
  serviceMeta,
  type SearchFieldSpec,
  type SearchServiceConfig,
  type SearchServiceId,
} from '../../services/search/types.js'
import { BottomSheet } from '../base/BottomSheet.js'
import { useSettings } from '../../services/settings.js'
import { screenStyles as styles } from './SettingsScreen.js'
import { PlusIcon } from './settingsIcons.js'

/**
 * 搜索服务列表：每台一张卡片，点开进入详情；上方提示当前生效的服务。
 * 没有配置任何服务时明确说明会回退到 DeepSeek（复用官方 Key）。
 */
export const SearchServicesPage = ({ onOpen }: { onOpen: (id: string) => void }) => {
  const t = useTranslate()
  const services = useSearchServices((state) => state.services)
  const selectedId = useSearchServices((state) => state.selectedId)
  const apiKey = useSettings((state) => state.apiKey)
  const [pickerOpen, setPickerOpen] = useState(false)

  const active =
    services.find((item) => item.enabled && item.id === selectedId) ??
    services.find((item) => item.enabled)

  return (
    <>
      <div className={styles.empty} style={{ paddingBottom: 8 }}>
        <span>{t('searchServiceActiveHint')}</span>
        <span className={styles.emptyHint}>
          {active
            ? t('searchServiceActive', { name: active.name })
            : apiKey
              ? t('searchServiceDefaultDeepSeek')
              : t('searchServiceNone')}
        </span>
      </div>

      {services.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          {services.map((service) => {
            const meta = serviceMeta(service.serviceId)
            const isActive = active?.id === service.id
            return (
              <button
                key={service.id}
                type="button"
                className={styles.serverCard}
                onClick={() => onOpen(service.id)}
              >
                <span className={styles.serverState}>
                  <SearchIcon />
                </span>
                <span className={styles.serverBody}>
                  <span className={styles.serverHead}>
                    <span className={styles.serverName}>{service.name || meta.label}</span>
                    {isActive ? (
                      <span className={styles.tag}>{t('searchServiceInUse')}</span>
                    ) : null}
                  </span>
                  <span className={styles.serverUrl}>{meta.label}</span>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <div className={styles.empty}>
          <span>{t('searchServiceEmpty')}</span>
        </div>
      )}

      <button type="button" className={styles.addRow} onClick={() => setPickerOpen(true)}>
        <PlusIcon />
        {t('searchServiceAdd')}
      </button>

      <ServicePickSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(serviceId) => {
          const created = addSearchService(serviceId)
          setPickerOpen(false)
          onOpen(created.id)
        }}
      />
    </>
  )
}

/** 选择要添加的服务类型 */
const ServicePickSheet = ({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (serviceId: SearchServiceId) => void
}) => {
  const t = useTranslate()
  return (
    <BottomSheet open={open} title={t('searchServiceAdd')} onClose={onClose} padded>
      <div className={styles.modelPickList}>
        {SEARCH_SERVICES.map((meta) => (
          <button
            key={meta.id}
            type="button"
            className={styles.modelPickItem}
            onClick={() => onPick(meta.id)}
          >
            <span className={styles.modelPickText}>
              <span className={styles.modelPickName}>{meta.label}</span>
              <span className={styles.modelPickId}>{meta.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.sheetActions}>
        <button type="button" className={styles.sheetButton} onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
    </BottomSheet>
  )
}

/** 详情页：名称、各字段表单、启用开关、设为当前、删除 */
export const SearchServiceDetailPage = ({
  serviceId,
  onDone,
}: {
  serviceId: string
  onDone: () => void
}) => {
  const t = useTranslate()
  const service = useSearchServices((state) =>
    state.services.find((item) => item.id === serviceId)
  )
  const selectedId = useSearchServices((state) => state.selectedId)
  const [name, setName] = useState(service?.name ?? '')

  if (!service) {
    return <div className={styles.empty}>{t('searchServiceEmpty')}</div>
  }

  const meta = serviceMeta(service.serviceId)
  const isActive = selectedId === service.id

  const setValue = (key: string, value: string) => {
    updateSearchService(service.id, { values: { ...service.values, [key]: value } })
  }

  return (
    <>
      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('searchServiceName')}</div>
        <input
          className={styles.input}
          value={name}
          placeholder={meta.label}
          onChange={(event) => {
            setName(event.target.value)
            updateSearchService(service.id, { name: event.target.value })
          }}
        />
        <div className={styles.fieldHint}>{meta.hint}</div>
      </div>

      {meta.fields.length === 0 ? (
        <div className={styles.fieldBlock}>
          <div className={styles.fieldHint}>{t('searchServiceNoConfig')}</div>
        </div>
      ) : (
        meta.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={service.values[field.key] ?? ''}
            onChange={(value) => setValue(field.key, value)}
          />
        ))
      )}

      <div className={styles.fieldBlock}>
        <div className={styles.toolHead}>
          <span className={styles.fieldTitle} style={{ flex: 1 }}>
            {t('searchServiceEnabled')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={service.enabled}
            aria-label={t('searchServiceEnabled')}
            className={clsx(styles.switch, service.enabled && styles.switchOn)}
            onClick={() => updateSearchService(service.id, { enabled: !service.enabled })}
          />
        </div>
      </div>

      <div className={styles.fieldBlock}>
        <div className={styles.toolHead}>
          <span className={styles.fieldTitle} style={{ flex: 1 }}>
            {t('searchServiceUseThis')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            aria-label={t('searchServiceUseThis')}
            className={clsx(styles.switch, isActive && styles.switchOn)}
            onClick={() => setSelectedSearchService(isActive ? null : service.id)}
          />
        </div>
        <div className={styles.fieldHint}>{t('searchServiceUseThisHint')}</div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionDanger}
          onClick={() => {
            removeSearchService(service.id)
            onDone()
          }}
        >
          {t('delete')}
        </button>
        <button type="button" onClick={onDone}>
          {t('providerSave')}
        </button>
      </div>
    </>
  )
}

/** 单个字段：按 kind 渲染成输入框 / 下拉 / 开关 */
const FieldRow = ({
  field,
  value,
  onChange,
}: {
  field: SearchFieldSpec
  value: string
  onChange: (value: string) => void
}) => {
  const t = useTranslate()
  if (field.kind === 'switch') {
    const on = (value === '' ? field.fallback : value) === 'true'
    return (
      <div className={styles.fieldBlock}>
        <div className={styles.toolHead}>
          <span className={styles.fieldTitle} style={{ flex: 1 }}>
            {field.label}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={field.label}
            className={clsx(styles.switch, on && styles.switchOn)}
            onClick={() => onChange(String(!on))}
          />
        </div>
        {field.hint ? <div className={styles.fieldHint}>{field.hint}</div> : null}
      </div>
    )
  }

  if (field.kind === 'select') {
    const current = value || field.fallback || field.options?.[0]?.value || ''
    return (
      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{field.label}</div>
        <div className={styles.segmented}>
          {(field.options ?? []).map((option) => (
            <button
              key={option.value}
              type="button"
              className={clsx(styles.segment, current === option.value && styles.segmentSelected)}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {field.hint ? <div className={styles.fieldHint}>{field.hint}</div> : null}
      </div>
    )
  }

  return (
    <div className={styles.fieldBlock}>
      <div className={styles.fieldTitle}>{field.label}</div>
      {field.hint ? <div className={styles.fieldHint}>{field.hint}</div> : null}
      <input
        className={styles.input}
        value={value}
        placeholder={field.placeholder ?? field.fallback ?? ''}
        type={field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.key === 'apiKey' ? (
        <div className={styles.fieldHint}>{t('searchServiceKeyHint')}</div>
      ) : null}
    </div>
  )
}

/** 单实例是否需要 Key，用于列表里的提示 */
export const serviceNeedsKey = (service: SearchServiceConfig) =>
  serviceMeta(service.serviceId).needsKey

const SearchIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.5" />
    <path d="M14.5 14.5L18 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
