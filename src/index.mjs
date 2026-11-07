/**
 * 知识星球知识库插件（DSH host 侧）。
 *
 * 7 个工具：初始化 / 频道清单 / 状态 / 检索 / 同步 / 重建索引 / 自检。
 * 同步、抽附件、建索引、检索全部为纯 JS 实现（无 Python 依赖）。
 *
 * 与 skill 的分工：插件只做「执行」，分类/摘要/金句等语义工作仍由
 * dsh-skill-zsxq（或项目内同名 skill）指导模型完成。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { ZsxqClient, ZsxqError } from './api.mjs'
import { buildIndexFiles } from './index-build.mjs'
import { searchIndex } from './search.mjs'
import {
  dataPaths,
  ensureDataLayout,
  loadConfig,
  loadSyncedIds,
  readFrontmatter,
  readJsonIfPresent,
  resolveDataDir,
  writeFileAtomic,
} from './store.mjs'
import { prepareRoot, syncChannel, syncChannelMonth } from './sync.mjs'

/** Cordis 插件名。 */
export const name = 'zsxq-tools'

/** 依赖的宿主服务。 */
export const inject = ['tools', 'workingDirectory']

/** 可配置项；`.volatile()` 的字段会出现在「设置 → 插件」表单里。 */
export const Config = z.object({
  dataDir: z.string().default('').volatile()
    .description('知识库数据目录（存放 config.json / channels / index）；留空则用 $DSH_HOME/zsxq-kb'),
  requestIntervalMs: z.number().default(1500)
    .description('请求间隔（毫秒），避免触发知识星球限流'),
  syncTimeoutMs: z.number().default(15 * 60 * 1000)
    .description('单个频道同步超时（毫秒）'),
  indexTimeoutMs: z.number().default(120 * 1000)
    .description('索引重建超时（毫秒）'),
})

const SYNC_MODES = ['today', 'date', 'month', 'count', 'hashtag']
const SCOPES = ['digests', 'all', 'by_owner', 'questions', 'with_files', 'with_images']
const MAX_COUNT = 30
const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

function normalizeConfig(config) {
  const source = config ?? {}
  return {
    dataDir: typeof source.dataDir === 'string' ? source.dataDir : '',
    requestIntervalMs: Number.isFinite(source.requestIntervalMs) ? source.requestIntervalMs : 1500,
    syncTimeoutMs: Number.isFinite(source.syncTimeoutMs) ? source.syncTimeoutMs : 15 * 60 * 1000,
    indexTimeoutMs: Number.isFinite(source.indexTimeoutMs) ? source.indexTimeoutMs : 120 * 1000,
  }
}

/** 本机时区的 YYYY-MM-DD（与 Python date.today() 对齐，不能用 UTC）。 */
function localDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function messageOf(error) {
  return String(error?.message ?? error)
}

function tail(text, max = 4000) {
  const value = String(text ?? '')
  return value.length <= max ? value : `…（前 ${value.length - max} 字符已截断）\n${value.slice(-max)}`
}

/** 组合 exec 取消信号与超时；返回 signal 与「是否超时」。 */
function deadline(execSignal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const signal = execSignal === undefined ? controller.signal : AbortSignal.any([execSignal, controller.signal])
  return {
    signal,
    timedOut: () => controller.signal.aborted,
    cancel: () => clearTimeout(timer),
  }
}

/** 创建 API 客户端（cookie 缺失时给出可执行提示）。 */
async function createClient(root, config, signal) {
  const loaded = await loadConfig(root)
  const cookie = typeof loaded.zsxq_cookie === 'string' ? loaded.zsxq_cookie : ''
  if (cookie.trim().length === 0) {
    throw new Error(
      'ZSXQ_CONFIG_MISSING: config.json 里没有 zsxq_cookie。请从浏览器 '
      + 'wx.zsxq.com 复制 Cookie 后填入。',
    )
  }
  return {
    client: new ZsxqClient(cookie, { signal, requestIntervalMs: config.requestIntervalMs }),
    loaded,
  }
}

