import { useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  addProvider,
  newModelId,
  removeProvider,
  updateProvider,
  useProviders,
} from '../../services/providers/store.js'
import type { CustomProvider, ProviderProtocol } from '../../services/providers/types.js'
import { fetchProviderModels, type RemoteModel } from '../../services/providers/listModels.js'
import { BottomSheet } from '../base/BottomSheet.js'
import { screenStyles as styles } from './SettingsScreen.js'
import { PlusIcon } from './settingsIcons.js'

/**
 * 提供商列表：每台一张卡片（名称 + 协议 + 模型数），点开进入详情。
 * 布局沿用 MCP 列表的卡片式结构。
 */
export const ProvidersPage = ({ onOpen }: { onOpen: (id: string | null) => void }) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)

  // 不立即创建记录：用户直接返回时不会留下空壳提供商
  const add = () => onOpen(null)

  return (
    <>
      {providers.length === 0 ? (
        <div className={styles.empty}>
          <span>{t('providerEmpty')}</span>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={styles.serverCard}
              onClick={() => onOpen(provider.id)}
            >
              <span className={styles.serverState}>
                <ProviderIcon />
              </span>
              <span className={styles.serverBody}>
                <span className={styles.serverHead}>
                  <span className={styles.serverName}>
                    {provider.name || provider.baseUrl || t('providerName')}
                  </span>
                </span>
                <span className={styles.tag}>
                  {t(
                    provider.protocol === 'openai'
                      ? 'providerProtocolOpenai'
                      : 'providerProtocolAnthropic'
                  )}
                </span>
                <span className={styles.serverUrl}>
                  {t('providerModelCount', { count: provider.models.length })}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <button type="button" className={styles.addRow} onClick={add}>
        <PlusIcon />
        {t('providerAdd')}
      </button>
    </>
  )
}

/** 提供商详情：表单流，字段为名称 / 协议 / 地址 / Key / 模型列表 */
export const ProviderDetailPage = ({
  providerId,
  onDone,
}: {
  /** null 表示新建 */
  providerId: string | null
  onDone: () => void
}) => {
  const t = useTranslate()
  const provider = useProviders((state) =>
    providerId === null ? undefined : state.providers.find((item) => item.id === providerId)
  )
  const [name, setName] = useState(provider?.name ?? '')
  const [protocol, setProtocol] = useState<ProviderProtocol>(provider?.protocol ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')
  const [error, setError] = useState<string | null>(null)
  /** 新建模式下，保存后才有真实 id */
  const [createdId, setCreatedId] = useState<string | null>(providerId)
  /** 新建模式下的本地模型列表（记录还不存在，先存内存） */
  const [draftModels, setDraftModels] = useState<CustomProvider['models']>([])
  /** 从 /models 拉到的候选模型；null 表示还没拉过 */
  const [remote, setRemote] = useState<RemoteModel[] | null>(null)
  const [fetching, setFetching] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  /** 当前编辑中的模型列表：已有记录读 store，新建读本地草稿 */
  const models = provider?.models ?? draftModels

  const save = (): boolean => {
    const url = baseUrl.trim()
    if (!url) {
      setError(t('providerUrlRequired'))
      return false
    }
    try {
      new URL(url)
    } catch {
      setError(t('providerUrlInvalid'))
      return false
    }
    if (createdId === null) {
      const created = addProvider({
        name: name.trim(),
        protocol,
        baseUrl: url,
        apiKey: apiKey.trim(),
        models: draftModels,
        enabled: true,
      })
      setCreatedId(created.id)
    } else {
      updateProvider(createdId, {
        name: name.trim(),
        protocol,
        baseUrl: url,
        apiKey: apiKey.trim(),
      })
    }
    setError(null)
    return true
  }

  const patchModels = (update: (models: CustomProvider['models']) => CustomProvider['models']) => {
    if (createdId === null) {
      // 记录还不存在：先改内存草稿，保存时一起落库
      setDraftModels((prev) => update(prev))
      return
    }
    updateProvider(createdId, { models: update(models) })
  }

  /**
   * 拉取提供商的模型列表。先校验地址，再请求 /models；
   * 成功后打开选择面板，让用户挑要添加的模型。
   */
  const loadModels = async () => {
    const url = baseUrl.trim()
    if (!url) {
      setError(t('providerUrlRequired'))
      return
    }
    try {
      new URL(url)
    } catch {
      setError(t('providerUrlInvalid'))
      return
    }
    setFetching(true)
    setError(null)
    try {
      const models = await fetchProviderModels({
        protocol,
        baseUrl: url,
        apiKey: apiKey.trim(),
        signal: AbortSignal.timeout(20_000),
      })
      if (models.length === 0) {
        setError(t('providerModelsEmpty'))
        return
      }
      setRemote(models)
      setPickerOpen(true)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        setError(t('providerModelsTimeout'))
      } else {
        setError(
          t('providerModelsFailed', {
            message: err instanceof Error ? err.message : String(err),
          })
        )
      }
    } finally {
      setFetching(false)
    }
  }

  /** 已添加过的模型 id，用于在选择面板里标记 */
  const addedIds = new Set(models.map((item) => item.modelId))

  /** 把选中的候选模型加入列表，已存在的跳过 */
  const addPickedModels = (picked: RemoteModel[]) => {
    const existing = new Set(models.map((item) => item.modelId))
    const next = picked
      .filter((item) => !existing.has(item.id))
      .map((item) => ({
        id: newModelId(),
        modelId: item.id,
        displayName: item.name,
        supportsTools: true,
      }))
    if (next.length > 0) {
      patchModels((models) => [...models, ...next])
    }
    setPickerOpen(false)
  }

  return (
    <>
      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('providerName')}</div>
        <input
          className={styles.input}
          value={name}
          placeholder={t('providerNamePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('providerProtocol')}</div>
        <div className={styles.segmented}>
          <button
            type="button"
            className={clsx(styles.segment, protocol === 'openai' && styles.segmentSelected)}
            onClick={() => setProtocol('openai')}
          >
            {t('providerProtocolOpenai')}
          </button>
          <button
            type="button"
            className={clsx(styles.segment, protocol === 'anthropic' && styles.segmentSelected)}
            onClick={() => setProtocol('anthropic')}
          >
            {t('providerProtocolAnthropic')}
          </button>
        </div>
      </div>

      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('providerBaseUrl')}</div>
        <div className={styles.fieldHint}>{t('providerBaseUrlHint')}</div>
        <input
          className={styles.input}
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>

      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('providerApiKey')}</div>
        <input
          className={styles.input}
          value={apiKey}
          placeholder="sk-..."
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>

      <div className={styles.fieldBlock}>
        <div className={styles.fieldTitle}>{t('providerModels')}</div>
        {models.map((model, index) => (
          <div key={model.id} className={styles.toolCard} style={{ marginTop: 8 }}>
            <div className={styles.toolHead}>
              <span className={styles.toolName}>{model.displayName || model.modelId || '—'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={model.supportsTools}
                aria-label={t('providerModelTools')}
                className={clsx(styles.switch, model.supportsTools && styles.switchOn)}
                onClick={() =>
                  patchModels((models) =>
                    models.map((item, i) =>
                      i === index ? { ...item, supportsTools: !item.supportsTools } : item
                    )
                  )
                }
              />
              <button
                type="button"
                className={styles.inlineValue}
                onClick={() => patchModels((models) => models.filter((_, i) => i !== index))}
              >
                {t('delete')}
              </button>
            </div>
            <input
              className={styles.input}
              value={model.displayName}
              placeholder={t('providerModelName')}
              onChange={(event) =>
                patchModels((models) =>
                  models.map((item, i) =>
                    i === index ? { ...item, displayName: event.target.value } : item
                  )
                )
              }
            />
            <input
              className={styles.input}
              value={model.modelId}
              placeholder={t('providerModelId')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) =>
                patchModels((models) =>
                  models.map((item, i) =>
                    i === index ? { ...item, modelId: event.target.value } : item
                  )
                )
              }
            />
            <span className={styles.fieldHint}>{t('providerModelToolsHint')}</span>
          </div>
        ))}
        {/* 两种添加方式：从服务端拉列表，或手工填一个 */}
        <div className={styles.addModelRow}>
          <button
            type="button"
            className={styles.blockButton}
            disabled={fetching}
            onClick={() => void loadModels()}
          >
            <ListIcon />
            {fetching ? t('providerModelsLoading') : t('providerFetchModels')}
          </button>
          <button
            type="button"
            className={clsx(styles.blockButton, styles.blockButtonOutline)}
            onClick={() =>
              patchModels((models) => [
                ...models,
                { id: newModelId(), modelId: '', displayName: '', supportsTools: true },
              ])
            }
          >
            <PlusIcon />
            {t('providerAddModelManual')}
          </button>
        </div>
      </div>

      {error ? <p className={styles.errorText}>{error}</p> : null}

      <ModelSelectSheet
        open={pickerOpen}
        models={remote ?? []}
        addedIds={addedIds}
        onClose={() => setPickerOpen(false)}
        onConfirm={addPickedModels}
      />

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.actionDanger}
          onClick={() => {
            if (createdId !== null) {
              removeProvider(createdId)
            }
            onDone()
          }}
        >
          {t('delete')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (save()) {
              onDone()
            }
          }}
        >
          {t('providerSave')}
        </button>
      </div>
    </>
  )
}

