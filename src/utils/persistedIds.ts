/**
 * 以「一组 id」形式持久化的本机选择（如新对话默认启用的 MCP 服务器）。
 *
 * 关键约束是 null 与空数组语义不同，必须严格区分：
 * - `null`：用户从未设置过 → 调用方回退到默认值（全部启用）
 * - `[]`：用户明确关掉了全部 → 必须保持「一个都不启用」
 *
 * 把两者混为一谈正是「关掉服务器后又自己打开」的成因，所以解析逻辑单独
 * 放在这里并加测试，避免以后被 `||` / `??` 之类的写法改坏。
 */

/** 解析失败或从未设置时返回 null；空数组是合法的「全关」状态 */
export const parseStoredIds = (raw: string | null): string[] | null => {
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? (parsed as string[])
      : null
  } catch {
    return null
  }
}

/** 序列化：null 表示清除记录，空数组写成 `[]` 而不是删掉键 */
export const serializeStoredIds = (ids: string[] | null): string | null =>
  ids === null ? null : JSON.stringify(ids)

/**
 * 去掉已不存在的 id 并去重。
 * 服务器被删除后记忆里会残留旧 id，不清理会让「开关状态」与列表对不上；
 * 新添加的服务器不在记忆里，因此默认不启用，由用户显式打开。
 */
export const pruneIds = (ids: string[], existing: ReadonlySet<string>): string[] => [
  ...new Set(ids.filter((id) => existing.has(id))),
]
