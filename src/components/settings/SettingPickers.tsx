import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { getRegionName, provinces, regionCodes } from '../../services/location.js'
import { BottomSheet, SheetOption } from '../base/BottomSheet.js'

/** 设置里用底部面板选择取值的四项 */
export type SettingPicker = 'theme' | 'locale' | 'tts' | 'location'

/**
 * 设置项的取值选择：点行后从底部弹出面板，选完即生效并关闭。
 * 语言、主题、音色都是单选；位置按浏览器语言决定选省/市还是国家。
 */
export const SettingPickerSheet = ({
  picker,
  onClose,
}: {
  picker: SettingPicker | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const locale = useSettings((state) => state.locale)
  const ttsVoice = useSettings((state) => state.ttsVoice)
  const location = useSettings((state) => state.location)

  if (picker === 'theme') {
    const options: { value: ThemePreference; label: TranslationKey }[] = [
      { value: 'light', label: 'avatarMenuSettingsDialogThemeSelectLightOption' },
      { value: 'dark', label: 'avatarMenuSettingsDialogThemeSelectDarkOption' },
      { value: 'system', label: 'avatarMenuSettingsDialogThemeSelectSystemOption' },
    ]
    return (
      <BottomSheet open title={t('avatarMenuSettingsDialogThemeItemLabel')} onClose={onClose}>
        {options.map((option) => (
          <SheetOption
            key={option.value}
            label={t(option.label)}
            selected={themePreference === option.value}
            onClick={() => {
              setThemePreference(option.value)
              onClose()
            }}
          />
        ))}
      </BottomSheet>
    )
  }

  if (picker === 'locale') {
    const options: { value: 'zh-CN' | 'en-US'; label: string }[] = [
      { value: 'zh-CN', label: t('settingsLocaleZhCN') },
      { value: 'en-US', label: t('settingsLocaleEnUS') },
    ]
    return (
      <BottomSheet open title={t('settingsLocalePreference')} onClose={onClose}>
        {options.map((option) => (
          <SheetOption
            key={option.value}
            label={option.label}
            selected={locale === option.value}
            onClick={() => {
              setLocale(option.value)
              onClose()
            }}
          />
        ))}
      </BottomSheet>
    )
  }

  if (picker === 'tts') {
    const options: { value: 'stella' | 'tide'; label: string }[] = [
      { value: 'stella', label: t('settingsTtsVoiceStella') },
      { value: 'tide', label: t('settingsTtsVoiceTide') },
    ]
    return (
      <BottomSheet open title={t('settingsTtsVoice')} onClose={onClose}>
        {options.map((option) => (
          <SheetOption
            key={option.value}
            label={option.label}
            selected={ttsVoice === option.value}
            onClick={() => {
              setTtsVoice(option.value)
              onClose()
            }}
          />
        ))}
      </BottomSheet>
    )
  }

  if (picker === 'location') {
    const province =
      location?.region === 'CN'
        ? provinces.find((item) => item.code === location.province)
        : undefined
    // 中文浏览器按省市选，其余按国家/地区选
    if (isChineseBrowser()) {
      return (
        <BottomSheet
          open
          title={t('settingsLocation')}
          description={t('settingsLocationHint')}
          onClose={onClose}
        >
          {provinces.map((item) => (
            <SheetOption
              key={item.code}
              label={item.name}
              selected={province?.code === item.code}
              onClick={() => {
                setLocation({ region: 'CN', province: item.code })
                // 有下级城市时继续选城市，否则直接完成
                if (!item.cities.length) {
                  onClose()
                }
              }}
            />
          ))}
        </BottomSheet>
      )
    }
    return (
      <BottomSheet
        open
        title={t('settingsLocation')}
        description={t('settingsLocationHint')}
        onClose={onClose}
      >
        {regionCodes
          .map((code) => ({ code, label: getRegionName(code, locale) }))
          .sort((a, b) => a.label.localeCompare(b.label, locale))
          .map((item) => (
            <SheetOption
              key={item.code}
              label={item.label}
              selected={location?.region === item.code}
              onClick={() => {
                setLocation({ region: item.code })
                onClose()
              }}
            />
          ))}
      </BottomSheet>
    )
  }

  return null
}
