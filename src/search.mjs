/**
 * 元数据检索（逐行移植 skills/zsxq-knowledge/scripts/search.py）。
 *
 * 契约：
 *   searchIndex(root, params) -> Promise<article[]>
 *   params: { query?, tag?, channel?, category?, dateFrom?, dateTo?, limit? }
 *   返回命中文章对象（index.json 里的原始结构），排序与截断规则与 Python 版一致。
 *
 * 与 Python 版对齐的要点：
 *  - 过滤顺序：channel → tag → category → dateFrom → dateTo → query（与源码一致）。
 *  - tag 优先走 `index.tag_index` 的 id 集合；集合为空时回退到 `article.tags` 成员判断。
 *  - 打分权重 summary 10 / keywords 8 / tags 5 / path 3，同一维度只加一次分。
 *  - 排序：search.py 是先 `sort(key=(-score, date))` 再稳定 `sort(key=-score)`，
 *    最终等价于「分数降序，同分按 date 升序，再同分保持索引原顺序」；这里用单次稳定排序
 *    加原序号兜底实现，语义完全等价。
 *  - id 用 json.mjs 的 parseJsonText 读取：超过 2^53 的 18 位 id 保留为字符串，避免丢精度，
 *    因此 tag_index 与 article.id 的成员判断在字符串域内仍然精确。
 *  - 索引缺失/损坏时抛错，错误码以 `ZSXQ_NO_INDEX` 开头，信息里含「索引不存在」与重建提示。
 */
import { existsSync } from 'node:fs'

import { dataPaths, readJsonIfPresent } from './store.mjs'

/** 按 Unicode 码点比较字符串（等价于 Python 的默认 str 排序）。 */
function cmpCodePoints(a, b) {
  const left = a[Symbol.iterator]()
  const right = b[Symbol.iterator]()
  for (;;) {
    const x = left.next()
    const y = right.next()
    if (x.done && y.done) return 0
    if (x.done) return -1
    if (y.done) return 1
    const cx = x.value.codePointAt(0)
    const cy = y.value.codePointAt(0)
    if (cx !== cy) return cx < cy ? -1 : 1
  }
}

/** Python `a.get(key, '')` 的文本形态。 */
function asText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/** 构造「索引不存在 / 损坏」错误（错误码统一 ZSXQ_NO_INDEX 前缀）。 */
function noIndexError(indexJson, corrupt) {
  const error = new Error(
    corrupt
      ? `索引不存在或已损坏：${indexJson}。请先运行 zsxq_rebuild_index 重建索引`
        + '（等价于 python scripts/build_index.py），再执行检索。'
      : `索引不存在：${indexJson}。请先运行 zsxq_rebuild_index 重建索引`
        + '（等价于 python scripts/build_index.py），再执行检索。',
  )
  error.code = corrupt ? 'ZSXQ_NO_INDEX_CORRUPT' : 'ZSXQ_NO_INDEX'
  return error
}

/**
 * 检索知识库元数据索引。
 *
 * @param root 知识库数据目录（含 index/index.json）。
 * @param params 查询参数，语义同 search.py 的 search()。
 * @returns 命中文章数组（已按打分排序并截断到 limit）。
 */
export async function searchIndex(root, params = {}) {
  const paths = dataPaths(root)
  const { query, tag, channel, category, dateFrom, dateTo } = params
  // Python 默认 limit=20；非整数输入按默认值处理
  const limit = Number.isInteger(params.limit) ? params.limit : 20

  if (!existsSync(paths.indexJson)) throw noIndexError(paths.indexJson, false)
  const index = await readJsonIfPresent(paths.indexJson)
  if (index === null || typeof index !== 'object' || !Array.isArray(index.articles)) {
    throw noIndexError(paths.indexJson, true)
  }

  let results = index.articles

  if (channel) {
    results = results.filter((article) => article.channel === channel)
  }

  if (tag) {
    const tagIndex = index.tag_index !== null && typeof index.tag_index === 'object' ? index.tag_index : {}
    const ids = Object.prototype.hasOwnProperty.call(tagIndex, tag) ? tagIndex[tag] : []
    const idSet = new Set(Array.isArray(ids) ? ids : [])
    results = idSet.size > 0
      ? results.filter((article) => idSet.has(article.id))
      : results.filter((article) => Array.isArray(article.tags) && article.tags.includes(tag))
  }

  if (category) {
    results = results.filter((article) => asText(article.topic_category) === category)
  }

  if (dateFrom) {
    results = results.filter((article) => asText(article.date) >= dateFrom)
  }

  if (dateTo) {
    results = results.filter((article) => asText(article.date) <= dateTo)
  }

  if (query) {
    const needle = String(query).toLowerCase()
    const scored = []
    for (const article of results) {
      let score = 0
      const summary = asText(article.summary).toLowerCase()
      const keywords = Array.isArray(article.keywords) ? article.keywords.map((item) => asText(item).toLowerCase()) : []
      const tags = Array.isArray(article.tags) ? article.tags.map((item) => asText(item).toLowerCase()) : []
      const path = asText(article.path).toLowerCase()

      if (summary.includes(needle)) score += 10
      if (keywords.some((item) => item.includes(needle))) score += 8
      if (tags.some((item) => item.includes(needle))) score += 5
      if (path.includes(needle)) score += 3

      if (score > 0) scored.push({ score, date: asText(article.date), order: scored.length, article })
    }

    // 分数降序 → date 升序 → 索引原顺序（等价于 search.py 的两段稳定排序）
    scored.sort((a, b) => (
      (b.score - a.score)
      || cmpCodePoints(a.date, b.date)
      || (a.order - b.order)
    ))
    results = scored.map((item) => item.article)
  }

  return results.slice(0, limit)
}
