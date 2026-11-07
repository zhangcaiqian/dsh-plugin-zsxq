/**
 * PDF 文本与图片抽取（unpdf / pdf.js，纯 JS）。
 *
 * 中文 PDF 必须提供 CMap：这里使用包内 `assets/pdf/cmaps`（来自 pdf.js，Apache-2.0），
 * 传**本地路径字符串**即可（file:// URL 会加载失败）。不需要 `@napi-rs/canvas`。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { extractImages, extractText, getDocumentProxy } from 'unpdf'

function dirUrl(relative) {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  return path.endsWith('/') ? path : `${path}/`
}

const DOCUMENT_OPTIONS = {
  cMapUrl: dirUrl('../assets/pdf/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: dirUrl('../assets/pdf/standard_fonts/'),
}

async function open(buffer) {
  return await getDocumentProxy(new Uint8Array(buffer), DOCUMENT_OPTIONS)
}

/**
 * 抽取 PDF 全文本（每页 trim 后去掉空页，页间 `\n\n`）。
 * @param filePath PDF 路径。
 * @returns `{ text, pages }`。
 */
export async function extractPdfText(filePath) {
  const pdf = await open(await readFile(filePath))
  const result = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(result.text) ? result.text : [result.text]
  const cleaned = pages.map((page) => String(page ?? '').trim()).filter((page) => page.length > 0)
  return { text: cleaned.join('\n\n'), pages: result.totalPages ?? pages.length }
}

/**
 * 抽取 PDF 页面图片，统一转 PNG（免 canvas）。
 * @param filePath PDF 路径。
 * @returns `{ images: [{ outputName, data, page, width, height }] }`
 *   outputName 命名与 Python 版一致：`pdf-page-{页}-image-{全局序号}.png`。
 */
export async function extractPdfImages(filePath) {
  const pdf = await open(await readFile(filePath))
  const images = []
  let counter = 1
  for (let page = 1; page <= pdf.numPages; page += 1) {
    const pageImages = await extractImages(pdf, page, { format: 'png' })
    for (const image of pageImages) {
      images.push({
        outputName: `pdf-page-${page}-image-${counter}.png`,
        data: Buffer.from(image.data),
        page,
        width: image.width,
        height: image.height,
      })
      counter += 1
    }
  }
  return { images }
}

/** 同时抽取文本与图片。 */
export async function extractPdf(filePath) {
  const [{ text, pages }, { images }] = await Promise.all([
    extractPdfText(filePath),
    extractPdfImages(filePath),
  ])
  return { text, pages, images }
}
