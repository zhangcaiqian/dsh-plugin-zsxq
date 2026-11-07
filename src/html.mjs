/**
 * 「文章贴」HTML → 纯文本。
 *
 * 对齐 Python 版 extract_article_text_from_html：
 * 优先取 `.ql-editor`（其次 `.content`）的可见文本，块级元素之间保留换行，
 * 压缩三个以上连续换行为两个；解析失败时退回正则链。
 */
import * as cheerio from 'cheerio'

const BLOCK_TAGS = ['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'ul', 'ol', 'table', 'tr']

/** 统一空白：\r\n、不换行空格、连续空行。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** 纯正则兜底（对应 Python 里 bs4 不可用时的分支）。 */
export function extractByRegex(htmlText) {
  const match = String(htmlText ?? '').match(
    /<(?:div|article)[^>]+class="[^"]*(?:ql-editor|content)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|article)>/i,
  )
  if (match === null) return ''
  let content = match[1]
  content = content.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  content = content.replace(/<br\s*\/?>/gi, '\n')
  content = content.replace(/<\/p\s*>/gi, '\n\n')
  content = content.replace(/<p[^>]*>/gi, '')
  content = content.replace(/<\/div\s*>/gi, '\n\n')
  content = content.replace(/<div[^>]*>/gi, '')
  content = content.replace(/<\/h[1-6]\s*>/gi, '\n\n')
  content = content.replace(/<h[1-6][^>]*>/gi, '')
  content = content.replace(/<li[^>]*>/gi, '- ')
  content = content.replace(/<\/li\s*>/gi, '\n')
  content = content.replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
  content = content.replace(/<\/?(blockquote|strong|b|em|span|section)[^>]*>/gi, '')
  content = content.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
  content = content.replace(/<[^>]+>/g, '')
  content = content
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  return normalizeText(content)
}

/**
 * 从文章贴 HTML 提取正文文本。
 * @param htmlText 原始 HTML。
 * @returns 规整后的纯文本（可能为空字符串）。
 */
export function extractArticleText(htmlText) {
  if (typeof htmlText !== 'string' || htmlText.trim().length === 0) return ''
  let $ 
  try {
    $ = cheerio.load(htmlText)
  } catch {
    return extractByRegex(htmlText)
  }
  const candidate = $('.ql-editor').first().length > 0 ? $('.ql-editor').first() : $('.content').first()
  if (candidate.length === 0) return extractByRegex(htmlText)

  const clone = candidate.clone()
  clone.find('br').replaceWith('\n')
  for (const tag of BLOCK_TAGS) {
    clone.find(tag).each((_, element) => {
      $(element).append('\n\n')
    })
  }
  clone.find('li').each((_, element) => {
    $(element).prepend('- ')
  })
  clone.find('a').each((_, element) => {
    const href = $(element).attr('href')
    if (href !== undefined && href.length > 0) $(element).append(` (${href})`)
  })
  return normalizeText(clone.text())
}
