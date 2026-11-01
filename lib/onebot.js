/**
 * OneBot v11 正向 WebSocket 客户端（零依赖，用 Node 内置 WebSocket）。
 *
 * - 事件：服务端推 JSON，形如 { post_type: "message", message_type: "private", ... }
 * - 调用：我们发 { action, params, echo }，服务端回 { status, retcode, data, echo }
 *
 * 断线自动重连，指数退避。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.url   例如 ws://127.0.0.1:3001
   * @param {string} [opts.token] access_token，会拼进 URL 查询串
   * @param {(event:object)=>void} opts.onEvent
   * @param {object} [opts.logger]
   */
  constructor({ url, token, onEvent, logger = console }) {
    this.rawUrl = url
    this.token = token || ''
    this.onEvent = onEvent
    this.logger = logger
    this.ws = null
    this.connected = false
    this.pending = new Map()
    this.echoSeq = 0
    this.closedByUs = false
    this.backoff = 1000
    this.selfId = null
  }

  urlWithToken() {
    const u = new URL(this.rawUrl)
    if (this.token) u.searchParams.set('access_token', this.token)
    return u.toString()
  }

  start() {
    this.closedByUs = false
    this.#connect()
  }

  stop() {
    this.closedByUs = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }

  #connect() {
    let ws
    try {
      ws = new WebSocket(this.urlWithToken())
    } catch (err) {
      this.logger.error?.(`[onebot] 创建连接失败: ${err.message}`)
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.connected = true
      this.backoff = 1000
      this.logger.info?.(`[onebot] 已连接 ${this.rawUrl}`)
      // 探活 + 拿自己的 QQ 号
      this.call('get_login_info')
        .then((info) => {
          this.selfId = info?.user_id ?? null
          this.logger.info?.(`[onebot] 机器人账号 ${this.selfId ?? '(未知)'}`)
        })
        .catch(() => {})
    }

    ws.onmessage = (ev) => {
      let data
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      // 是 action 的回包
      if (data?.echo && this.pending.has(data.echo)) {
        const { resolve } = this.pending.get(data.echo)
        this.pending.delete(data.echo)
        resolve(data)
        return
      }
      // 是事件
      try {
        this.onEvent?.(data)
      } catch (err) {
        this.logger.error?.(`[onebot] 事件处理异常: ${err.stack ?? err}`)
      }
    }

    ws.onerror = () => {
      /* onclose 会紧跟着来 */
    }

    ws.onclose = (ev) => {
      const wasConnected = this.connected
      this.connected = false
      this.ws = null
      // 清理挂起的调用
      for (const [, p] of this.pending) p.resolve({ status: 'failed', retcode: -1, message: '连接已断开' })
      this.pending.clear()
      if (this.closedByUs) return
      if (wasConnected) this.logger.warn?.(`[onebot] 连接断开 (code=${ev.code})，准备重连`)
      this.#scheduleReconnect()
    }
  }

  #scheduleReconnect() {
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 1.8, 30_000)
    setTimeout(() => {
      if (!this.closedByUs) this.#connect()
    }, delay)
  }

  /** 调用一个 OneBot action。 */
  call(action, params = {}, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`OneBot 未连接，无法执行 ${action}`))
    }
    const echo = `qqb-${++this.echoSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`${action} 超时`))
      }, timeoutMs)
      this.pending.set(echo, {
        resolve: (data) => {
          clearTimeout(timer)
          resolve(data?.data ?? data)
        },
      })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
    })
  }

  /** 发私聊消息（纯文本）。 */
  sendPrivate(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId), message: text })
  }

  /** 发群消息（本版本未使用，留作扩展）。 */
  sendGroup(groupId, text) {
    return this.call('send_group_msg', { group_id: Number(groupId), message: text })
  }

  /** 撤回。 */
  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: messageId })
  }
}

/**
 * 把切点往前挪，避免落在一个 UTF-16 代理对的中间。
 *
 * JS 字符串按码元存，emoji 和 BMP 之外的字占两个码元（高低代理各一）。
 * `slice` 按码元切，切在中间会留下孤立高代理——转 UTF-8 时变成 `�`。
 */
export function safeCutIndex(s, index) {
  if (index <= 0) return 0
  if (index >= s.length) return s.length
  const code = s.charCodeAt(index - 1)
  if (code >= 0xd800 && code <= 0xdbff) return index - 1 // 前一个是高代理：前移一位
  return index
}

/** 按码点安全截断到最多 max 个码元（宁可少一个，也不切开 emoji）。 */
export function safeSlice(s, max) {
  return String(s ?? '').slice(0, safeCutIndex(String(s ?? ''), max))
}

/** 把长文本切成若干段，避免单条消息过长。 */
export function chunkText(text, size = 4000) {
  const s = String(text ?? '')
  if (s.length <= size) return [s]
  const out = []
  let rest = s
  while (rest.length > size) {
    // 优先在换行/句号处断开（cut 是分隔符本身的下标，会被包含进前一段）
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = rest.lastIndexOf('。', size)
    if (cut < size * 0.5) cut = size - 1
    let end = safeCutIndex(rest, cut + 1)
    if (end <= 0) end = 1
    out.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) out.push(rest)
  return out
}

export { sleep }