/** 统计 channels/ 下的文章与金句数量，以及无 frontmatter 的手写稿。 */
async function collectInventory(root) {
  const channels = dataPaths(root).channels
  const inventory = { articles: 0, quotes: 0, nonArticle: 0, latestDate: null, articlePaths: [] }
  if (!existsSync(channels)) return inventory
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      if (entry.name.endsWith('.quotes.md')) {
        inventory.quotes += 1
        continue
      }
      const text = await readFile(full, 'utf8')
      const { hasFrontmatter } = await readFrontmatter(text)
      if (!hasFrontmatter) {
        inventory.nonArticle += 1
        continue
      }
      inventory.articles += 1
      const relative = full.slice(root.length + 1).split('\\').join('/')
      inventory.articlePaths.push(relative)
      const match = full.match(/(\d{4})\/(\d{2})\/(\d{2})\//)
      if (match !== null) {
        const date = `${match[1]}-${match[2]}-${match[3]}`
        if (inventory.latestDate === null || date > inventory.latestDate) inventory.latestDate = date
      }
    }
  }
  await walk(channels)
  return inventory
}

/** 统计 assets/ 文件数（不统计体积，避免大目录全量 stat）。 */
async function countAssets(root) {
  const assets = dataPaths(root).assets
  if (!existsSync(assets)) return 0
  try {
    const entries = await readdir(assets, { recursive: true, withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).length
  } catch {
    return 0
  }
}

function renderResult(value) {
  return value
}

/**
 * 注册全部工具。
 * @param ctx 宿主上下文。
 * @param rawConfig 插件配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  ctx.logger?.info(`zsxq-tools: 已挂载，dataDir=${config.dataDir.length > 0 ? config.dataDir : '(默认 $DSH_HOME/zsxq-kb)'}`)

  ctx.tools.register(defineTool({
    name: 'zsxq_init',
    description:
      '初始化知识星球知识库数据目录：创建 channels/ assets/ data/ index/ 与 config.json 模板。'
      + '第一次使用、或换了新机器时先调用它。返回数据目录路径与下一步（填 Cookie、加频道）。',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      await ensureDataLayout(root)
      const paths = dataPaths(root)
      let createdConfig = false
      if (!existsSync(paths.configFile)) {
        await writeFile(
          paths.configFile,
          JSON.stringify({
            zsxq_cookie: 'zsxq_access_token=YOUR_TOKEN_HERE; abtest_env=product',
            channels: {},
            tag_to_category: {},
          }, null, 2) + '\n',
          'utf8',
        )
        createdConfig = true
      }
      return {
        dataDir: root,
        createdConfig,
        nextSteps: [
          `1) 编辑 ${paths.configFile}，把 zsxq_cookie 换成从 wx.zsxq.com 复制的完整 Cookie；`,
          '2) 运行 zsxq_doctor，它会列出你加入的星球并给出可粘贴的 channels 配置；',
          '3) 运行 zsxq_sync（mode=today）同步今天的帖子。',
        ],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_list_channels',
    description:
      '列出知识库当前配置的知识星球频道（key、中文名、group_id、默认 scope）。'
      + '在调用 zsxq_sync 前用它确认频道 key；不发起网络请求。',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      const loaded = await loadConfig(root)
      const channels = Object.entries(loaded.channels ?? {}).map(([key, value]) => ({
        key,
        name: value?.name ?? key,
        groupId: value?.group_id === undefined ? null : String(value.group_id),
        defaultScope: value?.default_scope ?? null,
      }))
      return { dataDir: root, configFound: true, channels }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_status',
    description:
      '查看知识库状态：各频道文章/金句文件数、索引是否落后、同步状态、config.json 就绪度。'
      + '纯本地读取，毫秒级；回答「库里有什么 / 索引过期没 / 同步到哪了」时优先用它。',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      const paths = dataPaths(root)
      const inventory = await collectInventory(root)
      const index = await readJsonIfPresent(paths.indexJson)
      const indexPresent = index !== undefined
      const indexed = typeof index?.total_articles === 'number' ? index.total_articles : null
      const indexPaths = new Set(
        Array.isArray(index?.articles) ? index.articles.map((item) => String(item?.path ?? '')) : [],
      )
      const missingFromIndex = inventory.articlePaths.filter((path) => !indexPaths.has(path)).slice(0, 20)
      const missingFromDisk = [...indexPaths].filter((path) => !inventory.articlePaths.includes(path)).slice(0, 20)
      const stale = indexPresent && (missingFromIndex.length > 0 || missingFromDisk.length > 0)

      let syncedIds = 0
      let syncedUpdatedAt = null
      if (existsSync(paths.syncedIds)) {
        const text = await readFile(paths.syncedIds, 'utf8')
        syncedIds = text.split('\n').filter((line) => line.trim().length > 0).length
        syncedUpdatedAt = (await stat(paths.syncedIds)).mtime.toISOString()
      }

      const configExists = existsSync(paths.configFile)
      const loaded = configExists ? await loadConfig(root) : undefined
      const hasCookie = typeof loaded?.zsxq_cookie === 'string' && loaded.zsxq_cookie.trim().length > 0

      const warnings = []
      if (!configExists) warnings.push('config.json 不存在：先调用 zsxq_init')
      else if (!hasCookie) warnings.push('config.json 缺少 zsxq_cookie')
      if (!indexPresent) warnings.push('索引不存在：调用 zsxq_rebuild_index')
      else if (stale) warnings.push('索引与磁盘不一致：调用 zsxq_rebuild_index')
      if (inventory.nonArticle > 0) warnings.push(`channels/ 下有 ${inventory.nonArticle} 个无 frontmatter 的手写 md（不计入索引）`)

      return {
        dataDir: root,
        configured: configExists,
        hasCookie,
        articles: {
          files: inventory.articles,
          indexed,
          stale,
          latestDate: inventory.latestDate,
          missingFromIndex,
          missingFromDisk,
        },
        quotes: { files: inventory.quotes, indexed: index?.total_quotes ?? null },
        nonArticleDocs: inventory.nonArticle,
        assets: { files: await countAssets(root) },
        syncState: { syncedIds, updatedAt: syncedUpdatedAt },
        indexPresent,
        warnings,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_search',
    description:
      '检索知识库元数据索引（关键词/标签/频道/分类/日期范围）。返回命中文章的路径、摘要、'
      + '标签、关键词、分类与金句文件路径。先检索再读全文，是省 token 的推荐顺序。',
    parameters: {
      query: { type: 'string', description: '关键词；命中 summary/keywords/tags/路径时计分排序' },
      tag: { type: 'string', description: '按正文 hashtag 过滤（不带 #）' },
      channel: { type: 'string', description: '按频道 key 过滤' },
      category: { type: 'string', description: '按主题分类过滤' },
      dateFrom: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
      dateTo: { type: 'string', description: '截止日期 YYYY-MM-DD（含）' },
      limit: { type: 'integer', description: '最多返回条数，默认 20，上限 200' },
    },
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 20, 1), 200)
      const startedAt = Date.now()
      const results = await searchIndex(root, {
        query: args.query,
        tag: args.tag,
        channel: args.channel,
        category: args.category,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
        limit,
      })
      return { dataDir: root, total: results.length, tookMs: Date.now() - startedAt, results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_sync',
    description:
      '同步知识星球帖子到本地 Markdown：下载附件、抽取 docx/PDF 正文、内嵌图片、语音文件与原始 JSON。'
      + 'mode=today 只同步今天；date/month/count/hashtag 对应其他范围。'
      + '这是写操作（会在数据目录创建文件），调用前先向用户确认。'
      + '同步完成后仍需按 skill 做 enrichment（分类/摘要/金句），再重建索引。',
    parameters: {
      mode: { type: 'string', required: true, enum: SYNC_MODES, description: 'today | date | month | count | hashtag' },
      channels: { type: 'array', items: { type: 'string' }, description: '频道 key 列表；省略=配置里的全部频道' },
      date: { type: 'string', description: 'mode=date 必填，YYYY-MM-DD' },
      month: { type: 'string', description: 'mode=month 必填，YYYY-MM' },
      count: { type: 'integer', description: '拉取条数（1..30，接口上限）；today/date 默认 30' },
      scope: { type: 'string', enum: SCOPES, description: '帖子范围；省略则用频道默认（通常 digests）' },
      hashtag: { type: 'string', description: 'mode=hashtag 必填，标签名不带 #' },
      refresh: { type: 'boolean', description: '仅 mode=month：删除本地该月数据后重拉（破坏性，需 confirmDestructive）' },
      confirmDestructive: { type: 'boolean', description: '用明确确认「refresh 会删除该月已有 md 与金句」' },
    },
    output: JSON_OUTPUT,
    timeoutMs: config.syncTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      const paths = dataPaths(root)
      await prepareRoot(root)
      const { client, loaded } = await createClient(root, config, exec.signal)

      const allChannels = loaded.channels ?? {}
      const keys = Object.keys(allChannels)
      if (keys.length === 0) {
        throw new Error('ZSXQ_NO_CHANNEL: config.json 的 channels 为空。先运行 zsxq_doctor 生成频道配置。')
      }
      const requested = Array.isArray(args.channels) && args.channels.length > 0 ? args.channels : keys
      const unknown = requested.filter((key) => !Object.hasOwn(allChannels, key))
      if (unknown.length > 0) {
        throw new Error(`ZSXQ_UNKNOWN_CHANNEL: 未知频道 ${unknown.join(', ')}；可选：${keys.join(', ')}`)
      }
      if (args.mode === 'month') {
        if (typeof args.month !== 'string' || !/^\d{4}-\d{2}$/.test(args.month)) {
          throw new Error('ZSXQ_INVALID_ARGS: mode=month 时必须给 month，格式 YYYY-MM')
        }
      }
      if (args.mode === 'date' && (typeof args.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args.date))) {
        throw new Error('ZSXQ_INVALID_ARGS: mode=date 时必须给 date，格式 YYYY-MM-DD')
      }
      if (args.mode === 'hashtag' && (typeof args.hashtag !== 'string' || args.hashtag.trim().length === 0)) {
        throw new Error('ZSXQ_INVALID_ARGS: mode=hashtag 时必须给 hashtag')
      }
      const count = args.count ?? 30
      if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        throw new Error(`ZSXQ_INVALID_ARGS: count 必须是 1..${MAX_COUNT}（知识星球接口单次上限）`)
      }
      if (args.refresh === true) {
        if (args.confirmDestructive !== true) {
          throw new Error(
            'ZSXQ_DESTRUCTIVE_BLOCKED: refresh 会删除该频道该月的 channels/assets/data-raw，'
            + '连同已填的 topic_category/keywords/summary 与 .quotes.md。确认时重试并带 confirmDestructive: true。',
          )
        }
        if (args.mode !== 'month') throw new Error('ZSXQ_INVALID_ARGS: refresh 只能与 mode=month 同用')
        if (requested.length !== 1) throw new Error('ZSXQ_INVALID_ARGS: refresh 只允许单频道')
      }

      const logs = []
      const log = (line) => { logs.push(line) }
      const perChannel = []
      const errors = []
      const written = []

      for (const key of requested) {
        const channelConfig = allChannels[key]
        const timer = config.syncTimeoutMs
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(new Error('timeout')), timer)
        const signal = exec.signal === undefined ? controller.signal : AbortSignal.any([exec.signal, controller.signal])
        const scopedClient = new ZsxqClient(loaded.zsxq_cookie, {
          signal,
          requestIntervalMs: config.requestIntervalMs,
        })

        try {
          let result
          if (args.mode === 'month') {
            result = await syncChannelMonth({
              client: scopedClient,
              channelKey: key,
              channelConfig,
              config: loaded,
              root,
              yearMonth: args.month,
              scope: args.scope,
              refresh: args.refresh === true,
              log,
            })
          } else {
            result = await syncChannel({
              client: scopedClient,
              channelKey: key,
              channelConfig,
              config: loaded,
              root,
              scope: args.scope,
              count,
              hashtag: args.mode === 'hashtag' ? args.hashtag : undefined,
              targetDate: args.mode === 'today'
                ? localDateString()
                : (args.mode === 'date' ? args.date : undefined),
              log,
            })
          }
          written.push(...result.written)
          perChannel.push({ channel: key, ok: true, ...result })
        } catch (error) {
          const code = error instanceof ZsxqError ? error.code : 'ZSXQ_SCRIPT_FAILED'
          const mapped = {
            code,
            message: messageOf(error),
            action: code === 'ZSXQ_COOKIE_EXPIRED'
              ? 'Cookie 已失效：浏览器登录 wx.zsxq.com，F12 → Network 复制 api.zsxq.com 请求的 Cookie，更新 config.json。'
              : code === 'ZSXQ_API_ERROR'
                ? '知识星球接口返回错误（注意 count 上限 30、Cookie 权限）；稍后重试或先跑 zsxq_doctor。'
                : '检查 config.json、网络与频道配置；必要时跑 zsxq_doctor。',
          }
          errors.push(mapped)
          perChannel.push({ channel: key, ok: false, error: mapped })
          break
        } finally {
          clearTimeout(timeout)
        }
      }

      return renderResult({
        ok: errors.length === 0,
        mode: args.mode,
        dataDir: root,
        written,
        perChannel,
        errors,
        logs: logs.join('\n').slice(-6000),
        nextStep: errors.length > 0
          ? errors[0].action
          : written.length === 0
            ? '没有新增内容（可能已同步过）；用 zsxq_status 确认。'
            : '按 skill 的 enrichment 规范补齐分类/摘要/金句，然后调用 zsxq_rebuild_index。',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_rebuild_index',
    description:
      '重建知识库索引：INDEX.md、index/index.json、index/by-date|by-tag|by-topic|by-channel、'
      + 'quotes-index.md。enrichment 之后必须运行一次，否则 zsxq_search 搜不到新内容。只写 index/ 与 INDEX.md。',
    parameters: {},
    output: JSON_OUTPUT,
    timeoutMs: config.indexTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(_args, _exec) {
      const root = await resolveDataDir(ctx, undefined, config)
      const startedAt = Date.now()
      const { files, stats } = await buildIndexFiles(root)
      for (const file of files) {
        await writeFileAtomic(join(root, file.path), file.content)
      }
      return {
        ok: true,
        dataDir: root,
        durationMs: Date.now() - startedAt,
        articles: stats.articles,
        quotes: stats.quotes,
        wrote: files.map((file) => file.path),
        warnings: stats.warnings ?? [],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zsxq_doctor',
    description:
      '环境自检：数据目录/config.json 是否就绪、Cookie 是否仍有效（真实调用一次 /v2/groups，'
      + '只报告有效性不返回 Cookie）、能否列出频道、索引是否落后。同步失败、换机器、换 Cookie 时先跑它。',
    parameters: {},
    output: JSON_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const root = await resolveDataDir(ctx, exec, config)
      const paths = dataPaths(root)
      const checks = []
      const actions = []

      checks.push({
        name: 'dataDir',
        ok: existsSync(root),
        detail: root,
      })
      if (!existsSync(root)) actions.push('调用 zsxq_init 创建数据目录')

      const configExists = existsSync(paths.configFile)
      const loaded = configExists ? await loadConfig(root) : undefined
      const hasCookie = typeof loaded?.zsxq_cookie === 'string' && loaded.zsxq_cookie.trim().length > 0
      checks.push({
        name: 'config',
        ok: configExists && hasCookie,
        detail: configExists
          ? (hasCookie ? `config.json 就绪，${Object.keys(loaded.channels ?? {}).length} 个频道` : '缺少 zsxq_cookie')
          : 'config.json 不存在',
      })
      if (!configExists) actions.push('调用 zsxq_init 生成 config.json 模板')
      else if (!hasCookie) actions.push('把 wx.zsxq.com 的 Cookie 填入 config.json 的 zsxq_cookie')

      if (hasCookie) {
        const probe = deadline(exec.signal, 20_000)
        try {
          const { client } = await createClient(root, config, probe.signal)
          const groups = await client.getGroups()
          checks.push({ name: 'cookie', ok: true, detail: `Cookie 有效，可访问 ${groups.length} 个星球` })
          const configured = loaded.channels ?? {}
          const missing = groups
            .map((item) => ({ id: String(item?.group?.group_id ?? ''), name: item?.group?.name ?? '' }))
            .filter((group) => !Object.values(configured).some((value) => String(value?.group_id ?? '') === group.id))
          if (Object.keys(configured).length === 0) {
            actions.push('channels 为空：把上面列出的星球按 {"channels":{"my-channel":{"name":"…","group_id":"…","default_scope":"digests"}}} 填进 config.json')
          } else if (missing.length > 0) {
            actions.push(`还有 ${missing.length} 个可访问星球未配置：${missing.map((group) => group.name).join('、')}`)
          }
        } catch (error) {
          const code = error instanceof ZsxqError ? error.code : 'ZSXQ_NETWORK_ERROR'
          checks.push({ name: 'cookie', ok: false, detail: `${code}: ${messageOf(error)}` })
          if (code === 'ZSXQ_COOKIE_EXPIRED') actions.push('Cookie 已失效，重新获取并更新 config.json')
        } finally {
          probe.cancel()
        }
      }

      const inventory = await collectInventory(root)
      const index = await readJsonIfPresent(paths.indexJson)
      const indexed = typeof index?.total_articles === 'number' ? index.total_articles : null
      const indexOk = index !== undefined && indexed === inventory.articles
      checks.push({
        name: 'index',
        ok: indexOk,
        detail: index === undefined
          ? 'index/index.json 不存在'
          : indexOk
            ? `索引与磁盘一致（${inventory.articles} 篇）`
            : `索引不一致：记录 ${indexed} 篇，磁盘 ${inventory.articles} 篇`,
      })
      if (!indexOk) actions.push('调用 zsxq_rebuild_index')

      return {
        ok: checks.every((check) => check.ok),
        dataDir: root,
        checks,
        warnings: inventory.nonArticle > 0
          ? [`channels/ 下有 ${inventory.nonArticle} 个无 frontmatter 的手写 md（不计入索引）`]
          : [],
        suggestedActions: [...new Set(actions)],
      }
    },
  }))
}
