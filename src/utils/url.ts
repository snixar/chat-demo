/**
 * 外链统一过滤。
 *
 * 页面上所有可点击的外部地址（模型正文里的 Markdown 链接、服务端引用角标、
 * 客户端搜索结果卡片、工具步骤里的网页标题）都经过这里：只放行 HTTP / HTTPS
 * 与 mailto，其余协议一律返回 undefined。
 *
 * 必须集中在一处：模型输出完全不可信，`[citation,x](javascript:...)` 这类地址
 * 由 parse 层原样保留，各渲染点若各自判断，迟早漏掉一处。
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 明确带协议头，如 `https://`、`data:`、`javascript:` */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** 带 `//` 的绝对地址，只有这类才原样交给 URL 解析 */
const HAS_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/**
 * 合法主机名：普通域名 / IP，或 IPv6 字面量。
 * URL 解析器对非法字符很宽容（`ht!tp` 也能当主机名），这里再确认一次，
 * 避免把畸形输入拼成 `https://ht!tp//x` 这种指向不存在站点的地址。
 */
const VALID_HOST = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*)$/

/**
 * 把外部地址规范化为可安全放进 href / window.open 的字符串。
 * 没有协议头的裸域名按 https 补齐；无法解析或协议不在白名单内时返回 undefined，
 * 调用方应降级为纯文本，而不是渲染一个空链接。
 */
export const safeExternalUrl = (url: string): string | undefined => {
  const trimmed = url.trim()
  if (!trimmed) {
    return undefined
  }

  let candidate: string
  if (HAS_AUTHORITY.test(trimmed)) {
    candidate = trimmed
  } else if (/^mailto:/i.test(trimmed)) {
    candidate = trimmed
  } else if (HAS_SCHEME.test(trimmed)) {
    // javascript:、data:、vbscript:、file:、tel: 等：不是我们支持的外链形态
    return undefined
  } else {
    // 裸域名或省略了 https:// 的地址
    candidate = `https://${trimmed}`
  }

  try {
    const parsed = new URL(candidate)
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return undefined
    }
    // mailto 没有主机名，单独放行；网页地址必须落在合法主机上
    if (parsed.protocol !== 'mailto:' && !VALID_HOST.test(parsed.hostname)) {
      return undefined
    }
    return parsed.toString()
  } catch {
    return undefined
  }
}

/** 是否是可安全打开的网页地址（不含 mailto），用于链接展示类判断 */
export const isSafeWebUrl = (url: string): boolean => {
  const safe = safeExternalUrl(url)
  return safe !== undefined && safe.startsWith('http')
}
