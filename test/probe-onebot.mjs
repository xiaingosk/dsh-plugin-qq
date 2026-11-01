/**
 * 验证 lib/index.js 里探活算法的核心逻辑（TCP 存活 + OneBot 握手）。
 * 直接对当前运行的 NapCat 打一次，确认三态判定正确。
 *
 * 用法：node test/probe-onebot.mjs [url] [token]
 *
 * 令牌不要写死在这个文件里——它会进版本库。没传参数时从插件配置里读
 * （~/.dsh/dsh-plugin-qq.json），那份文件在仓库之外。
 */
import { connect as netConnect } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function loadOnebotConfig() {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return JSON.parse(readFileSync(join(home, 'dsh-plugin-qq.json'), 'utf8'))?.onebot ?? {}
  } catch {
    return {}
  }
}

const saved = loadOnebotConfig()
const url = process.argv[2] ?? saved.url ?? 'ws://127.0.0.1:3001'
const token = process.argv[3] ?? process.env.ONEBOT_TOKEN ?? saved.token ?? ''

function tcpAlive(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let sock
    const finish = (ok) => {
      try {
        sock?.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    try {
      sock = netConnect({ host, port })
    } catch {
      resolve(false)
      return
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

function handshake(url, token, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let ws
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ state: 'timeout', hint: '握手超时' }), timeoutMs)
    try {
      let full = url
      if (token) full += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(token)}`
      ws = new WebSocket(full)
    } catch (err) {
      clearTimeout(timer)
      finish({ state: 'unreachable', hint: `地址无效：${err?.message ?? err}` })
      return
    }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'probe' }))
      } catch {
        /* ignore */
      }
    }
    ws.onmessage = (ev) => {
      let d
      try {
        d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (d?.echo !== 'probe') return
      clearTimeout(timer)
      const ok = d.status === 'ok' || d.retcode === 0
      finish(
        ok
          ? { state: 'connected', selfId: String(d.data?.user_id ?? ''), hint: '已连接' }
          : { state: 'reachable-no-auth', hint: `握手被拒 ${d.retcode ?? ''} ${d.message ?? ''}` },
      )
    }
    ws.onerror = () => {
      clearTimeout(timer)
      finish({ state: 'unreachable', hint: '不是 OneBot 或连接被拒' })
    }
    ws.onclose = () => {
      clearTimeout(timer)
      finish({ state: 'unreachable', hint: '连接被关闭' })
    }
  })
}

const u = new URL(url)
const host = u.hostname
const port = Number(u.port || 80)
const alive = await tcpAlive(host, port)
console.log(`TCP ${host}:${port} →`, alive ? '有人在听' : '没人听')
if (!alive) {
  console.log('判定: unreachable')
  process.exit(0)
}

const r = await handshake(url, token)
console.log('握手结果:', r.state, r.selfId ? `(机器人 ${r.selfId})` : '', '|', r.hint)

console.log('\n--- 令牌错误的情况 ---')
const wrong = await handshake(url, 'definitely-wrong-token')
console.log('握手结果:', wrong.state, '|', wrong.hint)
