import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractPdfImages, extractPdfText } from '../src/pdf.mjs'

const FIXTURE = new URL('./fixtures/sample.pdf', import.meta.url)

test('PDF 中文文本抽取（依赖包内 CMap）', async () => {
  const { text, pages } = await extractPdfText(FIXTURE.pathname)
  assert.equal(pages, 1)
  assert.equal(text, '第一行中文测试\nSecond line in English\n第三行：混排 ABC 123')
})

test('无图 PDF 返回空图片列表（不抛错）', async () => {
  const { images } = await extractPdfImages(FIXTURE.pathname)
  assert.deepEqual(images, [])
})
