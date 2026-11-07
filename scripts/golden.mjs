/**
 * 开发用：把 data/raw 里的原始 topic 用 JS 渲染器重新渲染，并与 Python 参考输出逐字比对。
 *
 * 用法:
 *   # 1) 生成 Python 参考（需要本地有 Python 版 skill）
 *   ZSXQ_PY_SCRIPTS=/path/to/skills/zsxq-knowledge/scripts \
 *     python3 scripts/py-render.py /path/to/knowledge-base > /tmp/py-render.json
 *   # 2) 比对
 *   ZSXQ_BASE_DIR=/path/to/knowledge-base node scripts/golden.mjs --reference /tmp/py-render.json
 *
 * 这是迁移/回归验证脚本，不参与插件运行。
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

import { extractDocx } from '../src/docx.mjs'
import { parseJsonText } from '../src/json.mjs'
import { formatDatePath, renderTopicMarkdown } from '../src/markdown.mjs'
import { extractPdf } from '../src/pdf.mjs'
import { dataPaths, loadConfig, toPosix } from '../src/store.mjs'

const args = process.argv.slice(2)
const referenceIndex = args.indexOf('--reference')
const referenceFile = referenceIndex >= 0 ? args[referenceIndex + 1] : undefined
const root = process.env.ZSXQ_BASE_DIR ?? args.find((arg) => !arg.startsWith('--') && arg !== referenceFile)
if (typeof root !== 'string' || root.length === 0) {
  console.error('用法：ZSXQ_BASE_DIR=/path/to/kb node scripts/golden.mjs [--reference /tmp/py-render.json]')
  process.exit(2)
}

const paths = dataPaths(root)
const config = await loadConfig(root)
const reference = referenceFile === undefined
  ? undefined
  : parseJsonText(await readFile(referenceFile, 'utf8'))

/** 用本地已下载附件重建 fileResults（与 py-render.py 的输入一致）。 */
async function rebuildFileResults(topic, channelKey) {
  const type = topic.type ?? 'talk'
  let files = []
  if (type === 'talk') files = topic.talk?.files ?? []
  else if (type === 'q&a') files = [...(topic.question?.files ?? []), ...(topic.answer?.files ?? [])]

  const datePath = formatDatePath(topic.create_time)
  const results = {}
  for (const [index, file] of files.entries()) {
    const name = file?.name ?? ''
    const localPath = join(paths.assets, channelKey, datePath, name)
    let text = ''
    let images = []
    try {
      const suffix = extname(name).toLowerCase()
      if (suffix === '.docx') {
        const docx = await extractDocx(localPath)
        text = docx.text
        images = docx.images
      } else if (suffix === '.pdf') {
        const pdf = await extractPdf(localPath)
        text = pdf.text
        images = pdf.images
      }
    } catch (error) {
      text = `[${extname(name).slice(1)} 提取失败: ${error.message}]`
      images = []
    }
    results[name] = {
      localPath: toPosix(join('assets', channelKey, datePath, name)),
      extractedText: text,
      extractedImages: images,
      extractedImageCount: images.length,
      markdownImages: images.map(
        (image, i) => `embedded-${String(index + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}${extname(image.outputName).toLowerCase() || '.png'}`,
      ),
    }
  }
  return results
}

const rawFiles = []
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.name.endsWith('.json')) rawFiles.push(full)
  }
}
await walk(paths.dataRaw)

let rendered = 0
let same = 0
const diffs = []
for (const rawFile of rawFiles.sort()) {
  const topic = parseJsonText(await readFile(rawFile, 'utf8'))
  const topicId = String(topic.topic_id)
  const channelKey = rawFile.split('/data/raw/')[1].split('/')[0]
  const channelName = config.channels?.[channelKey]?.name ?? channelKey
  const datePath = formatDatePath(topic.create_time)
  const fileResults = await rebuildFileResults(topic, channelKey)
  const voice = topic.content_voice
  let voicePath = ''
  if (voice !== undefined) {
    const candidate = join(paths.assets, channelKey, datePath, voice.name)
    if (existsSync(candidate)) voicePath = toPosix(join('assets', channelKey, datePath, voice.name))
  }
  const markdown = renderTopicMarkdown({
    topic, channelKey, channelName, config, fileResults, voicePath, articleText: '',
  })
  rendered += 1
  if (reference === undefined) continue
  const expected = reference[topicId]
  if (markdown === expected) same += 1
  else if (diffs.length < 5) {
    const a = markdown
    const b = expected ?? ''
    let i = 0
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1
    diffs.push({ id: topicId, at: i, js: JSON.stringify(a.slice(Math.max(0, i - 50), i + 80)), py: JSON.stringify(b.slice(Math.max(0, i - 50), i + 80)) })
  }
}

console.log(`渲染完成: ${rendered} 篇`)
if (reference !== undefined) {
  console.log(`与 Python 参考逐字一致: ${same}/${rendered}`)
  for (const diff of diffs) console.log(JSON.stringify(diff))
  process.exit(same === rendered ? 0 : 1)
}
