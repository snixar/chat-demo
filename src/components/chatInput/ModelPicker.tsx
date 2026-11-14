import { useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { useProviders, setModelSelection } from '../../services/providers/store.js'
import { OFFICIAL_MODELS, officialModelLabel } from '../../services/providers/types.js'
import styles from './ModelPicker.module.css'

/**
 * 模型选择页（附件面板的子页面），布局对齐 rikkahub 的 ModelList：
 * 按提供商分组、组头可折叠，组内每行是模型，当前选中的打勾。
 * 首组固定「DeepSeek 官方」，其后是自定义提供商。
 */
export const ModelPicker = ({ onPicked }: { onPicked?: () => void }) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const selection = useProviders((state) => state.selection)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

  const pickOfficial = (model: string) => {
    setModelSelection({
      kind: 'official',
      model: model as (typeof OFFICIAL_MODELS)[number]['model'],
    })
    onPicked?.()
  }
  const pickCustom = (providerId: string, modelId: string) => {
    setModelSelection({ kind: 'custom', providerId, modelId })
    onPicked?.()
  }

  const groups = [
    {
      key: 'official',
      name: t('modelPickerOfficial'),
      items: OFFICIAL_MODELS.map((item) => ({
        key: item.model,
        label: item.label,
        sub: item.model,
        selected: selection.kind === 'official' && selection.model === item.model,
        pick: () => pickOfficial(item.model),
      })),
    },
    ...providers
      .filter((provider) => provider.enabled && provider.models.length > 0)
      .map((provider) => ({
        key: provider.id,
        name: provider.name || provider.baseUrl,
        items: provider.models.map((model) => ({
          key: model.id,
          label: model.displayName || model.modelId,
          sub: model.modelId,
          selected:
            selection.kind === 'custom' &&
            selection.providerId === provider.id &&
            selection.modelId === model.id,
          pick: () => pickCustom(provider.id, model.id),
        })),
      })),
  ]

  return (
    <div className={styles.list}>
      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? false
        return (
          <section key={group.key} className={styles.group}>
            <button type="button" className={styles.groupHeader} onClick={() => toggle(group.key)}>
              <span className={styles.groupName}>{group.name}</span>
              <span
                className={clsx(styles.groupChevron, isCollapsed && styles.groupChevronCollapsed)}
              >
                <ChevronIcon />
              </span>
            </button>
            {isCollapsed
              ? null
              : group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={styles.item}
                    aria-pressed={item.selected}
                    onClick={item.pick}
                  >
                    <span className={styles.itemText}>
                      <span className={styles.itemLabel}>{item.label}</span>
                      <span className={styles.itemSub}>{item.sub}</span>
                    </span>
                    {item.selected ? (
                      <span className={styles.check}>
                        <CheckIcon />
                      </span>
                    ) : null}
                  </button>
                ))}
          </section>
        )
      })}
      {providers.filter((provider) => provider.enabled).length === 0 ? (
        <p className={styles.hint}>{t('modelPickerNoProviders')}</p>
      ) : null}
    </div>
  )
}

/** 当前模型名，用于入口行右侧的值 */
export const useCurrentModelLabel = () => {
  const selection = useProviders((state) => state.selection)
  const providers = useProviders((state) => state.providers)
  if (selection.kind === 'official') {
    return officialModelLabel(selection.model)
  }
  const provider = providers.find((item) => item.id === selection.providerId)
  const model = provider?.models.find((item) => item.id === selection.modelId)
  return model?.displayName || model?.modelId || officialModelLabel('deepseek-flash')
}

const ChevronIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M4 6l4 4 4-4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
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
