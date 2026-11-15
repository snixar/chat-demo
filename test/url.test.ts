import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isSafeWebUrl, safeExternalUrl } from '../src/utils/url.ts'

/**
 * 外链过滤是唯一拦住「模型输出 javascript: 链接被点击」的地方，
 * 这里把已知的绕过手法与正常用例都钉住。
 */
describe('safeExternalUrl', () => {
  it('放行 http / https / mailto', () => {
    assert.equal(safeExternalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
    assert.equal(safeExternalUrl('http://example.com/'), 'http://example.com/')
    assert.equal(safeExternalUrl('mailto:someone@example.com'), 'mailto:someone@example.com')
  })

  it('裸域名补 https', () => {
    assert.equal(safeExternalUrl('example.com/path'), 'https://example.com/path')
    assert.equal(safeExternalUrl('  https://ok.com  '), 'https://ok.com/')
  })

  it('协议相对地址按 https 处理', () => {
    assert.equal(safeExternalUrl('//evil.example/x'), 'https://evil.example/x')
  })

  it('拦截脚本类协议', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.com/uuid',
      'tel:+123456',
      'about:blank',
    ]) {
      assert.equal(safeExternalUrl(hostile), undefined, `应拒绝 ${JSON.stringify(hostile)}`)
    }
  })

  it('无法解析或空值返回 undefined', () => {
    assert.equal(safeExternalUrl(''), undefined)
    assert.equal(safeExternalUrl('   '), undefined)
    assert.equal(safeExternalUrl('ht!tp://x'), undefined)
    // 带端口的裸主机被当成未知协议，fail-closed 比放行安全
    assert.equal(safeExternalUrl('example.com:8080/path'), undefined)
  })
})

describe('isSafeWebUrl', () => {
  it('只认可网页地址', () => {
    assert.equal(isSafeWebUrl('https://example.com/'), true)
    assert.equal(isSafeWebUrl('http://example.com/'), true)
    assert.equal(isSafeWebUrl('mailto:a@b.c'), false)
    assert.equal(isSafeWebUrl('javascript:alert(1)'), false)
    assert.equal(isSafeWebUrl(''), false)
  })
})
