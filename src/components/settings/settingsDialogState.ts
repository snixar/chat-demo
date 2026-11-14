import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置页的路由；root 是分组列表，mcpServer 是服务器详情 */
export type SettingsRoute =
  | { name: 'root' }
  | { name: 'mcp' }
  | { name: 'apiKey' }
  | { name: 'data' }
  | { name: 'providers' }
  /** providerId 为 null 表示新建，保存后才真正落库 */
  | { name: 'providerDetail'; providerId: string | null }
  | { name: 'mcpServer'; serverId: string }

/** 可直达的二级页（不含 root 与需要参数的路由） */
export type SettingsPageId = Exclude<SettingsRoute['name'], 'root' | 'mcpServer' | 'providerDetail'>

/**
 * 设置页状态。栈放在 store 而不是组件里，因为原生返回键、侧边栏入口都要能控制它：
 * - open 控制挂载
 * - stack 是当前的页面层级，栈底永远是 root
 */
export const useSettingsDialog = create<{
  open: boolean
  stack: SettingsRoute[]
}>(() => ({ open: false, stack: [{ name: 'root' }] }))

const isSameRoute = (a: SettingsRoute, b: SettingsRoute) => {
  if (a.name !== b.name) {
    return false
  }
  if (a.name === 'mcpServer' && b.name === 'mcpServer') {
    return a.serverId === b.serverId
  }
  if (a.name === 'providerDetail' && b.name === 'providerDetail') {
    return a.providerId === b.providerId
  }
  return true
}

/** 打开设置；page 为 null 时停在列表页 */
export const openSettings = (page: SettingsPageId | null = null) => {
  const stack: SettingsRoute[] = [{ name: 'root' }]
  if (page) {
    stack.push({ name: page })
  }
  useSettingsDialog.setState({ open: true, stack })
}

/** 打开某台提供商的详情；传 null 表示新建 */
export const openProviderDetail = (providerId: string | null) =>
  useSettingsDialog.setState((state) => ({
    open: true,
    stack: [
      ...state.stack.filter((route) => route.name === 'root'),
      { name: 'providers' },
      { name: 'providerDetail', providerId },
    ],
  }))

/** 打开某个 MCP 服务器的详情 */
export const openMcpServer = (serverId: string) =>
  useSettingsDialog.setState((state) => ({
    open: true,
    stack: [
      ...state.stack.filter((route) => route.name === 'root'),
      { name: 'mcpServer', serverId },
    ],
  }))

export const closeSettings = () =>
  useSettingsDialog.setState({ open: false, stack: [{ name: 'root' }] })

export const pushSettingsRoute = (route: SettingsRoute) =>
  useSettingsDialog.setState((state) =>
    // 同一路由不重复入栈（如连点两次同一行）
    isSameRoute(state.stack.at(-1) ?? { name: 'root' }, route)
      ? state
      : { stack: [...state.stack, route] }
  )

/**
 * 返回上一层。栈里只剩 root 时关闭设置页并返回 false，
 * 让调用方（原生返回键）决定是否继续处理。
 */
export const popSettingsRoute = (): boolean => {
  const { open, stack } = useSettingsDialog.getState()
  if (!open) {
    return false
  }
  if (stack.length <= 1) {
    closeSettings()
    return true
  }
  useSettingsDialog.setState({ stack: stack.slice(0, -1) })
  return true
}

/** 没有 API Key 时打开设置并直达 Key 页面，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('apiKey')
  return false
}
