/**
 * 索引重建（逐字节移植 skills/zsxq-knowledge/scripts/build_index.py）。
 *
 * 契约：
 *   buildIndexFiles(root, options?) -> { files: [{ path, content }], stats: { articles, quotes, warnings } }
 *   - path 为相对 dataDir（知识库数据目录）的 POSIX 路径；content 为完整文件文本。
 *   - 本模块**不写盘**，由调用方（zsxq_rebuild_index）遍历 files 落盘。
 *
 * 与 Python 版对齐的要点（全部取自 build_index.py 实际源码行为）：
 *  - frontmatter 用**手写解析器**的语义（不是 YAML 规范）。Python 现行版逐行正则解析，
 *    与 `yaml` 包在类型上有差异：`id: "555..."` 会经 strip('"') + isdigit() 变成 **int**
 *    （yaml 得到字符串）、`2026-04-11` 保持字符串（yaml 也是字符串）、`tags/keywords`
 *    的字符串形态有额外归一化。为逐字节一致，这里复刻手写解析器而不是调用 yaml。
 *  - 扫描顺序 = Python `sorted(rglob("*.md"), reverse=True)`：按**码点**升序后反转。
 *    注意 JS 默认字符串排序比较 UTF-16 code unit，与 Python 码点序在非 BMP 字符上不同，
 *    所以统一用 cmpCodePoints。
 *  - 所有表格渲染沿用 Python 的 `_trunc`（按码点截断 + `|` 转义）与 `_rel`（`../../` 前缀）。
 *  - index.json 的 id 是 Python int（18 位、超过 2^53）。这里用 json.mjs 的 rawId 写出
 *    **精确数字字面量**，既与 Python 逐字节一致，又避免 JS number 丢精度
 *    （`JSON.parse` 会把 55522284588544514 读成 ...10）。
 *  - 已知唯一无法逐字节对齐处：quotes-index.md 的金句顺序。Python 依赖 os.scandir 的
 *    原始目录项顺序，Node 的 fs.readdir 被 libuv 字母排序、拿不到原始顺序；这里改用
 *    **确定性排序**（同目录按文件名、目录 DFS），条数与内容集合完全一致，仅顺序不同。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { rawId } from './json.mjs'
import { dataPaths, listMarkdownFiles, toPosix } from './store.mjs'

const MAX_LINES_PER_FILE = 500
const MAX_QUOTES_IN_INDEX = 300
/** Python 的 frontmatter 结束标记（注意是 `\n---`，不是行首 `---`）。 */
const FRONTMATTER_END = '\n---'
/** 复刻 Python 正则 `^(\w[\w_]*)\s*:\s*(.*)`（\w 在 Python 里是 unicode 词字符）。 */
const FRONTMATTER_KEY = /^([\p{L}\p{N}_][\p{L}\p{N}_]*)\s*:\s*(.*)$/u
const DIGITS_ONLY = /^[0-9]+$/

// ---------------------------------------------------------------------------
// Python 语义的小工具（码点排序 / 码点截断 / str.strip(chars) 等）
// ---------------------------------------------------------------------------

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

/** 升序排序字符串列表（码点序）。 */
function sortStrings(values) {
  return [...values].sort(cmpCodePoints)
}

/** Python `len(s)`：按码点计数。 */
function cpLength(value) {
  return [...value].length
}

/** Python `s[:n]`：按码点切片。 */
function cpSlice(value, n) {
  let out = ''
  let index = 0
  for (const char of value) {
    if (index >= n) break
    out += char
    index += 1
  }
  return out
}

/** Python `s.strip(chars)`：去掉首尾出现在 chars 中的字符。 */
function stripChars(value, chars) {
  const set = new Set(chars)
  let start = 0
  let end = value.length
  while (start < end && set.has(value[start])) start += 1
  while (end > start && set.has(value[end - 1])) end -= 1
  return value.slice(start, end)
}

