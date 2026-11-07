import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { extractDocx } from '../src/docx.mjs'
import { renderTopicMarkdown } from '../src/markdown.mjs'
import { parseJsonText } from '../src/json.mjs'

const config = { channels: { 'my-channel': { name: '我的频道' } }, tag_to_category: { 示例标签: '知识科普' } }

async function renderFixture(name) {
  const topic = parseJsonText(await readFile(new URL(`./fixtures/topics/${name}.json`, import.meta.url), 'utf8'))
  let fileResults = {}
  if (name === 'talk') {
    const docx = await extractDocx(new URL('./fixtures/note.docx', import.meta.url).pathname)
    fileResults = {
      'note.docx': {
        localPath: 'assets/my-channel/2026/11/07/note.docx',
        extractedText: docx.text,
        extractedImages: docx.images,
        extractedImageCount: docx.images.length,
        markdownImages: [],
      },
    }
  }
  return renderTopicMarkdown({
    topic,
    channelKey: 'my-channel',
    channelName: '我的频道',
    config,
    fileResults,
    voicePath: name === 'talk' ? 'assets/my-channel/2026/11/07/note.mp3' : '',
  })
}

test('talk 渲染与 Python 版输出逐字一致', async () => {
  const expected = await readFile(new URL('./fixtures/expected/talk.md', import.meta.url), 'utf8')
  assert.equal(await renderFixture('talk'), expected)
})

test('q&a 渲染与 Python 版输出逐字一致', async () => {
  const expected = await readFile(new URL('./fixtures/expected/qa.md', import.meta.url), 'utf8')
  assert.equal(await renderFixture('qa'), expected)
})
