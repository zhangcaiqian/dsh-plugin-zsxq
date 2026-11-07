/**
 * 数据目录、配置、frontmatter 与同步状态的读写。
 *
 * 「数据目录」是知识库本体（channels/ assets/ index/ config.json），与插件安装目录无关。
 * 解析优先级：ZSXQ_BASE_DIR 环境变量 → 插件配置 dataDir → 当前会话 workspace（若已含
 * config.json 或 channels）→ $DSH_HOME/zsxq-kb。
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parse } from 'yaml'

import { parseJsonText } from './json.mjs'

/** 展开 `~/` 前缀。 */
export function expandHome(input) {
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

/** DSH home（桌面端/CLI 都会设置 DSH_HOME，缺失时回退 ~/.dsh）。 */
export function defaultDshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? resolve(expandHome(fromEnv.trim())) : join(homedir(), '.dsh')
}

/** 默认数据目录：$DSH_HOME/zsxq-kb。 */
export function defaultDataDir() {
  return join(defaultDshHome(), 'zsxq-kb')
}

/**
 * 解析知识库数据目录（不校验内容，只给出路径）。
 * @param ctx 插件上下文（可选，用于取 workspace）。
 * @param exec 工具执行上下文（可选）。
 * @param config 插件配置（可能含 dataDir）。
 * @returns 绝对路径。
 */
export async function resolveDataDir(ctx, exec, config) {
  const fromEnv = process.env.ZSXQ_BASE_DIR
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv.trim()))

  if (typeof config?.dataDir === 'string' && config.dataDir.trim().length > 0) {
    return resolve(expandHome(config.dataDir.trim()))
  }

  if (ctx?.workingDirectory !== undefined && exec?.agent !== undefined) {
    try {
      const workdir = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      if (typeof workdir === 'string' && workdir.length > 0) {
        if (existsSync(join(workdir, 'config.json')) || existsSync(join(workdir, 'channels'))) {
          return resolve(workdir)
        }
      }
    } catch {
      /* 拿不到 workspace 时走默认目录 */
    }
  }

  return defaultDataDir()
}

/** 数据目录内的固定路径。 */
export function dataPaths(root) {
  return {
    root,
    configFile: join(root, 'config.json'),
    syncedIds: join(root, '.synced_ids'),
    channels: join(root, 'channels'),
    assets: join(root, 'assets'),
    dataDir: join(root, 'data'),
    dataRaw: join(root, 'data', 'raw'),
    indexDir: join(root, 'index'),
    indexJson: join(root, 'index', 'index.json'),
    indexMarkdown: join(root, 'INDEX.md'),
  }
}

/** 创建数据目录骨架（幂等）。 */
export async function ensureDataLayout(root) {
  const paths = dataPaths(root)
  for (const dir of [paths.channels, paths.assets, paths.dataRaw, paths.indexDir]) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * 读取 config.json。
 * @param root 数据目录。
 * @returns 配置对象。
 * @throws `ZSXQ_CONFIG_MISSING` / `ZSXQ_CONFIG_INVALID`。
 */
export async function loadConfig(root) {
  const file = dataPaths(root).configFile
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    throw new Error(
      `ZSXQ_CONFIG_MISSING: 找不到 ${file}。请运行 zsxq_init（或手动创建）：`
      + `{"zsxq_cookie":"...","channels":{},"tag_to_category":{}}`,
    )
  }
  try {
    const parsed = parseJsonText(raw)
    if (parsed === null || typeof parsed !== 'object') throw new Error('根节点必须是对象')
    return parsed
  } catch (error) {
    throw new Error(`ZSXQ_CONFIG_INVALID: ${file} 不是合法 JSON（${error?.message ?? error}）`)
  }
}

/** 读取 JSON；文件缺失或解析失败返回 undefined（不抛错）。 */
export async function readJsonIfPresent(filePath) {
  try {
    return parseJsonText(await readFile(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解析 Markdown 的 YAML frontmatter。
 * @param markdown 文件全文。
 * @returns `{ frontmatter, body, hasFrontmatter }`；无 frontmatter 时 frontmatter 为 undefined。
 */
export async function readFrontmatter(markdown) {
  if (typeof markdown !== 'string' || !markdown.startsWith('---')) {
    return { frontmatter: undefined, body: markdown ?? '', hasFrontmatter: false }
  }
  const end = markdown.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: undefined, body: markdown, hasFrontmatter: false }
  try {
    const parsed = parse(markdown.slice(3, end))
    const frontmatter = parsed !== null && typeof parsed === 'object' ? parsed : undefined
    return { frontmatter, body: markdown.slice(end + 4).replace(/^\r?\n/, ''), hasFrontmatter: frontmatter !== undefined }
  } catch {
    return { frontmatter: undefined, body: markdown, hasFrontmatter: false }
  }
}

/**
 * 列出 channels/ 下的文章 md（递归，排除 .quotes.md），返回相对 root 的 POSIX 路径并排序。
 * @param root 数据目录。
 */
export async function listMarkdownFiles(root) {
  const channels = dataPaths(root).channels
  if (!existsSync(channels)) return []
  const files = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md') && !entry.name.endsWith('.quotes.md')) {
        files.push(toPosix(full.slice(root.length + 1)))
      }
    }
  }
  await walk(channels)
  files.sort()
  return files
}

/** Windows 反斜杠 → POSIX 分隔符。 */
export function toPosix(path) {
  return path.split('\\').join('/')
}

/** 读取 .synced_ids（缺失视为空集合）。 */
export async function loadSyncedIds(root) {
  try {
    const text = await readFile(dataPaths(root).syncedIds, 'utf8')
    return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))
  } catch {
    return new Set()
  }
}

/** 追加一个已同步 topic_id。 */
export async function appendSyncedId(root, topicId) {
  await appendFile(dataPaths(root).syncedIds, `${topicId}\n`, 'utf8')
}

/** 从 .synced_ids 中删除一批 id（整月刷新时用）。 */
export async function removeSyncedIds(root, ids) {
  if (ids.size === 0) return
  const file = dataPaths(root).syncedIds
  if (!existsSync(file)) return
  const text = await readFile(file, 'utf8')
  const kept = text.split('\n').filter((line) => {
    const id = line.trim()
    return id.length > 0 && !ids.has(id)
  })
  await writeFile(file, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8')
}

/**
 * 原子写文件（先写临时文件再 rename），避免中断留下半截 markdown。
 * @param filePath 目标路径。
 * @param content 文本内容。
 */
export async function writeFileAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, content, 'utf8')
  await rename(temp, filePath)
}
