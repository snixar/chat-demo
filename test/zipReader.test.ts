import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readArchive, readEntry } from '../src/services/chat/history/zipReader.ts'

/**
 * ZIP 读取端的防护测试。
 *
 * 这里只构造最小的 ZIP32 结构（STORED，无 data descriptor），
 * 重点验证解压上限与路径规则，不重复测 CRC / 目录顺序等已有逻辑。
 */

type StoredEntry = { path: string; data: Uint8Array }

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 生成 STORED（method=0）的 ZIP32。
 * sizes 允许覆盖目录里声明的 size，用于伪造超大条目。
 */
const makeZip = (
  entries: StoredEntry[],
  declaredSize?: (entry: StoredEntry) => number
): File => {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const size = declaredSize ? declaredSize(entry) : entry.data.length
    const crc = crc32(entry.data)

    const local = new Uint8Array(30 + name.length + entry.data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x800, true) // UTF-8 名称
    lv.setUint16(8, 0) // STORED
    lv.setUint32(14, crc, true)
    lv.setUint32(18, entry.data.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(entry.data, 30 + name.length)
    parts.push(local)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint16(10, 0)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, entry.data.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)

    offset += local.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return new File(
    [...parts, ...central, end].map((part) => new Uint8Array(part)),
    'archive.zip',
    { type: 'application/zip' }
  )
}

const MANIFEST = new TextEncoder().encode('{"export_format_version":3}')

const collect = async (file: File) => {
  const result: { path: string; size: number; bytes: number }[] = []
  for await (const entry of readArchive(file)) {
    const blob = await readEntry(entry)
    result.push({ path: entry.path, size: entry.size, bytes: blob.size })
  }
  return result
}

describe('readArchive', () => {
  it('正常归档可读出全部条目', async () => {
    const file = makeZip([
      { path: 'manifest.json', data: MANIFEST },
      { path: 'chat_sessions/a.json', data: new TextEncoder().encode('{}') },
    ])
    const entries = await collect(file)
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ['manifest.json', 'chat_sessions/a.json']
    )
    assert.equal(entries[0].bytes, MANIFEST.length)
  })

  it('拒绝路径穿越', async () => {
    const file = makeZip([{ path: '../evil.json', data: MANIFEST }])
    await assert.rejects(() => collect(file), /Invalid or unsupported history archive/)
  })

  it('拒绝反斜杠路径', async () => {
    const file = makeZip([{ path: 'a\\b.json', data: MANIFEST }])
    await assert.rejects(() => collect(file), /Invalid or unsupported history archive/)
  })

  it('拒绝声明大小超出单条目上限的条目', async () => {
    // 只声明 200 MB，实际只存几十字节：必须在解压前就被目录校验拦下。
    const file = makeZip([{ path: 'huge.bin', data: new Uint8Array(64) }], () => 200 * 1024 * 1024)
    await assert.rejects(() => collect(file), /Invalid or unsupported history archive/)
  })

  it('声明大小与本地头不一致时拒绝', async () => {
    // 目录声明 64 字节、本地头声明实际长度 64，但目录 size 被改成 32 → CRC/尺寸校验失败
    const file = makeZip([{ path: 'a.json', data: new Uint8Array(64) }], () => 32)
    await assert.rejects(() => collect(file), /Invalid or unsupported history archive/)
  })
})
