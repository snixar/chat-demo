import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * MCP 工具名的构造与解析规则。
 *
 * 这两个函数在 src/services/mcp/client.ts 里各自独立、不依赖任何运行时状态，
 * 这里复刻一份并锁定行为：执行阶段靠解析结果判断工具归属，解析一旦宽松，
 * 模型构造的名字就可能落到别的服务器分支上。
 *
 * 之所以不直接 import：项目源码用 `.js` 后缀引用 `.ts` 文件（bundler 解析），
 * Node 原生类型剥离不加解析器钩子时无法跟随这种后缀映射。
 */
const SANITIZE = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)

const qualifyToolName = (serverId: string, toolName: string) =>
  `mcp__${SANITIZE(serverId)}__${SANITIZE(toolName)}`

const parseQualifiedToolName = (qualified: string) => {
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified)
  return match ? { serverId: match[1], toolName: match[2] } : null
}

describe('qualifyToolName', () => {
  it('加上服务器前缀并替换非法字符', () => {
    assert.equal(qualifyToolName('abc123', 'read_file'), 'mcp__abc123__read_file')
    assert.equal(qualifyToolName('abc123', 'has space/dot'), 'mcp__abc123__has_space_dot')
    // 非 ASCII 与非法字符逐个替换为下划线
    assert.equal(qualifyToolName('abc123', '中文名'), 'mcp__abc123_____')
  })

  it('截断超长片段，避免超出 API 的工具名限制', () => {
    const name = qualifyToolName('s', 'x'.repeat(200))
    assert.ok(name.length <= 'mcp__s__'.length + 64)
  })
})

describe('parseQualifiedToolName', () => {
  it('还原服务器与工具原名', () => {
    assert.deepEqual(parseQualifiedToolName('mcp__abc__read_file'), {
      serverId: 'abc',
      toolName: 'read_file',
    })
  })

  it('非法输入返回 null', () => {
    for (const name of ['', 'read_file', 'mcp__onlyserver', 'abc__def__ghi']) {
      assert.equal(parseQualifiedToolName(name), null, `应拒绝 ${JSON.stringify(name)}`)
    }
  })

  it('构造与解析可往返', () => {
    const qualified = qualifyToolName('srv1', 'do_thing')
    assert.deepEqual(parseQualifiedToolName(qualified), {
      serverId: 'srv1',
      toolName: 'do_thing',
    })
  })
})

/**
 * 执行白名单的核心规则，与 callTool 的判定顺序一致：
 * 本轮未声明的工具、被停用的服务器、被单独停用的工具，一律不执行。
 */
const allowedToExecute = (
  qualifiedName: string,
  declared: ReadonlySet<string>,
  serverEnabled: boolean,
  toolDisabled: boolean
) => {
  if (!declared.has(qualifiedName)) {
    return false
  }
  if (!serverEnabled || toolDisabled) {
    return false
  }
  return parseQualifiedToolName(qualifiedName) !== null
}

describe('callTool 的授权规则', () => {
  const name = 'mcp__srv__restricted_action'

  it('声明过且服务器启用、工具未停用时允许执行', () => {
    assert.equal(allowedToExecute(name, new Set([name]), true, false), true)
  })

  it('本轮未声明时拒绝（会话级服务器开关、或工具声明被整体关闭）', () => {
    assert.equal(allowedToExecute(name, new Set(), true, false), false)
    assert.equal(allowedToExecute(name, new Set(['mcp__srv__other']), true, false), false)
  })

  it('服务器被停用后拒绝，即使缓存里仍连着', () => {
    assert.equal(allowedToExecute(name, new Set([name]), false, false), false)
  })

  it('工具被单独停用后拒绝', () => {
    assert.equal(allowedToExecute(name, new Set([name]), true, true), false)
  })
})
