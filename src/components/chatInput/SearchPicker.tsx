import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  resolveSearchService,
  setSelectedSearchService,
  useSearchServices,
} from '../../services/search/store.js'
import { serviceMeta } from '../../services/search/types.js'
import styles from './SearchPicker.module.css'

/**
 * 搜索服务选择页（附件面板的子页面，入口在「模型」下方）。
 *
 * 对齐 rikkahub 的 SearchPicker：列出所有已启用的搜索服务，当前使用的打勾；
 * 顶部一行「自动」表示不指定，按列表顺序取第一台，都没有则回退 DeepSeek。
 * 这里只切换「用哪个」，增删改配置在设置页里。
 */
export const SearchPicker = ({ onPicked }: { onPicked?: () => void }) => {
  const t = useTranslate()
  const services = useSearchServices((state) => state.services)
  const selectedId = useSearchServices((state) => state.selectedId)
  const enabled = services.filter((item) => item.enabled)

  // 实际生效的服务：没显式选就是第一台，再没有就是 DeepSeek 回退
  const active = resolveSearchService()
  const isAuto = selectedId === null

  const pick = (id: string | null) => {
    setSelectedSearchService(id)
    onPicked?.()
  }

  return (
    <div className={styles.list}>
      <button
        type="button"
        className={styles.item}
        aria-pressed={isAuto}
        onClick={() => pick(null)}
      >
        <span className={styles.itemText}>
          <span className={styles.itemLabel}>{t('searchPickerAuto')}</span>
          <span className={styles.itemSub}>
            {active
              ? t('searchPickerAutoSub', { name: active.name })
              : t('searchPickerNoService')}
          </span>
        </span>
        {isAuto ? (
          <span className={styles.check}>
            <CheckIcon />
          </span>
        ) : null}
      </button>

      {enabled.map((service) => {
        const checked = !isAuto && selectedId === service.id
        return (
          <button
            key={service.id}
            type="button"
            className={styles.item}
            aria-pressed={checked}
            onClick={() => pick(service.id)}
          >
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{service.name}</span>
              <span className={styles.itemSub}>{serviceMeta(service.serviceId).label}</span>
            </span>
            {checked ? (
              <span className={styles.check}>
                <CheckIcon />
              </span>
            ) : null}
          </button>
        )
      })}

      {enabled.length === 0 ? (
        <p className={styles.hint}>{t('searchPickerEmpty')}</p>
      ) : null}

      <p className={clsx(styles.hint, styles.hintBottom)}>{t('searchPickerHint')}</p>
    </div>
  )
}

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
