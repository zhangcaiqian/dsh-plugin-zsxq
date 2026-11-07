/**
 * 同步编排：拉帖子 → 下载附件 → 抽取文本/图片 → 渲染 Markdown → 落盘。
 *
 * 与 Python 版 sync.py 对齐，差异仅在实现语言；写盘顺序、去重（.synced_ids）、
 * 附件图片命名（embedded-XX-YY）与文件名冲突规则保持一致。
 */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import { extractDocx } from './docx.mjs'
import { extractArticleText } from './html.mjs'
import { determineFilename, formatDatePath, renderTopicMarkdown } from './markdown.mjs'
import { extractPdf } from './pdf.mjs'
import {
  appendSyncedId,
  dataPaths,
  ensureDataLayout,
  loadSyncedIds,
  removeSyncedIds,
  toPosix,
  writeFileAtomic,
} from './store.mjs'

const AUDIO_PATTERN = /\.(mp3|m4a|wav)$/i

function messageOf(error) {
  return String(error?.message ?? error)
}

/** 取 topic 里的附件列表（talk / q&a 两套结构）。 */
function topicFiles(topic) {
  const type = topic.type ?? 'talk'
  if (type === 'talk') return topic.talk?.files ?? []
  if (type === 'q&a') return [...(topic.question?.files ?? []), ...(topic.answer?.files ?? [])]
  return []
}

/** 规范化语音元信息。 */
function topicVoice(topic) {
  if (topic.content_voice === undefined || topic.content_voice === null) return undefined
  const voice = topic.content_voice
  return {
    file_id: String(voice.file_id ?? ''),
    name: voice.name ?? '',
    duration: voice.duration ?? 0,
    size: voice.size ?? 0,
  }
}

/** 下载附件并抽取文本/图片。 */
async function downloadAndExtractFiles({ client, files, root, channelKey, datePath, log }) {
  const results = {}
  if (files.length === 0) return results
  const paths = dataPaths(root)
  const saveDir = join(paths.assets, channelKey, datePath)
  await mkdir(saveDir, { recursive: true })

  for (const file of files) {
    const fileId = String(file.file_id ?? '')
    const name = file.name ?? `file_${fileId}`
    const localPath = join(saveDir, name)

    if (existsSync(localPath)) {
      log(`    📎 已存在: ${name}`)
    } else {
      try {
        await client.downloadFile(fileId, localPath)
        log(`    📥 下载: ${name}`)
      } catch (error) {
        log(`    ❌ 下载失败 ${name}: ${messageOf(error)}`)
        results[name] = { localPath: '', extractedText: '', extractedImages: [] }
        continue
      }
    }

    const suffix = extname(localPath).toLowerCase()
    let extractedText = ''
    let extractedImages = []
    if (suffix === '.docx') {
      try {
        const docx = await extractDocx(localPath)
        extractedText = docx.text
        extractedImages = docx.images
      } catch (error) {
        extractedText = `[docx 提取失败: ${messageOf(error)}]`
      }
    } else if (suffix === '.pdf') {
      try {
        const pdf = await extractPdf(localPath)
        extractedText = pdf.text
        extractedImages = pdf.images
      } catch (error) {
        extractedText = `[PDF 提取失败: ${messageOf(error)}]`
      }
    }

    results[name] = {
      localPath: toPosix(relative(root, localPath)),
      extractedText,
      extractedImages,
    }
  }
  return results
}

/**
 * 把抽取出的图片落到 assets/<ch>/<date>/<stem>_images/，再复制到 md 同目录，
 * 命名为 embedded-{附件序}-{图序}.{ext}（与 Python 版一致）。
 */
async function prepareMarkdownImages({ fileResults, root, channelKey, datePath, markdownDir, log }) {
  const paths = dataPaths(root)
  const saveDir = join(paths.assets, channelKey, datePath)
  let attachmentIndex = 0

  for (const [name, info] of Object.entries(fileResults)) {
    attachmentIndex += 1
    const images = info.extractedImages ?? []
    info.markdownImages = []
    info.extractedImageCount = images.length
    if (images.length === 0) continue

    const stem = name.replace(/\.[^.]+$/, '')
    const imageDir = join(saveDir, `${stem}_images`)
    await mkdir(imageDir, { recursive: true })
    await mkdir(markdownDir, { recursive: true })

    for (const [index, image] of images.entries()) {
      const imagePath = join(imageDir, image.outputName)
      await writeFile(imagePath, image.data)
      const suffix = extname(image.outputName).toLowerCase() || '.png'
      const targetName = `embedded-${String(attachmentIndex).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}${suffix}`
      await copyFile(imagePath, join(markdownDir, targetName))
      info.markdownImages.push(targetName)
    }
    log(`    🖼️ ${name}: 提取 ${images.length} 张图`)
  }
}