/** Python `a.get(key, '')` 后转成文本；仅在渲染表格/JSON 的字符串字段时使用。 */
function asText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Python `Path(p).stem`：去掉最后一个后缀（隐藏文件如 `.md` 单独处理）。 */
function pyStem(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Python `_trunc`：`|` 转义、换行替换为空格，超长按码点截断并加省略号。 */
function trunc(value, n) {
  const text = value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return cpLength(text) > n ? `${cpSlice(text, n)}...` : text
}

/** Python `_safe_index_name`：过滤文件系统非法字符，空名回退 other。 */
function safeIndexName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|#]/g, '').trim()
  return cleaned.length > 0 ? cleaned : 'other'
}

/** 文章 tags 字段（Python 里缺失 / 非列表都按空处理）。 */
function tagsOf(article) {
  return Array.isArray(article.tags) ? article.tags : []
}

/** Python `_now()`：本地时间 `YYYY-MM-DD HH:MM`。 */
function formatNow(value) {
  const date = value instanceof Date ? value : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

// ---------------------------------------------------------------------------
// frontmatter 解析（build_index.py 手写解析器的等价实现）
// ---------------------------------------------------------------------------

/** 复刻 Python 的 int 字面量转换：安全范围用 number，超范围用 BigInt 保精确。 */
function parsePyInt(text) {
  const number = Number(text)
  if (Number.isSafeInteger(number) && String(number) === text) return number
  return BigInt(text)
}

/** 复刻 Python `parse_frontmatter` 的标量取值顺序。 */
function parseScalar(value) {
  if (value === '[]') return []
  if (value === 'true') return true
  if (value === 'false') return false
  if (DIGITS_ONLY.test(value)) return parsePyInt(value)
  if (value === '') return ''
  return value
}

/**
 * 解析 Markdown 的 frontmatter；无 frontmatter 时返回 undefined。
 * @param text Markdown 全文。
 */
function parseFrontmatterText(text) {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf(FRONTMATTER_END, 3)
  if (end < 0) return undefined

  const fmText = text.slice(3, end).trim()
  const meta = {}
  let currentKey = null
  let currentList = null

  for (const line of fmText.split('\n')) {
    // YAML 列表项：只有 `  - ` 开头且已有当前 key 时才收集
    if (line.startsWith('  - ') && currentKey !== null) {
      if (currentList === null) currentList = []
      // Python: line.strip().lstrip("- ").strip().strip('"')
      currentList.push(stripChars(line.trim().replace(/^[- ]+/, '').trim(), '"'))
      meta[currentKey] = currentList
      continue
    }
    // Python: 缩进续行（不含冒号）直接忽略
    if (line.startsWith('  ') && currentKey !== null && !line.split('#')[0].includes(':')) {
      continue
    }

    if (currentList !== null) currentList = null

    const match = FRONTMATTER_KEY.exec(line)
    if (match === null) continue
    currentKey = match[1]
    meta[currentKey] = parseScalar(stripChars(match[2].trim(), '"'))
  }

  // Python 的 tags/keywords 字符串归一化
  if (typeof meta.tags === 'string') {
    meta.tags = meta.tags ? [meta.tags] : []
  }
  if (typeof meta.keywords === 'string') {
    const raw = stripChars(meta.keywords, '[]')
    meta.keywords = raw
      ? raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => stripChars(part, '"'))
      : []
  }
  return meta
}

// ---------------------------------------------------------------------------
// 扫描（文章 / 金句）
// ---------------------------------------------------------------------------

/**
 * 递归列文件，按 `os.walk` 的形态：先列本目录文件（按文件名排序），再进子目录（按名排序）。
 *
 * 与 Python 的差异（唯一一处无法对齐的地方）：Python `Path.rglob` 用的是 `os.scandir`
 * 的**原始目录项顺序**（APFS 上约等于创建顺序），而 Node 的 `fs.readdir` 经 libuv 做了
 * 字母排序，拿不到原始顺序。因此 quotes-index.md 的「金句出现顺序」与 Python 不同
 * （条数、内容集合完全一致）；这里选择**确定性排序**，保证跨机器/跨次重建可复现。
 *
 * @param dir 起始目录。
 * @param matches 文件名判定。
 * @param out 输出绝对路径列表。
 */
async function walkFiles(dir, matches, out) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const sorted = [...entries].sort((a, b) => cmpCodePoints(a.name, b.name))
  const directories = []
  for (const entry of sorted) {
    if (entry.isDirectory()) directories.push(join(dir, entry.name))
    else if (matches(entry.name)) out.push(join(dir, entry.name))
  }
  for (const child of directories) await walkFiles(child, matches, out)
}

