/**
 * 知识星球富文本标记 → Markdown（与 utils.py 的 parse_rich_text 对齐）。
 *
 * 除了 parse_rich_text，这里还移植了 extract_hashtags / safe_filename，
 * 因为同步链路都会用到，一起做等价性验证。
 */

function safeUnquote(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    // Python 的 unquote 对非法转义更宽容：逐段解码，失败则保留原样
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURIComponent(match)
      } catch {
        return match
      }
    })
  }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`))
  return match === null ? undefined : match[1]
}

export function parseRichText(text) {
  if (!text) return ''
  const replaced = text.replace(/<e\s[^>]*\/>/g, (tag) => {
    const type = attr(tag, 'type')
    if (type === undefined) return ''
    if (type === 'hashtag') {
      const title = attr(tag, 'title')
      return title === undefined ? '' : ` ${safeUnquote(title)} `
    }
    if (type === 'text_bold') {
      const title = attr(tag, 'title')
      return title === undefined ? '' : `**${safeUnquote(title)}**`
    }
    if (type === 'web') {
      const href = attr(tag, 'href')
      if (href === undefined) return ''
      const url = safeUnquote(href)
      const title = attr(tag, 'title')
      const label = title === undefined ? url : safeUnquote(title)
      return `[${label}](${url})`
    }
    if (type === 'mention') {
      const name = attr(tag, 'title')
      return name === undefined ? '' : `@${safeUnquote(name)}`
    }
    return ''
  })
  return replaced.replace(/\n{3,}/g, '\n\n').trim()
}

export function extractHashtags(text) {
  if (!text) return []
  const tags = []
  for (const match of text.matchAll(/<e\s[^>]*type="hashtag"[^>]*title="([^"]*)"[^>]*\/>/g)) {
    const decoded = safeUnquote(match[1]).replace(/^#+|#+$/g, '').trim()
    if (decoded) tags.push(decoded)
  }
  return [...new Set(tags)]
}

export function safeFilename(text, maxLength = 60) {
  if (!text) return 'untitled'
  let name = text.trim()
  name = name.replace(/<e\s[^>]*\/>/g, '')
  name = name.replace(/[\\/:*?"<>|]/g, '')
  name = name.replace(/[\s\n\r]+/g, '-')
  name = name.replace(/[#@[\]()（）【】]/g, '')
  name = name.replace(/^[-. ]+|[-. ]+$/g, '')
  if (name.length > maxLength) name = name.slice(0, maxLength).replace(/[-. ]+$/g, '')
  return name || 'untitled'
}