/** 下载语音（不转写）。 */
async function downloadVoice({ client, voice, root, channelKey, datePath, log }) {
  if (voice === undefined) return ''
  const paths = dataPaths(root)
  const saveDir = join(paths.assets, channelKey, datePath)
  await mkdir(saveDir, { recursive: true })
  const name = voice.name.length > 0 ? voice.name : `voice_${voice.file_id}.mp3`
  const localPath = join(saveDir, name)
  if (existsSync(localPath)) {
    log(`    🔊 已存在: ${name}`)
  } else {
    try {
      await client.downloadFile(voice.file_id, localPath)
      log(`    🔊 下载: ${name}`)
    } catch (error) {
      log(`    ❌ 语音下载失败 ${name}: ${messageOf(error)}`)
      return ''
    }
  }
  return toPosix(relative(root, localPath))
}

/**
 * 保存单个 topic（已同步则跳过）。
 * @returns 相对数据目录的 md 路径，或 null（跳过）。
 */
export async function saveTopic({ client, topic, channelKey, channelName, config, root, syncedIds, log }) {
  const topicId = String(topic.topic_id)
  if (syncedIds.has(topicId)) return null

  const paths = dataPaths(root)
  const datePath = formatDatePath(topic.create_time)
  const filename = determineFilename(topic)
  const targetDir = join(paths.channels, channelKey, datePath)
  await mkdir(targetDir, { recursive: true })

  let filepath = join(targetDir, `${filename}.md`)
  let counter = 1
  while (existsSync(filepath)) {
    filepath = join(targetDir, `${filename}-${counter}.md`)
    counter += 1
  }

  const files = topicFiles(topic)
  const voice = topicVoice(topic)

  let articleText = ''
  const articleUrl = topic.talk?.article?.inline_article_url ?? topic.talk?.article?.article_url ?? ''
  if (typeof articleUrl === 'string' && articleUrl.length > 0) {
    const html = await client.fetchArticleHtml(articleUrl)
    articleText = extractArticleText(html)
    if (articleText.length === 0) log('    ⚠️ 文章全文抓取失败或为空')
  }

  const fileResults = await downloadAndExtractFiles({ client, files, root, channelKey, datePath, log })
  await prepareMarkdownImages({
    fileResults,
    root,
    channelKey,
    datePath,
    markdownDir: targetDir,
    log,
  })
  const voicePath = await downloadVoice({ client, voice, root, channelKey, datePath, log })

  const markdown = renderTopicMarkdown({
    topic,
    channelKey,
    channelName,
    config,
    fileResults,
    voicePath,
    articleText,
  })
  await writeFileAtomic(filepath, markdown)
  await appendSyncedId(root, topicId)
  syncedIds.add(topicId)

  const rawDir = join(paths.dataRaw, channelKey, datePath)
  await mkdir(rawDir, { recursive: true })
  await writeFile(join(rawDir, `${topicId}.json`), JSON.stringify(topic, null, 2), 'utf8')
  log(`    📄 ${filename}.md`)

  return toPosix(relative(root, filepath))
}

/** 按日期过滤 topics（YYYY-MM-DD）。 */
export function filterByDate(topics, targetDate) {
  return topics.filter((topic) => String(topic.create_time ?? '').slice(0, 10) === targetDate)
}