/**
 * 扫描 channels/**\/*.md 文章（排除 .quotes.md）。
 * @returns Python `scan_articles()` 的顺序：路径降序。
 */
async function scanArticles(dataDir, warnings) {
  const relPaths = await listMarkdownFiles(dataDir)
  // Python: sorted(rglob(...), reverse=True) —— 等价于升序码点排序后反转
  const ordered = sortStrings(relPaths).reverse()

  const articles = []
  for (const relPath of ordered) {
    let text
    try {
      text = await readFile(join(dataDir, relPath), 'utf8')
    } catch (error) {
      warnings.push(`${relPath}: 读取失败，已跳过（${error?.message ?? error}）`)
      continue
    }
    const meta = parseFrontmatterText(text)
    if (!meta || !('id' in meta)) {
      warnings.push(`${relPath}: 缺少 frontmatter 或 id 字段，未计入索引`)
      continue
    }
    meta._path = relPath
    const quotesRel = `${relPath.replace(/\.md$/, '')}.quotes.md`
    if (existsSync(join(dataDir, quotesRel))) meta._quotes_path = quotesRel
    articles.push(meta)
  }
  return articles
}

/**
 * 扫描金句：channels/**\/*.quotes.md（有原文路径）与 quotes/**\/*.md（无原文路径）。
 * 顺序与 Python 的 rglob 一致（不排序）。
 */
async function scanQuotes(dataDir, channelsDir) {
  const quotes = []
  const quoteFiles = []
  await walkFiles(channelsDir, (name) => name.endsWith('.quotes.md'), quoteFiles)
  for (const full of quoteFiles) {
    const relPath = toPosix(full.slice(dataDir.length + 1))
    // Python: qf.name.replace(".quotes.md", ".md")（str.replace 替换所有出现）
    const sourceName = (full.slice(full.lastIndexOf('/') + 1)).split('.quotes.md').join('.md')
    const sourceFile = relPath.slice(0, relPath.lastIndexOf('/') + 1) + sourceName
    const text = await readFile(full, 'utf8')
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (line.startsWith('> ') && !line.startsWith('> —')) {
        quotes.push({ text: line.slice(2).trim(), sourceFile, quotesFile: relPath })
      }
    }
  }

  const quotesDir = join(dataDir, 'quotes')
  if (existsSync(quotesDir)) {
    const freeQuoteFiles = []
    await walkFiles(quotesDir, (name) => name.endsWith('.md'), freeQuoteFiles)
    for (const full of freeQuoteFiles) {
      const quotesFile = toPosix(full.slice(dataDir.length + 1))
      const text = await readFile(full, 'utf8')
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (line.startsWith('> ') && !line.startsWith('> —')) {
          quotes.push({ text: line.slice(2).trim(), sourceFile: '', quotesFile })
        }
      }
    }
  }
  return quotes
}

// ---------------------------------------------------------------------------
// INDEX.md
// ---------------------------------------------------------------------------

