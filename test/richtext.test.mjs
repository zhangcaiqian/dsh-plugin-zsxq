import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractHashtags, parseRichText, safeFilename } from '../src/richtext.mjs'

test('hashtag / 加粗 / 链接 / @ 提及转 Markdown', () => {
  const input = 'a <e type="hashtag" hid="1" title="%23标签%23" /> '
    + '<e type="text_bold" title="加粗" /> '
    + '<e type="web" href="https%3A%2F%2Fexample.com" title="示例" /> '
    + '<e type="mention" uid="9" title="张三" />'
  assert.equal(parseRichText(input), 'a  #标签#  **加粗** [示例](https://example.com) @张三')
})

test('未知类型标记被丢弃，连续空行压缩', () => {
  assert.equal(parseRichText('x\n\n\n\n y <e type="unknown" />'), 'x\n\n y')
})

test('hashtag 去重并去掉首尾 #', () => {
  const text = '<e type="hashtag" hid="1" title="%23甲%23" /> <e type="hashtag" hid="1" title="%23甲%23" /> '
    + '<e type="hashtag" hid="2" title="%23乙%23" />'
  assert.deepEqual(extractHashtags(text), ['甲', '乙'])
})

test('safe_filename 清洗非法字符与长度', () => {
  assert.equal(safeFilename('  一篇/带:非法*字符?的标题  '), '一篇带非法字符的标题')
  assert.equal(safeFilename('a'.repeat(80)).length, 60)
  assert.equal(safeFilename(''), 'untitled')
})
