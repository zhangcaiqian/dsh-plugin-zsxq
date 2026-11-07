/**
 * 知识星球 Web v2 API 客户端（原生 fetch，无第三方依赖）。
 *
 * 行为与 Python 版 zsxq_api.py 对齐：1.5s 限流、业务码 1059 重试 3 次、
 * Cookie 认证、附件流式下载。差异：错误统一为带 code 的 ZsxqError，便于工具层映射。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { parseJsonText } from './json.mjs'

const BASE_URL = 'https://api.zsxq.com'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://wx.zsxq.com',
  Referer: 'https://wx.zsxq.com/',
}
const RATE_LIMIT_CODE = 1059

/** 带错误码的 API 异常。 */
export class ZsxqError extends Error {
  constructor(message, code, options = {}) {
    super(message, options)
    this.name = 'ZsxqError'
    this.code = code
  }
}

/** 组合取消信号与超时。 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 睡眠（可被 signal 打断）。 */
export function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new ZsxqError('已取消', 'ZSXQ_ABORTED'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      rejectPromise(new ZsxqError('已取消', 'ZSXQ_ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 归一化 `/v2/groups` 的星球条目。
 *
 * 现行 API 返回**扁平** group 对象（`group_id` / `name` 直接在顶层）；
 * 某些封装或旧响应会多包一层 `group`。两种形态都兼容。
 *
 * @param item 单个条目。
 * @returns `{ id, name }`，缺失字段为空字符串。
 */
export function normalizeGroup(item) {
  const group = item?.group ?? item ?? {}
  return {
    id: String(group.group_id ?? ''),
    name: typeof group.name === 'string' ? group.name : '',
  }
}

/** 知识星球 API 客户端。 */
export class ZsxqClient {
  /**
   * @param cookie zsxq_access_token 等组成的整串 Cookie。
   * @param options `{ signal, requestIntervalMs }`。
   */
  constructor(cookie, options = {}) {
    if (typeof cookie !== 'string' || cookie.trim().length === 0) {
      throw new ZsxqError('缺少 zsxq_cookie：请在 config.json 里配置 Cookie', 'ZSXQ_CONFIG_MISSING')
    }
    this.cookie = cookie.trim()
    this.signal = options.signal
    this.requestIntervalMs = options.requestIntervalMs ?? 1500
    this.lastRequestAt = 0
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt
    if (elapsed < this.requestIntervalMs) await sleep(this.requestIntervalMs - elapsed, this.signal)
    this.lastRequestAt = Date.now()
  }

  async request(path, { params, timeoutMs = 15000, retries = 3 } = {}) {
    await this.throttle()
    const url = new URL(BASE_URL + path)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    let response
    try {
      response = await fetch(url, {
        headers: { ...HEADERS, Cookie: this.cookie },
        signal: withTimeout(this.signal, timeoutMs),
      })
    } catch (error) {
      if (this.signal?.aborted) throw new ZsxqError('请求已取消', 'ZSXQ_ABORTED')
      throw new ZsxqError(`请求失败：${String(error?.message ?? error)}`, 'ZSXQ_NETWORK_ERROR', { cause: error })
    }
    if (response.status === 401 || response.status === 403) {
      throw new ZsxqError(
        `知识星球接口拒绝访问（HTTP ${response.status}）：Cookie 可能已失效`,
        'ZSXQ_COOKIE_EXPIRED',
      )
    }
    if (!response.ok) {
      throw new ZsxqError(`知识星球接口异常（HTTP ${response.status}）`, 'ZSXQ_API_ERROR')
    }
    let payload
    try {
      payload = parseJsonText(await response.text())
    } catch (error) {
      throw new ZsxqError(`响应不是合法 JSON：${path}`, 'ZSXQ_API_ERROR', { cause: error })
    }
    if (payload?.succeeded !== true) {
      const code = payload?.code ?? 'unknown'
      if (Number(code) === RATE_LIMIT_CODE && retries > 0) {
        await sleep(3000, this.signal)
        return await this.request(path, { params, timeoutMs, retries: retries - 1 })
      }
      throw new ZsxqError(`API 错误 (code=${code}): ${path}`, 'ZSXQ_API_ERROR')
    }
    return payload.resp_data ?? {}
  }

  /** 当前 Cookie 可访问的星球列表。 */
  async getGroups() {
    const data = await this.request('/v2/groups')
    return Array.isArray(data.groups) ? data.groups : []
  }

  /** 星球帖子列表（分页游标 end_time）。 */
  async getTopics(groupId, { scope = 'digests', count = 10, endTime } = {}) {
    const data = await this.request(`/v2/groups/${groupId}/topics`, {
      params: { scope, count, end_time: endTime },
    })
    return Array.isArray(data.topics) ? data.topics : []
  }

  /** 某标签下的帖子。 */
  async getHashtagTopics(hashtagId, { count = 10, endTime } = {}) {
    const data = await this.request(`/v2/hashtags/${hashtagId}/topics`, {
      params: { count, end_time: endTime },
    })
    return Array.isArray(data.topics) ? data.topics : []
  }

  /** 星球顶部菜单（用于反查 hashtag id）。 */
  async getMenus(groupId) {
    const data = await this.request(`/v2/groups/${groupId}/menus`)
    return Array.isArray(data.menus) ? data.menus : []
  }

  /** 全部标签及帖子数。 */
  async getHashtags(groupId) {
    const data = await this.request(`/v2/groups/${groupId}/hashtags`)
    return Array.isArray(data.hashtags) ? data.hashtags : []
  }

  /** 附件临时下载链接（带签名）。 */
  async getFileDownloadUrl(fileId) {
    const data = await this.request(`/v2/files/${fileId}/download_url`)
    return typeof data.download_url === 'string' ? data.download_url : ''
  }

  /** 下载附件到本地（自动建目录）。 */
  async downloadFile(fileId, savePath) {
    const downloadUrl = await this.getFileDownloadUrl(fileId)
    if (downloadUrl.length === 0) throw new ZsxqError(`无法获取下载链接：${fileId}`, 'ZSXQ_DOWNLOAD_FAILED')
    await this.throttle()
    let response
    try {
      response = await fetch(downloadUrl, { signal: withTimeout(this.signal, 120000) })
    } catch (error) {
      throw new ZsxqError(`下载失败：${String(error?.message ?? error)}`, 'ZSXQ_DOWNLOAD_FAILED', { cause: error })
    }
    if (!response.ok) throw new ZsxqError(`下载失败（HTTP ${response.status}）`, 'ZSXQ_DOWNLOAD_FAILED')
    const buffer = Buffer.from(await response.arrayBuffer())
    await mkdir(dirname(savePath), { recursive: true })
    await writeFile(savePath, buffer)
    return savePath
  }

  /** 抓取「文章贴」的 HTML 正文页。 */
  async fetchArticleHtml(url) {
    if (typeof url !== 'string' || url.length === 0) return ''
    await this.throttle()
    try {
      const response = await fetch(url, { headers: HEADERS, signal: withTimeout(this.signal, 20000) })
      if (!response.ok) return ''
      return await response.text()
    } catch {
      return ''
    }
  }
}
