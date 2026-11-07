import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeGroup } from '../src/api.mjs'

test('normalizeGroup 兼容扁平对象（现行 API）', () => {
  assert.deepEqual(normalizeGroup({ group_id: 123, name: '我的星球' }), { id: '123', name: '我的星球' })
})

test('normalizeGroup 兼容包裹一层 group 的响应', () => {
  assert.deepEqual(normalizeGroup({ group: { group_id: '456', name: '老式响应' } }), { id: '456', name: '老式响应' })
})

test('normalizeGroup 对缺失字段返回空字符串', () => {
  assert.deepEqual(normalizeGroup({}), { id: '', name: '' })
  assert.deepEqual(normalizeGroup(undefined), { id: '', name: '' })
})
