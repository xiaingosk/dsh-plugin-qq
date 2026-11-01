/**
 * 探测：OneBot 实现会不会告诉我们它自己的信息（含安装路径）。
 * 用法：node test/probe-actions.mjs <wsUrl> [token]
 */
const url = process.argv[2] ?? 'ws://127.0.0.1:3001'
const token = process.argv[3] ?? ''

const actions = [
  'get_version_info',
  'get_status',
  'get_login_info',
  'get_config',
  'get_sys_config',
  'get_napcat_config',
  'get_plugin_status',
  '.get_version',
  'get_app_dir',
  'get_qq_dir',
]

const full = token ? `${url}?access_token=${encodeURIComponent(token)}` : url
const ws = new WebSocket(full)
let seq = 0
const pending = new Map()
const results = []

function call(action) {
  return new Promise((resolve) => {
    const echo = `p${++seq}`
    pending.set(echo, resolve)
    ws.send(JSON.stringify({ action, params: {}, echo }))
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo)
        resolve({ action, timeout: true })
      }
    }, 3000)
  })
}

ws.onopen = async () => {
  for (const a of actions) {
    const r = await call(a)
    results.push({ action: a, result: r })
  }
  for (const r of results) {
    const s = JSON.stringify(r.result ?? null)
    console.log(`  ${r.action.padEnd(20)} ${s.length > 260 ? s.slice(0, 260) + '…' : s}`)
  }
  ws.close()
}

ws.onmessage = (ev) => {
  let d
  try {
    d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
  } catch {
    return
  }
  const done = d?.echo ? pending.get(d.echo) : undefined
  if (done) {
    pending.delete(d.echo)
    done(d)
  }
}

ws.onerror = (e) => {
  console.log('  连接失败:', e?.message ?? e)
  process.exit(1)
}

ws.onclose = () => process.exit(0)
setTimeout(() => process.exit(0), 40000)
