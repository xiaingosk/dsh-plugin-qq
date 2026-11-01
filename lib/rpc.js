/**
 * 插件内部的 DSH HTTP 客户端 —— 只用于「新建会话」这一件事。
 *
 * 为什么不完全走 in-process：
 *   agents.create() 需要 agentOptions 和 preset 组装出来的 setup，
 *   复刻那套等于把 DSH 内部结构抄一遍，版本一变就崩。
 *   新建会话每个 QQ 对话只发生一次，走已验证的 RPC 更稳。
 *
 * 投递消息和接收回复都走 in-process（见 index.js）。
 */
import { createHmac, createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME } from './config.js'

/** 从 credentials.yaml 取浏览器会话签名密钥。 */
export function readSigningSecret() {
  const file = join(DSH_HOME, '.credentials.yaml')
  if (!existsSync(file)) throw new Error(`找不到 ${file}`)
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => /client-connection\/browser-session:\s*$/.test(l))
  if (start < 0) throw new Error('credentials.yaml 里没有 browser-session 记录')
  const baseIndent = lines[start].match(/^\s*/)[0].length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (line.match(/^\s*/)[0].length <= baseIndent) break
    const m = /^\s*secret:\s*([A-Za-z0-9_-]+)/.exec(line)
    if (m) {
      const buf = Buffer.from(m[1], 'base64url')
      if (buf.length !== 32) throw new Error(`secret 长度异常: ${buf.length}`)
      return buf
    }
  }
  throw new Error('browser-session 记录里没有 secret')
}

/** 铸一个会话 Cookie。 */
export function mintCookie(baseUrl, secret = readSigningSecret()) {
  const authority = new URL(baseUrl).host
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 12 * 3600_000 }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest().toString('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  return `${name}=v1.${body}.${sig}`
}

/**
 * 极简 RPC 客户端。只实现了 session/create 用到的那一套。
 */
export class Rpc {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.cookie = null
    this.cookieAt = 0
    this.seq = 0
    this.argField = new Map()
  }

  /**
   * 确保手里有一个新鲜的 Cookie。
   *
   * 这个插件会跨夜常驻，而 Cookie 只有 12 小时有效期——启动时铸一次、之后永不刷新，
   * 过了半天所有 RPC 都会 401（表现就是 /bind 说「认证失败」、新会话也建不出来）。
   * 所以按 11 小时主动换新，并在 401 时强制重铸一次；每次都重读密钥，
   * 这样 DSH 哪天换了签名密钥也能自动跟上。
   */
  #ensureCookie(force = false) {
    const TTL = 11 * 3600_000
    if (!force && this.cookie && Date.now() - this.cookieAt < TTL) return
    this.cookie = mintCookie(this.base)
    this.cookieAt = Date.now()
  }

  async #post(method, args, field, timeoutMs = 30_000) {
    const url = `${this.base}/api/${method}`
    // 零参数方法（如 directoryPicker/pick）不能发 {request:{}}，否则报 unexpected "request"
    const payloadArgs = args == null ? {} : { [field]: args }
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `qqp-${++this.seq}`,
      method,
      payload: { args: payloadArgs },
    })
    const send = () => {
      this.#ensureCookie()
      return fetch(url, {
        method: 'POST',
        headers: { cookie: this.cookie, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    }

    let res = await send()
    if (res.status === 401) {
      this.#ensureCookie(true)
      res = await send()
      if (res.status === 401) throw new Error('DSH 认证失败（Cookie 无效，重铸后仍是 401）')
    }
    const text = await res.text()
    if (!text) {
      // 服务器还没准备好时会是空响应，值得重试
      throw Object.assign(new Error(`空响应 (HTTP ${res.status})`), { retryable: true })
    }
    try {
      return JSON.parse(text)
    } catch {
      throw Object.assign(new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 120)}`), {
        retryable: true,
      })
    }
  }

  async call(method, args, timeoutMs = 30_000) {
    let field = this.argField.get(method) ?? 'request'
    let lastRetryable = null

    for (let attempt = 0; attempt < 12; attempt++) {
      let json
      try {
        json = await this.#post(method, args, field, timeoutMs)
      } catch (err) {
        if (err?.retryable) {
          lastRetryable = err
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        throw err
      }
      const result = json?.result
      if (result?.ok) return result.value
      const msg = result?.error?.message ?? ''
      const missing = /missing "([^"]+)"/.exec(msg)
      if (missing && missing[1] !== field) {
        field = missing[1]
        this.argField.set(method, field)
        continue
      }
      throw new Error(`${method} 失败: [${result?.error?.code}] ${msg}`)
    }
    throw lastRetryable ?? new Error(`${method} 重试次数用尽`)
  }

  createSession({ cwd, sessionId, workspaceId, agentPreset } = {}) {
    const request = {}
    if (cwd) request.cwd = cwd
    if (sessionId) request.sessionId = sessionId
    // 带上 workspaceId，会话才会成为该工作区的成员，
    // 界面里才会归到对应分组而不是"未分组"。
    if (workspaceId) request.workspaceId = workspaceId
    // preset 只在建会话时可指定，之后锁定（agent-preset/locked）。
    // 名字不存在会报 agent-preset/not-found，调用方负责降级。
    if (agentPreset) request.agentPreset = agentPreset
    return this.call('session/create', request)
  }
}