/**
 * 模型选择面板：列出从 /models 拉到的模型，可多选。
 * 已添加过的显示为已添加且不可重复选择。
 */
const ModelSelectSheet = ({
  open,
  models,
  addedIds,
  onClose,
  onConfirm,
}: {
  open: boolean
  models: RemoteModel[]
  addedIds: Set<string>
  onClose: () => void
  onConfirm: (picked: RemoteModel[]) => void
}) => {
  const t = useTranslate()
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    if (addedIds.has(id)) {
      return
    }
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const confirm = () => {
    onConfirm(models.filter((model) => picked.has(model.id)))
    setPicked(new Set())
  }

  return (
    <BottomSheet open={open} title={t('providerFetchModels')} onClose={onClose} padded>
      <div className={styles.modelPickList}>
        {models.map((model) => {
          const added = addedIds.has(model.id)
          const selected = picked.has(model.id)
          return (
            <button
              key={model.id}
              type="button"
              className={clsx(styles.modelPickItem, added && styles.modelPickAdded)}
              aria-pressed={selected}
              disabled={added}
              onClick={() => toggle(model.id)}
            >
              <span className={styles.modelPickText}>
                <span className={styles.modelPickName}>{model.name}</span>
                {model.name !== model.id ? (
                  <span className={styles.modelPickId}>{model.id}</span>
                ) : null}
              </span>
              <span className={clsx(styles.modelPickCheck, selected && styles.modelPickCheckOn)}>
                {added ? t('providerModelAlreadyAdded') : selected ? <CheckIcon /> : null}
              </span>
            </button>
          )
        })}
      </div>
      {/* 面板内用普通按钮组：styles.actions 是固定的悬浮胶囊，会盖住列表 */}
      <div className={styles.sheetActions}>
        <button type="button" className={styles.sheetButton} onClick={onClose}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className={clsx(styles.sheetButton, styles.sheetButtonPrimary)}
          disabled={picked.size === 0}
          onClick={confirm}
        >
          {t('providerAddSelected', { count: picked.size })}
        </button>
      </div>
    </BottomSheet>
  )
}

const ListIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M3 4.5h10M3 8h10M3 11.5h6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
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

const ProviderIcon = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
    <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="11" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 3v5M11 14v5M3 11h5M14 11h5" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)
