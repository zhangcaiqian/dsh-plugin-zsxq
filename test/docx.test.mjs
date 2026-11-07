import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractDocx } from '../src/docx.mjs'

const FIXTURE = new URL('./fixtures/sample.docx', import.meta.url)

test('docx 段落文本：空段落丢弃、段落间两个换行', async () => {
  const { text } = await extractDocx(FIXTURE.pathname)
  assert.equal(
    text,
    '第一段：普通文本。\n\nSecond paragraph with ASCII.\n\n带 空格 与标点：ok\n\n图片之后的一段。',
  )
})

test('docx 内嵌图片：从 word/media 抽取并按序命名', async () => {
  const { images } = await extractDocx(FIXTURE.pathname)
  assert.equal(images.length, 1)
  assert.equal(images[0].outputName, 'docx-image-1.png')
  assert.ok(images[0].size > 0)
})
