import { create } from 'zustand'

/**
 * API Key 编辑弹窗的开合状态。
 *
 * 放在 store 而不是组件里，是因为有三处都要能打开它：
 * 设置页的行、发送前的 `ensureApiKey` 拦截、错误提示里的「更换 API Key」。
 * 弹窗本身由 SettingsScreen 渲染（portal），因此打开前要确保设置页也已打开。
 */
export const useApiKeySheet = create<{ open: boolean }>(() => ({ open: false }))

export const openApiKeySheet = () => useApiKeySheet.setState({ open: true })

export const closeApiKeySheet = () => useApiKeySheet.setState({ open: false })
