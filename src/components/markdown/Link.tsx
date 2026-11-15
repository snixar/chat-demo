import type { Image, Link as LinkNode } from 'mdast'
import { memo, type ReactNode } from 'react'
import { safeExternalUrl } from '../../utils/url.js'

/** 与引用角标、搜索结果卡共用同一套协议白名单，见 utils/url.ts */
const sanitizeUrl = safeExternalUrl

export const Link = memo(function Link({
  node,
  children,
}: {
  node: LinkNode
  children: ReactNode
}) {
  // 页内锚点显示链接文字。
  if (node.url.startsWith('#')) {
    return children
  }

  // 邮件地址显示链接文字。
  if (node.url.startsWith('mailto:')) {
    return children
  }

  // URL 不合法（javascript:、data: 等）时降级为纯文本：渲染成没有 href 的 <a>
  // 会让链接看起来仍可点击，也容易在样式上误导。
  const href = sanitizeUrl(node.url)
  if (!href) {
    return children
  }

  return (
    <a href={href} title={node.title || undefined} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
})

/** Markdown 图片显示为指向图片地址的链接；地址不合法时只显示原文 */
export function ImageAsLink({ node }: { node: Image }) {
  const url = sanitizeUrl(node.url)
  if (!url) {
    return <span>{node.url}</span>
  }
  return (
    <a href={url} title={node.title ?? ''} target="_blank" rel="noreferrer">
      {url}
    </a>
  )
}
