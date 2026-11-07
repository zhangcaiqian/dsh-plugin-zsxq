import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractArticleText, extractByRegex, normalizeText } from '../src/html.mjs'

test('.ql-editor 正文抽取：块级元素换行、列表加 -', () => {
  const html = '<div class="ql-editor"><p>第一段</p><p>Second <b>bold</b></p>'
    + '<ul><li>项目一</li><li>项目二</li></ul><p>尾段<br>换行</p></div>'
  assert.equal(extractArticleText(html), '第一段\n\nSecond bold\n\n- 项目一\n\n- 项目二\n\n尾段\n换行')
})

test('无 .ql-editor/.content 时返回空', () => {
  assert.equal(extractArticleText('<html><body><div class="other">x</div></body></html>'), '')
})

test('正则兜底与空白归一', () => {
  const html = '<div class="ql-editor"><p>甲</p><p>乙</p></div>'
  assert.equal(extractByRegex(html), '甲\n\n乙')
  assert.equal(normalizeText('a\r\n\r\n\r\n\u00a0 b  '), 'a\n\n  b')
})
