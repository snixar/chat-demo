import type { MouseEvent } from 'react'

/**
 * 客户端搜索的引用角标：模型写 `[citation,domain](url)`，这里渲染成域名小标。
 *
 * 与服务端引用（CitationLink 的数字角标）不同，这条链路没有来源列表，
 * 因此直接把域名显示出来——比原来那一整串 "citation,example.com" 可读得多，
 * 点击仍能打开原文。
 */
export const WebCitationLink = ({ url, domain }: { url: string; domain: string }) => {
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  return (
    <span className="ds-markdown-cite" role="link" title={url} onClick={open}>
      {domain || url}
    </span>
  )
}