function buildMainIndexMarkdown(articles, quotes, nowText) {
  const channelStats = new Map() // channel -> { count, latest, tags: Set }
  for (const article of articles) {
    const channel = 'channel' in article ? asText(article.channel) : 'unknown'
    if (!channelStats.has(channel)) {
      channelStats.set(channel, { count: 0, latest: '', tags: new Set() })
    }
    const stats = channelStats.get(channel)
    stats.count += 1
    const date = 'date' in article ? asText(article.date) : ''
    if (date > stats.latest) stats.latest = date
    for (const tag of tagsOf(article)) stats.tags.add(tag)
  }

  const allTags = new Set()
  const allCategories = new Set()
  for (const article of articles) {
    for (const tag of tagsOf(article)) allTags.add(tag)
    const category = asText(article.topic_category)
    if (category) allCategories.add(category)
  }

  const recent = articles.slice(0, 30)

  const lines = [
    '# 知识星球知识库\n',
    `> 最后构建: ${nowText} | 总文章: ${articles.length} | 总金句: ${quotes.length}\n`,
    '## 最近更新\n',
    '| 日期 | 频道 | 标题 | 标签 | 类型 |',
    '|------|------|------|------|------|',
  ]
  for (const article of recent) {
    const title = asText(article.summary) || pyStem(asText(article._path))
    const tags = tagsOf(article)
    const tagsText = tags.slice(0, 3).join(', ') || '-'
    const link = `[${trunc(title, 30)}](${asText(article._path)})`
    lines.push(
      `| ${asText(article.date)} | ${asText(article.source)} | ${link} | ${tagsText} | ${asText(article.content_type)} |`,
    )
  }

  lines.push('\n## 频道概览\n')
  lines.push('| 频道 | 文章数 | 最近更新 | 主要标签 |')
  lines.push('|------|--------|---------|---------|')
  for (const channel of sortStrings(channelStats.keys())) {
    const stats = channelStats.get(channel)
    const tagsText = sortStrings(stats.tags).slice(0, 5).join(', ') || '-'
    lines.push(`| ${channel} | ${stats.count} | ${stats.latest} | ${tagsText} |`)
  }

  lines.push('\n## 可用标签\n')
  lines.push(allTags.size > 0 ? sortStrings(allTags).join(', ') : '暂无标签')

  lines.push('\n## 主题分类\n')
  if (allCategories.size > 0) {
    const categoryCounts = new Map()
    for (const article of articles) {
      const category = asText(article.topic_category)
      if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
    }
    // Python: sorted(items, key=lambda x: -x[1])，稳定排序 → 同数保持首次出现顺序
    const ordered = [...categoryCounts].sort((a, b) => b[1] - a[1])
    for (const [category, count] of ordered) lines.push(`- ${category} (${count}篇)`)
  } else {
    lines.push('暂无分类（需要 Agent 补充 enrichment）')
  }

  lines.push('\n## 查找指南\n')
  lines.push('- 按日期: `index/by-date/{year}/{month}.md`')
  lines.push('- 按标签: `index/by-tag/{tag}.md`')
  lines.push('- 按主题: `index/by-topic/{topic}.md`')
  lines.push('- 按频道: `index/by-channel/{channel}.md`')
  lines.push('- 金句索引: `index/quotes-index.md`')
  lines.push('- 全文搜索: `python scripts/search.py "关键词"`')

  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// by-date / by-tag / by-topic / by-channel / quotes-index
// ---------------------------------------------------------------------------

function buildDateIndexFiles(articles, warnings) {
  const byYearMonth = new Map()
  for (const article of articles) {
    const date = asText(article.date)
    if (date.length >= 7) {
      const yearMonth = date.slice(0, 7)
      if (!byYearMonth.has(yearMonth)) byYearMonth.set(yearMonth, [])
      byYearMonth.get(yearMonth).push(article)
    }
  }

  const files = []
  for (const yearMonth of sortStrings(byYearMonth.keys()).reverse()) {
    const parts = yearMonth.split('-')
    if (parts.length !== 2) {
      warnings.push(`日期 ${yearMonth} 不是 YYYY-MM 形态，已跳过该月索引`)
      continue
    }
    const [year, month] = parts
    const items = byYearMonth.get(yearMonth)
    const lines = [`# ${year}年${month}月\n`]
    lines.push(`> 共 ${items.length} 篇\n`)
    lines.push('| 日期 | 频道 | 标题 | 标签 |')
    lines.push('|------|------|------|------|')
    for (const article of items) {
      const title = asText(article.summary) || pyStem(asText(article._path))
      const tagsText = tagsOf(article).slice(0, 3).join(', ') || '-'
      lines.push(
        `| ${asText(article.date)} | ${asText(article.source)} | `
        + `[${trunc(title, 30)}](../../${asText(article._path)}) | ${tagsText} |`,
      )
    }
    files.push({ path: `index/by-date/${year}/${month}.md`, content: `${lines.join('\n')}\n` })
  }
  return files
}

function buildTagIndexFiles(articles) {
  const byTag = new Map()
  for (const article of articles) {
    for (const tag of tagsOf(article)) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(article)
    }
  }

  const files = []
  for (const tag of sortStrings(byTag.keys())) {
    const items = byTag.get(tag)
    const lines = [`# ${tag}\n`]
    lines.push(`> 共 ${items.length} 篇\n`)

    const channelCounts = new Map()
    for (const article of items) {
      const channel = asText(article.source)
      channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1)
    }
    lines.push('频道分布: ' + [...channelCounts].map(([channel, count]) => `${channel}(${count})`).join(' | '))
    lines.push('')

    lines.push('| 日期 | 频道 | 标题 | 关键词 |')
    lines.push('|------|------|------|--------|')
    for (const article of items.slice(0, MAX_LINES_PER_FILE)) {
      const title = asText(article.summary) || pyStem(asText(article._path))
      const keywords = Array.isArray(article.keywords) ? article.keywords.slice(0, 4).join(', ') : ''
      lines.push(
        `| ${asText(article.date)} | ${asText(article.source)} | `
        + `[${trunc(title, 30)}](../../${asText(article._path)}) | ${keywords || '-'} |`,
      )
    }
    if (items.length > MAX_LINES_PER_FILE) {
      lines.push(`\n> 仅显示前 ${MAX_LINES_PER_FILE} 条，共 ${items.length} 条`)
    }

    files.push({ path: `index/by-tag/${safeIndexName(tag)}.md`, content: `${lines.join('\n')}\n` })
  }
  return files
}

