/**
 * 大整数安全的 JSON 解析。
 *
 * 知识星球的 topic_id 是 18 位整数，超过 `Number.MAX_SAFE_INTEGER`（2^53-1）；
 * 直接用 `JSON.parse` 会静默丢精度，导致 frontmatter id、去重、索引与搜索全部错位。
 * 这里用 json-bigint 的 `storeAsString`：超出安全范围的整数解析为字符串，其余保持数字。
 */
import JSONBig from 'json-bigint'

const parser = JSONBig({ storeAsString: true })

/**
 * 解析 JSON 文本（大整数转字符串）。
 * @param text JSON 文本。
 * @returns 解析结果。
 */
export function parseJsonText(text) {
  return parser.parse(text)
}

/**
 * 把 18 位 id 序列化为**精确的数字字面量**（而不是字符串或丢精度的 number）。
 *
 * Python 版 index.json 里的 id 是整数；为了逐字节对齐，这里用 `JSON.rawJSON`
 * 让 `JSON.stringify` 原样写出数字。Node 不支持时退化为字符串（可读、不丢精度）。
 *
 * @param value 字符串或数字形式的 id。
 * @returns 可直接放进 JSON.stringify 的值。
 */
export function rawId(value) {
  const text = String(value)
  if (!/^\d+$/.test(text)) return value
  if (typeof JSON.rawJSON === 'function') {
    try {
      return JSON.rawJSON(text)
    } catch {
      return text
    }
  }
  return text
}
