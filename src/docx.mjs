/**
 * docx 文本/图片抽取的原型实现，目标是与 python-docx 的语义逐字一致。
 *
 * 对齐点（均取自 python-docx 源码）：
 *  - Document.paragraphs 只取 body 的直接 w:p 子节点（不含表格单元格、不含 w:ins/w:del 内的段落）
 *  - CT_P.text = 直接子节点 w:r + w:hyperlink 的文本拼接
 *  - CT_R.text = w:br | w:cr | w:noBreakHyphen | w:ptab | w:t | w:tab 的等价字符
 *  - w:br 仅 textWrapping（或缺省 type）→ "\n"，分页/分栏 → ""
 *  - 空段落（strip 后为空）被丢弃，段落之间用 "\n\n" 连接
 *  - 图片取 word/media/ 下全部文件，按名称排序，扩展名归一化
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

const IMAGE_SUFFIXES = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff'])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  ignoreDeclaration: true,
  processEntities: true,
})

function tagOf(node) {
  for (const key of Object.keys(node)) if (key !== ':@') return key
  return undefined
}

function kids(node) {
  const tag = tagOf(node)
  return tag === undefined ? [] : node[tag]
}

function textOfTextNode(node) {
  let out = ''
  for (const child of kids(node)) {
    if (child['#text'] !== undefined) out += String(child['#text'])
  }
  return out
}

function runText(runKids) {
  let out = ''
  for (const child of runKids) {
    const tag = tagOf(child)
    if (tag === 'w:t') out += textOfTextNode(child)
    else if (tag === 'w:tab' || tag === 'w:ptab') out += '\t'
    else if (tag === 'w:noBreakHyphen') out += '-'
    else if (tag === 'w:cr') out += '\n'
    else if (tag === 'w:br') {
      const type = (child[':@'] ?? {})['@_w:type']
      if (type === undefined || type === 'textWrapping') out += '\n'
    }
  }
  return out
}

function paragraphText(paragraphKids) {
  let out = ''
  for (const child of paragraphKids) {
    const tag = tagOf(child)
    if (tag === 'w:r') {
      out += runText(kids(child))
    } else if (tag === 'w:hyperlink') {
      for (const run of kids(child)) {
        if (tagOf(run) === 'w:r') out += runText(kids(run))
      }
    }
  }
  return out
}

/** 解析 docx，返回 { text, paragraphs, images } */
export async function extractDocx(filePath) {
  const buffer = await readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (documentXml === undefined) throw new Error('docx 缺少 word/document.xml')

  const doc = parser.parse(documentXml)
  const documentNode = doc.find((node) => tagOf(node) === 'w:document')
  const body = documentNode === undefined
    ? undefined
    : kids(documentNode).find((node) => tagOf(node) === 'w:body')

  const paragraphs = []
  for (const child of body === undefined ? [] : kids(body)) {
    if (tagOf(child) !== 'w:p') continue
    const text = paragraphText(kids(child))
    if (text.trim().length > 0) paragraphs.push(text)
  }

  const mediaNames = Object.keys(zip.files)
    .filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
    .sort()

  const images = []
  for (const [index, name] of mediaNames.entries()) {
    const raw = await zip.file(name).async('nodebuffer')
    const suffix = IMAGE_SUFFIXES.has(extname(name).toLowerCase())
      ? extname(name).toLowerCase()
      : '.png'
    images.push({
      source: name,
      outputName: `docx-image-${index + 1}${suffix}`,
      size: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
      data: raw,
    })
  }

  return { text: paragraphs.join('\n\n'), paragraphs, images }
}
