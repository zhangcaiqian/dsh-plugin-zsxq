import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dataPaths, expandHome, readFrontmatter, resolveDataDir } from '../src/store.mjs'

test('readFrontmatter 解析 YAML 并分离正文', async () => {
  const markdown = '---\nid: "1"\ntags:\n  - 甲\nkeywords: []\n---\n\n正文\n'
  const { frontmatter, body, hasFrontmatter } = await readFrontmatter(markdown)
  assert.equal(hasFrontmatter, true)
  assert.equal(frontmatter.id, '1')
  assert.deepEqual(frontmatter.tags, ['甲'])
  assert.equal(body.trim(), '正文')
})

test('无 frontmatter 的 md 被标记为非文章', async () => {
  const { hasFrontmatter } = await readFrontmatter('# 手写笔记\n\n内容')
  assert.equal(hasFrontmatter, false)
})

test('dataPaths 给出固定结构', () => {
  const paths = dataPaths('/tmp/kb')
  assert.equal(paths.configFile, '/tmp/kb/config.json')
  assert.equal(paths.indexJson, '/tmp/kb/index/index.json')
})

test('ZSXQ_BASE_DIR 优先于默认目录', async () => {
  const previous = process.env.ZSXQ_BASE_DIR
  process.env.ZSXQ_BASE_DIR = '/tmp/custom-kb'
  try {
    assert.equal(await resolveDataDir(undefined, undefined, {}), '/tmp/custom-kb')
  } finally {
    if (previous === undefined) delete process.env.ZSXQ_BASE_DIR
    else process.env.ZSXQ_BASE_DIR = previous
  }
})

test('expandHome 展开 ~/', () => {
  assert.ok(!expandHome('~/kb').startsWith('~'))
})
