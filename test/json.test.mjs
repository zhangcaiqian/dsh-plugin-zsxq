import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseJsonText, rawId } from '../src/json.mjs'

test('大整数 id 解析为字符串且不丢精度', () => {
  const payload = '{"topic_id":55522284425488584,"likes":42}'
  const parsed = parseJsonText(payload)
  assert.equal(parsed.topic_id, '55522284425488584')
  assert.equal(typeof parsed.topic_id, 'string')
  assert.equal(parsed.likes, 42)
  assert.equal(typeof parsed.likes, 'number')
})

test('小整数保持 number（与 Python 行为一致）', () => {
  const parsed = parseJsonText('{"size":1048576}')
  assert.equal(parsed.size, 1048576)
})

test('rawId 输出精确数字字面量', () => {
  const text = JSON.stringify({ id: rawId('55522284425488584') })
  assert.equal(text, '{"id":55522284425488584}')
})
