import type { MouseEvent } from 'react'
import { safeExternalUrl } from '../../utils/url.js'

/**
 * 客户端搜索的引用角标：模型写 `[citation,domain](url)`，这里渲染成域名小标。
 *
 * 与服务端引用（CitationLink 的数字角标）不同，这条链路没有来源列表，
 * 因此直接把域名显示出来——比原来那一整串 "citation,example.com" 可读得多，
 * 点击仍能打开原文。
 *
 * URL 完全由模型产出，必须过滤协议；不合法时渲染成不可点击的纯文本。
 */
export const WebCitationLink = ({ url, domain }: { url: string; domain: string }) => {
  const href = safeExternalUrl(url)
  if (!href) {
    return <span className="ds-markdown-cite">{domain || url}</span>
  }
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    window.open(href, '_blank', 'noopener,noreferrer')
  }
  return (
    <span className="ds-markdown-cite" role="link" title={href} onClick={open}>
      {domain || href}
    </span>
  )
}
