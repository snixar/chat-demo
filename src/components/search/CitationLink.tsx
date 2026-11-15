import type { MouseEvent } from 'react'
import type { Source } from '../../services/chat/view.js'
import { safeExternalUrl } from '../../utils/url.js'
import { HoverCard, type HoverCardTrigger } from './HoverCard.js'
import { SourceCard } from './SourceCard.js'

/**
 * 正文里 [citation:N] 的数字角标：悬停预览来源，点击新标签打开。
 * 角标使用带 link 角色的 span，可嵌入链接文字。样式由 .ds-markdown-cite 提供。
 *
 * 来源地址来自服务端响应，同样按外链白名单过滤；不合法时角标不可点击，
 * 悬停卡片里的链接也会降级为纯文本（见 SourceCard）。
 */
export const CitationLink = ({ source }: { source: Source }) => {
  const href = safeExternalUrl(source.url)
  const open = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (href) {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  }
  const renderTrigger: HoverCardTrigger = ({ domRef, domProps }) => (
    <span
      ref={domRef}
      className="ds-markdown-cite"
      {...domProps}
      role={href ? 'link' : undefined}
      onClick={href ? open : undefined}
    >
      {source.index}
    </span>
  )
  return (
    <HoverCard renderTrigger={renderTrigger}>
      <SourceCard source={source} />
    </HoverCard>
  )
}
