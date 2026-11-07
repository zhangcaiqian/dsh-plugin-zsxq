/**
 * topic → Markdown 渲染（与 Python 版 topic_to_markdown / _build_body 逐字节对齐）。
 *
 * 纯函数：不做 IO。附件抽取结果由调用方以 fileResults 传入：
 *   { [文件名]: { localPath, extractedText, markdownImages: string[], extractedImageCount: number } }
 */
import { extractHashtags, parseRichText, safeFilename } from './richtext.mjs'

/** '2026-04-11T14:29:50.800+0800' → '2026-04-11' */
export function formatDate(dateStr) {
  return String(dateStr ?? '').slice(0, 10)
}

/** '2026-04-11T14:29:50.800+0800' → '2026/04/11' */
export function formatDatePath(dateStr) {
  return formatDate(dateStr).replace(/-/g, '/')
}

/** 按标签推断分类（config.tag_to_category）。 */
export function inferCategory(tags, config) {
  const mapping = config?.tag_to_category ?? {}
  for (const tag of tags ?? []) {
    if (Object.hasOwn(mapping, tag)) return mapping[tag]
  }
  return undefined
}

/** 从 topic 生成文件名（不含扩展名）。 */
export function determineFilename(topic) {
  const title = typeof topic?.title === 'string' ? topic.title : ''
  if (title.length > 0) return safeFilename(title)

  const type = topic?.type ?? 'talk'
  let text = ''
  if (type === 'talk') text = topic?.talk?.text ?? ''
  else if (type === 'q&a') text = topic?.answer?.text ?? topic?.question?.text ?? ''
  else if (type === 'article') text = topic?.article?.title ?? topic?.article?.content ?? ''

  const parsed = parseRichText(text)
  return parsed.length > 0 ? safeFilename(parsed.slice(0, 80)) : `topic-${topic?.topic_id ?? 'unknown'}`
}

/** Markdown 正文（与 _build_body 对齐）。 */
export function buildBody({ topicType, rawText, images, files, voice, fileResults = {}, voicePath = '' }) {
  const parts = []

  if (topicType === 'q&a' && rawText.startsWith('Q_OWNER:')) {
    const lines = rawText.split('\n')
    const qOwner = (lines[0] ?? '').replace('Q_OWNER:', '').trim()
    const qText = (lines[1] ?? '').replace('Q:', '').trim()
    const aText = (lines[2] ?? '').replace('A:', '').trim()
    const qMd = parseRichText(qText)
    const aMd = parseRichText(aText)
    parts.push(qOwner.length > 0 ? `## 提问（${qOwner}）\n\n${qMd}` : `## 提问\n\n${qMd}`)
    parts.push(`## 回答\n\n${aMd}`)
  } else {
    const parsed = parseRichText(rawText)
    if (parsed.length > 0) parts.push(parsed)
  }

  if (images.length > 0) {
    const lines = []
    for (const image of images) {
      const url = image?.large?.url ?? image?.original?.url ?? ''
      if (url.length > 0) lines.push(`![图片](${url})`)
    }
    if (lines.length > 0) parts.push(lines.join('\n'))
  }

  for (const [name, info] of Object.entries(fileResults)) {
    const text = info?.extractedText ?? ''
    if (text.length > 0 && !text.startsWith('[')) parts.push(`---\n\n## 📄 ${name}\n\n${text}`)
    const markdownImages = info?.markdownImages ?? []
    if (markdownImages.length > 0) {
      const lines = markdownImages.map((image) => `![${name}](${image})`)
      parts.push(`---\n\n## 🖼️ ${name} 图片提取\n\n${lines.join('\n\n')}`)
    }
  }

  if (voice !== undefined && voice !== null) {
    const minutes = Math.floor((voice.duration ?? 0) / 60)
    const seconds = (voice.duration ?? 0) % 60
    let voiceInfo = `🎙️ **语音** (${minutes}分${seconds}秒)`
    voiceInfo += voicePath.length > 0 ? ` → \`${voicePath}\`` : ` (file_id: ${voice.file_id})`
    voiceInfo += '\n\n> ⚠️ 语音内容需要 ASR 转文字后补充到此处'
    parts.push(voiceInfo)
  }

  if (files.length > 0) {
    const lines = ['\n---\n\n**📎 附件列表**:']
    for (const file of files) {
      const name = file?.name ?? '未知文件'
      const sizeKb = Math.floor((file?.size ?? 0) / 1024)
      const info = fileResults[name]
      const local = info?.localPath ?? ''
      let statusParts = []
      if ((info?.extractedText ?? '').length > 0) statusParts.push('✅ 已提取正文')
      if ((info?.extractedImageCount ?? 0) > 0) statusParts.push(`🖼️ ${info.extractedImageCount} 张图`)
      if (/\.(mp3|m4a|wav)$/i.test(name)) statusParts = ['🎙️ 语音']
      const location = local.length > 0 ? ` → \`${local}\`` : ''
      lines.push(`- ${name} (${sizeKb}KB${location}) ${statusParts.join(' ')}`)
    }
    parts.push(lines.join('\n'))
  }

  return parts.join('\n\n')
}