function buildTopicIndexFiles(articles) {
  const byTopic = new Map()
  for (const article of articles) {
    const category = asText(article.topic_category)
    if (category) {
      if (!byTopic.has(category)) byTopic.set(category, [])
      byTopic.get(category).push(article)
    }
  }

  const files = []
  for (const topic of sortStrings(byTopic.keys())) {
    const items = byTopic.get(topic)
    const lines = [`# ${topic}\n`]
    lines.push(`> 共 ${items.length} 篇\n`)
    lines.push('| 日期 | 频道 | 标题 | 关键词 |')
    lines.push('|------|------|------|--------|')
    for (const article of items.slice(0, MAX_LINES_PER_FILE)) {
      const title = asText(article.summary) || pyStem(asText(article._path))
      const keywords = Array.isArray(article.keywords) ? article.keywords.slice(0, 4).join(', ') : ''
      lines.push(
        `| ${asText(article.date)} | ${asText(article.source)} | `
        + `[${trunc(title, 30)}](../../${asText(article._path)}) | ${keywords || '-'} |`,
      )
    }
    // 注意：Python 的 by-topic 没有「仅显示前 N 条」提示（保持原样，未补 bug）
    files.push({ path: `index/by-topic/${safeIndexName(topic)}.md`, content: `${lines.join('\n')}\n` })
  }
  return files
}

function buildChannelIndexFiles(articles) {
  const byChannel = new Map()
  for (const article of articles) {
    const channel = 'channel' in article ? asText(article.channel) : 'unknown'
    if (!byChannel.has(channel)) byChannel.set(channel, [])
    byChannel.get(channel).push(article)
  }

  const files = []
  for (const channel of sortStrings(byChannel.keys())) {
    const items = byChannel.get(channel)
    const first = items[0]
    const titleSource = 'source' in first ? asText(first.source) : channel
    const lines = [`# ${titleSource}\n`]
    lines.push(`> 共 ${items.length} 篇\n`)
    lines.push('| 日期 | 标题 | 标签 | 类型 |')
    lines.push('|------|------|------|------|')
    for (const article of items.slice(0, MAX_LINES_PER_FILE)) {
      const title = asText(article.summary) || pyStem(asText(article._path))
      const tagsText = tagsOf(article).slice(0, 3).join(', ') || '-'
      lines.push(
        `| ${asText(article.date)} | `
        + `[${trunc(title, 30)}](../../${asText(article._path)}) | ${tagsText} | ${asText(article.content_type)} |`,
      )
    }
    if (items.length > MAX_LINES_PER_FILE) {
      lines.push(`\n> 仅显示前 ${MAX_LINES_PER_FILE} 条，共 ${items.length} 条`)
    }
    files.push({ path: `index/by-channel/${channel}.md`, content: `${lines.join('\n')}\n` })
  }
  return files
}

