import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseStoredIds,
  pruneIds,
  serializeStoredIds,
} from '../src/utils/persistedIds.ts'

/**
 * 「关掉的 MCP 服务器又自己打开」的根因是 null 与 [] 被混为一谈：
 * null 会被当成「全部启用」，于是用户明确关闭的服务器在刷新后重新出现。
 * 这里把两者必须严格区分这条约束钉死。
 */
describe('parseStoredIds', () => {
  it('从未设置时返回 null（调用方回退默认值）', () => {
    assert.equal(parseStoredIds(null), null)
    assert.equal(parseStoredIds(''), null)
  })

  it('空数组是合法的「全关」，不能被当成 null', () => {
    const parsed = parseStoredIds('[]')
    assert.deepEqual(parsed, [])
    assert.notEqual(parsed, null, '空数组必须与 null 区分，否则会回退成全部启用')
  })

  it('正常列表原样解析', () => {
    assert.deepEqual(parseStoredIds('["a","b"]'), ['a', 'b'])
  })

  it('结构不合法时返回 null', () => {
    for (const raw of ['{"a":1}', '"str"', '[1,2]', '[null]', 'not json', '["a",1]']) {
      assert.equal(parseStoredIds(raw), null, `应拒绝 ${raw}`)
    }
  })
})

describe('serializeStoredIds', () => {
  it('null 表示清除，空数组写成 []', () => {
    assert.equal(serializeStoredIds(null), null)
    assert.equal(serializeStoredIds([]), '[]')
    assert.equal(serializeStoredIds(['a']), '["a"]')
  })

  it('与 parse 往返一致，且空数组不会退化成 null', () => {
    for (const ids of [[], ['a'], ['a', 'b']]) {
      const restored = parseStoredIds(serializeStoredIds(ids))
      assert.deepEqual(restored, ids)
    }
    assert.equal(parseStoredIds(serializeStoredIds(null)), null)
  })
})

describe('pruneIds', () => {
  it('丢弃已删除的服务器 id 并去重', () => {
    const existing = new Set(['a', 'b'])
    assert.deepEqual(pruneIds(['a', 'ghost', 'b', 'a'], existing), ['a', 'b'])
  })

  it('全部失效时返回空数组而不是 null', () => {
    assert.deepEqual(pruneIds(['x', 'y'], new Set(['a'])), [])
  })

  it('新服务器不在记忆里，因此不会被自动启用', () => {
    // 记忆里只有 a，新增 b 之后仍然只启用 a
    assert.deepEqual(pruneIds(['a'], new Set(['a', 'b'])), ['a'])
  })
})