/** 反查 hashtag id（先菜单、再标签列表）。 */
async function resolveHashtagId(client, groupId, hashtag) {
  const menus = await client.getMenus(groupId)
  for (const menu of menus) {
    if (String(menu.title ?? '').replace(/#/g, '').trim() === hashtag && menu.hashtag !== undefined) {
      return String(menu.hashtag.hashtag_id)
    }
  }
  const hashtags = await client.getHashtags(groupId)
  for (const item of hashtags) {
    if (String(item.title ?? '').replace(/#/g, '').trim() === hashtag) return String(item.hashtag_id)
  }
  return undefined
}

/**
 * 同步单个频道。
 * @returns `{ written, fetched, added }`
 */
export async function syncChannel({ client, channelKey, channelConfig, config, root, scope, count = 10, hashtag, targetDate, log }) {
  const groupId = channelConfig.group_id
  const channelName = channelConfig.name
  const effectiveScope = scope ?? channelConfig.default_scope ?? 'digests'
  const dateHint = targetDate === undefined ? '' : `, date=${targetDate}`
  log(`\n📡 同步: ${channelName} (scope=${effectiveScope}, count=${count}${dateHint})`)

  let topics
  if (hashtag !== undefined) {
    const hashtagId = await resolveHashtagId(client, groupId, hashtag)
    if (hashtagId === undefined) {
      log(`  ⚠️ 未找到标签: #${hashtag}#`)
      return { written: [], fetched: 0, added: 0 }
    }
    topics = await client.getHashtagTopics(hashtagId, { count })
  } else {
    topics = await client.getTopics(groupId, { scope: effectiveScope, count })
  }

  if (targetDate !== undefined) {
    topics = filterByDate(topics, targetDate)
    if (topics.length === 0) {
      log(`  ℹ️ ${targetDate} 无新内容`)
      return { written: [], fetched: 0, added: 0 }
    }
  }

  const syncedIds = await loadSyncedIds(root)
  const written = []
  for (const topic of topics) {
    const path = await saveTopic({ client, topic, channelKey, channelName, config, root, syncedIds, log })
    if (path !== null) written.push(path)
  }
  log(`  ✅ 获取 ${topics.length} 条，新增 ${written.length} 条`)
  return { written, fetched: topics.length, added: written.length }
}

/** 扫描某频道某月已有 md 的 topic_id。 */
export async function collectTopicIdsChannelMonth(root, channelKey, yearMonth) {
  const [year, month] = yearMonth.split('-')
  const base = join(dataPaths(root).channels, channelKey, year, month)
  const ids = new Set()
  if (!existsSync(base)) return ids
  const { readdir } = await import('node:fs/promises')
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md') && !entry.name.endsWith('.quotes.md')) {
        const text = await readFile(full, 'utf8')
        const match = text.match(/^id:\s*"(\d+)"/m)
        if (match !== null) ids.add(match[1])
      }
    }
  }
  await walk(base)
  return ids
}

/** 删除某频道某月的 channels / data/raw / assets 子目录（破坏性，仅 refresh 用）。 */
export async function deleteChannelMonthDirs(root, channelKey, yearMonth, log) {
  const [year, month] = yearMonth.split('-')
  const paths = dataPaths(root)
  for (const dir of [
    join(paths.channels, channelKey, year, month),
    join(paths.dataRaw, channelKey, year, month),
    join(paths.assets, channelKey, year, month),
  ]) {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true })
      log(`  🗑️ 已删除: ${toPosix(relative(root, dir))}`)
    }
  }
}

/** 分页拉取某月全部帖子。 */
export async function fetchTopicsForMonth({ client, groupId, scope, yearMonth, log }) {
  const collected = []
  const monthStart = `${yearMonth}-01`
  let endTime
  while (true) {
    const topics = await client.getTopics(groupId, { scope, count: 10, endTime })
    if (topics.length === 0) break
    for (const topic of topics) {
      const created = String(topic.create_time ?? '').slice(0, 10)
      if (created.length >= 7 && created.slice(0, 7) === yearMonth) collected.push(topic)
    }
    const oldest = String(topics[topics.length - 1]?.create_time ?? '').slice(0, 10)
    if (oldest < monthStart) break
    endTime = topics[topics.length - 1].create_time
  }
  const seen = new Set()
  const unique = []
  for (const topic of collected) {
    const id = String(topic.topic_id ?? '')
    if (id.length > 0 && !seen.has(id)) {
      seen.add(id)
      unique.push(topic)
    }
  }
  unique.sort((a, b) => String(a.create_time ?? '').localeCompare(String(b.create_time ?? '')))
  log(`  📋 API 共 ${unique.length} 条属于 ${yearMonth}`)
  return unique
}

/** 整月同步（refresh 时先清本地该月数据）。 */
export async function syncChannelMonth({ client, channelKey, channelConfig, config, root, yearMonth, scope, refresh, log }) {
  const groupId = channelConfig.group_id
  const channelName = channelConfig.name
  const effectiveScope = scope ?? channelConfig.default_scope ?? 'digests'
  log(`\n📡 整月同步: ${channelName} (${yearMonth}, scope=${effectiveScope}, refresh=${refresh})`)

  if (refresh) {
    const ids = await collectTopicIdsChannelMonth(root, channelKey, yearMonth)
    if (ids.size > 0) {
      await removeSyncedIds(root, ids)
      log(`  🔄 已从 .synced_ids 移除 ${ids.size} 个 topic_id`)
    }
    await deleteChannelMonthDirs(root, channelKey, yearMonth, log)
  }

  const topics = await fetchTopicsForMonth({ client, groupId, scope: effectiveScope, yearMonth, log })
  const syncedIds = await loadSyncedIds(root)
  const written = []
  for (const topic of topics) {
    const path = await saveTopic({ client, topic, channelKey, channelName, config, root, syncedIds, log })
    if (path !== null) written.push(path)
  }
  log(`  ✅ 新增/写入 ${written.length} 个文件`)
  return { written, fetched: topics.length, added: written.length }
}

/** 确保目录骨架存在（工具入口调用一次）。 */
export async function prepareRoot(root) {
  await ensureDataLayout(root)
}