function buildQuotesIndexMarkdown(quotes) {
  let lines
  if (quotes.length === 0) {
    lines = ['# 金句索引\n', '> 暂无金句，需要 Agent 补充 enrichment\n']
  } else {
    lines = ['# 金句索引\n', `> 共 ${quotes.length} 条金句\n`]
    for (const quote of quotes.slice(0, MAX_QUOTES_IN_INDEX)) {
      lines.push(`> ${quote.text}`)
      if (quote.sourceFile) {
        lines.push(`> — [原文](${quote.sourceFile})\n`)
      } else {
        lines.push('')
      }
    }
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// index.json
// ---------------------------------------------------------------------------

function buildJsonIndex(articles, quotes) {
  const tagIndex = new Map()
  const topicIndex = new Map()

  const entries = articles.map((article) => {
    // Python 版这里是 int；用 rawId 写出精确数字字面量，避免 18 位 id 丢精度
    const id = rawId(asText(article.id))
    for (const tag of tagsOf(article)) {
      if (!tagIndex.has(tag)) tagIndex.set(tag, [])
      tagIndex.get(tag).push(id)
    }
    const category = asText(article.topic_category)
    if (category) {
      if (!topicIndex.has(category)) topicIndex.set(category, [])
      topicIndex.get(category).push(id)
    }
    const entry = {
      id,
      path: asText(article._path),
      channel: asText(article.channel),
      source: asText(article.source),
      author: asText(article.author),
      date: asText(article.date),
      type: asText(article.type),
      content_type: asText(article.content_type),
      is_digest: 'is_digest' in article ? article.is_digest : false,
      tags: tagsOf(article),
      topic_category: category,
      keywords: Array.isArray(article.keywords) ? article.keywords : [],
      summary: asText(article.summary),
      quotes_count: 'quotes_count' in article ? article.quotes_count : 0,
    }
    if ('_quotes_path' in article) entry.quotes_path = article._quotes_path
    return entry
  })

  const index = {
    total_articles: articles.length,
    total_quotes: quotes.length,
    articles: entries,
    tag_index: Object.fromEntries(tagIndex),
    topic_index: Object.fromEntries(topicIndex),
  }
  // Python json.dumps(..., ensure_ascii=False, indent=2) 与 JSON.stringify(x, null, 2)
  // 的分隔符/缩进/转义一致；rawId 的 JSON.rawJSON 会输出精确数字字面量。
  return JSON.stringify(index, null, 2)
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 构建全部索引产物（不写盘）。
 *
 * @param root 知识库数据目录（含 channels/、index/，可选 quotes/）。
 * @param options 可选项：
 *   - now：注入「最后构建」时间（Date 或 `YYYY-MM-DD HH:MM` 文本），便于 golden 比对。
 * @returns `{ files, stats }`，files 按 Python 写盘顺序排列。
 */
export async function buildIndexFiles(root, options = {}) {
  const dataDir = resolve(root)
  const paths = dataPaths(dataDir)
  const warnings = []

  const articles = await scanArticles(dataDir, warnings)
  const quotes = await scanQuotes(dataDir, paths.channels)
  const nowText = typeof options.now === 'string' ? options.now : formatNow(options.now)

  // 用 Map 聚合并保持顺序：同名 by-* 文件（如 tag 名清洗后撞名）以最后一次写入为准，
  // 与 Python 逐个 write_text 覆盖的最终结果一致。
  const files = new Map()
  files.set('INDEX.md', buildMainIndexMarkdown(articles, quotes, nowText))
  for (const file of buildDateIndexFiles(articles, warnings)) files.set(file.path, file.content)
  for (const file of buildTagIndexFiles(articles)) files.set(file.path, file.content)
  for (const file of buildTopicIndexFiles(articles)) files.set(file.path, file.content)
  for (const file of buildChannelIndexFiles(articles)) files.set(file.path, file.content)
  files.set(posixJoin('index', 'quotes-index.md'), buildQuotesIndexMarkdown(quotes))
  files.set(posixJoin('index', 'index.json'), buildJsonIndex(articles, quotes))

  return {
    files: [...files].map(([path, content]) => ({ path, content })),
    stats: {
      articles: articles.length,
      quotes: quotes.length,
      warnings,
    },
  }
}

/** POSIX 路径拼接（产物路径固定用 `/`，与平台无关）。 */
function posixJoin(...parts) {
  return parts.filter((part) => part.length > 0).join('/')
}
