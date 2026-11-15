import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

/**
 * 客户端搜索用的引用：模型按约定写 `[citation,domain](url)`。
 * 与上面的 [citation:N] 不同，它没有服务端来源列表，链接本身就是来源。
 */
export interface WebCitationNode extends MdAstNode {
  type: 'webCitation'
  url: string
  domain: string
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
    webCitation: WebCitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
    webCitation: WebCitationNode
  }
}

/** 取节点的纯文本，用于识别 [citation,domain] 这种链接文字 */
const plainText = (node: Nodes): string => {
  if (node.type === 'text') {
    return node.value
  }
  if ('children' in node) {
    return (node as Parent).children.map(plainText).join('')
  }
  return ''
}

const text = (value: string): Text => ({ type: 'text', value })

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: Source[] | undefined; disableLink: boolean }
): Root {
  const ast = fromMarkdown(input, {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link': {
        // 模型按搜索工具的约定写 [citation,domain](url)：换成紧凑角标，
        // 否则用户会看到一长串 "citation,example.com" 的裸文字
        const label = plainText(node)
        if (label.startsWith('citation,')) {
          return [
            {
              type: 'webCitation',
              url: node.url,
              domain: label.slice('citation,'.length).trim(),
            },
          ]
        }
        return disableLink ? node.children : [node]
      }
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}