/**
 * 把 topic 渲染成完整 Markdown（含 frontmatter）。
 * @param options `{ topic, channelKey, channelName, config, fileResults, voicePath, articleText }`
 * @returns Markdown 字符串（结尾带一个换行）。
 */
export function renderTopicMarkdown({
  topic,
  channelKey,
  channelName,
  config,
  fileResults = {},
  voicePath = '',
  articleText = '',
}) {
  const topicId = String(topic.topic_id)
  const topicType = topic.type ?? 'talk'
  const dt = formatDate(topic.create_time)
  const isDigest = topic.digested ?? false
  const likes = topic.likes_count ?? 0
  const comments = topic.comments_count ?? 0

  let rawText = ''
  let author = ''
  let images = []
  let files = []
  let voice

  if (topicType === 'talk') {
    const talk = topic.talk ?? {}
    rawText = articleText.length > 0 ? articleText : (talk.text ?? '')
    author = talk.owner?.name ?? ''
    images = talk.images ?? []
    files = talk.files ?? []
  } else if (topicType === 'q&a') {
    const q = topic.question ?? {}
    const a = topic.answer ?? {}
    const qText = q.text ?? ''
    const aText = a.text ?? ''
    author = a.owner?.name ?? q.owner?.name ?? ''
    const qOwner = q.owner?.name ?? ''
    rawText = `Q_OWNER:${qOwner}\nQ:${qText}\nA:${aText}`
    images = [...(q.images ?? []), ...(a.images ?? [])]
    files = [...(q.files ?? []), ...(a.files ?? [])]
  } else if (topicType === 'article') {
    const article = topic.article ?? {}
    rawText = article.content ?? article.text ?? ''
    author = article.owner?.name ?? ''
    images = article.images ?? []
  }

  if (topic.content_voice !== undefined && topic.content_voice !== null) {
    const cv = topic.content_voice
    voice = {
      file_id: String(cv.file_id ?? ''),
      name: cv.name ?? '',
      duration: cv.duration ?? 0,
      size: cv.size ?? 0,
    }
  }

  const tags = extractHashtags(rawText)
  const category = inferCategory(tags, config)

  const contentTypes = []
  if (rawText.trim().length > 0) contentTypes.push('text')
  if (voice !== undefined) contentTypes.push('voice')
  if (files.length > 0) contentTypes.push('file')
  if (images.length > 0) contentTypes.push('image')
  const contentType = contentTypes.join('+') || 'text'

  const bodyMd = buildBody({ topicType, rawText, images, files, voice, fileResults, voicePath })

  const fmTags = tags.length > 0 ? tags.map((tag) => `  - ${tag}`).join('\n') : ''
  let fmFiles = ''
  if (files.length > 0) {
    fmFiles = files
      .map((file) => {
        const name = file?.name ?? ''
        const local = fileResults[name]?.localPath ?? ''
        return (
          `  - file_id: "${file?.file_id ?? ''}"\n`
          + `    name: "${name}"\n`
          + `    size: ${file?.size ?? 0}`
          + (local.length > 0 ? `\n    local_path: "${local}"` : '')
        )
      })
      .join('\n')
  }

  let fmVoice = ''
  if (voice !== undefined) {
    fmVoice =
      `  file_id: "${voice.file_id}"\n`
      + `  name: "${voice.name}"\n`
      + `  duration: ${voice.duration}\n`
      + `  size: ${voice.size}`
    if (voicePath.length > 0) fmVoice += `\n  local_path: "${voicePath}"`
  }

  let frontmatter =
    `---\n`
    + `id: "${topicId}"\n`
    + `source: ${channelName}\n`
    + `channel: ${channelKey}\n`
    + `author: ${author}\n`
    + `date: ${dt}\n`
    + `type: ${topicType}\n`
    + `content_type: ${contentType}\n`
    + `is_digest: ${String(isDigest).toLowerCase()}\n`
    + `likes: ${likes}\n`
    + `comments: ${comments}`

  if (fmTags.length > 0) frontmatter += `\ntags:\n${fmTags}`
  frontmatter += category !== undefined ? `\ntopic_category: ${category}` : '\ntopic_category: '
  frontmatter += '\nkeywords: []'
  frontmatter += '\nsummary: ""'
  frontmatter += '\nquotes_count: 0'
  if (fmVoice.length > 0) frontmatter += `\nvoice:\n${fmVoice}`
  if (fmFiles.length > 0) frontmatter += `\nfiles:\n${fmFiles}`
  frontmatter += '\n---'

  return `${frontmatter}\n\n${bodyMd}\n`
}
