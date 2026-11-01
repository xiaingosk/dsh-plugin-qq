/**
 * 读 NapCat 自己的配置文件。
 *
 * 只读 `napcatPath` 指向的那一个 NapCat 实例：
 *
 *   <root>/config/webui.json             WebUI 的 host/port/token（一份）
 *   <root>/config/onebot11_<QQ号>.json   每个登录过的号一份，含 WebSocket 端口和令牌
 *
 * 多个 NapCat 实例各占一个目录，用户指了哪个就读哪个，不会互相干扰。
 * 唯一可能的歧义是"同一个实例里切换登录过多个号"，那时目录里会留下多份
 * onebot11_*.json —— 由调用方传入的 handshake 实测来挑，不靠猜。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `::` / `0.0.0.0` 这类通配地址浏览器连不上，映射成回环。 */
export function usableHost(host, fallback = '127.0.0.1') {
  const h = String(host ?? '').trim()
  if (!h || h === '::' || h === ':::' || h === '0.0.0.0' || h === '[::]') return fallback
  return h
}

/** napcatPath 可以是启动脚本，也可以是目录本身。 */
export function resolveNapcatRoot(input) {
  const p = String(input ?? '').trim()
  if (!p) return null
  if (!existsSync(p)) return { root: p, exists: false, configDir: join(p, 'config') }
  let isDir = false
  try {
    isDir = statSync(p).isDirectory()
  } catch {
    /* ignore */
  }
  const root = isDir ? p : dirname(p)
  return { root, exists: true, configDir: join(root, 'config') }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/**
 * 纯读取：不联网、不探测。同步，方便单测。
 *
 * @param {string} napcatPath 启动脚本或目录
 * @returns {{ok:boolean, problems:string[], root:object|null, webui:object|null, candidates:object[]}}
 */
export function readNapcatFiles(napcatPath) {
  const problems = []
  const target = resolveNapcatRoot(napcatPath)
  if (!target) {
    return { ok: false, problems: ['还没填 NapCat 启动脚本的路径'], root: null, webui: null, candidates: [] }
  }
  if (!target.exists) {
    return {
      ok: false,
      problems: [`路径不存在：${target.root}`],
      root: { path: target.root, exists: false },
      webui: null,
      candidates: [],
    }
  }
  if (!existsSync(target.configDir)) {
    return {
      ok: false,
      problems: [`这个目录下没有 config 子目录：${target.configDir}`, '确认填的是 NapCat 解压目录里的启动脚本'],
      root: { path: target.root, exists: true, configDir: target.configDir, configDirExists: false },
      webui: null,
      candidates: [],
    }
  }

  // ── WebUI：一份
  let webui = null
  const webuiFile = join(target.configDir, 'webui.json')
  const wj = readJsonSafe(webuiFile)
  if (wj) {
    const port = Number(wj.port)
    const token = String(wj.token ?? '')
    if (Number.isFinite(port) && port > 0) {
      const host = usableHost(wj.host)
      webui = {
        host,
        port,
        token,
        file: webuiFile,
        url: `http://${host}:${port}/webui${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      }
    } else {
      problems.push('webui.json 里没有可用的端口')
    }
  } else {
    problems.push(
      existsSync(webuiFile)
        ? 'webui.json 读不了（可能是格式坏了）'
        : '还没有 webui.json —— 说明这个 NapCat 还没启动过',
    )
  }

  // ── OneBot：每个号一份
  const candidates = []
  let files = []
  try {
    files = readdirSync(target.configDir).filter((f) => /^onebot11_\d+\.json$/.test(f))
  } catch (err) {
    problems.push(`列 config 目录失败：${err?.message ?? err}`)
  }
  for (const f of files) {
    const qq = f.match(/onebot11_(\d+)/)?.[1] ?? ''
    const j = readJsonSafe(join(target.configDir, f))
    if (!j) {
      candidates.push({ file: f, qq, error: 'JSON 读不了' })
      continue
    }
    const raw = j?.network?.websocketServers
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    const enabled = list.filter((s) => s && s.enable !== false && Number(s.port) > 0)
    if (enabled.length === 0) {
      candidates.push({ file: f, qq, error: '没有启用中的 WebSocket 服务端' })
      continue
    }
    for (const s of enabled) {
      const host = usableHost(s.host)
      const port = Number(s.port)
      candidates.push({
        file: f,
        qq,
        name: s.name ?? '',
        host,
        port,
        token: String(s.token ?? ''),
        url: `ws://${host}:${port}`,
      })
    }
  }

  if (candidates.length === 0) {
    problems.push(
      files.length === 0
        ? '还没有 onebot11_<QQ号>.json —— 说明还没在 WebUI 里建过 WebSocket 服务端'
        : '找到了配置文件，但没有启用中的 WebSocket 服务端',
    )
  }

  return {
    ok: true,
    root: { path: target.root, exists: true, configDir: target.configDir, configDirExists: true },
    webui,
    candidates,
    problems,
  }
}

/**
 * 在纯读取之上挑一个可用候选。
 *
 * 顺序：当前已连接的 selfId 对文件名 → 逐个握手实测 → 第一个可用的 → 放弃。
 * 读错也不会出事：错的根本握不上手。
 *
 * @param {object} opts
 * @param {string} opts.napcatPath
 * @param {string|null} opts.selfId 插件当前连着的机器人号
 * @param {(url:string, token:string, timeoutMs?:number)=>Promise<object>} opts.handshake
 */
export async function readNapcatConfig({ napcatPath, selfId, handshake }) {
  const base = readNapcatFiles(napcatPath)
  let picked = null

  if (base.ok) {
    const sid = selfId ? String(selfId) : null
    if (sid) {
      picked = base.candidates.find((c) => c.qq === sid && c.url && !c.error) ?? null
      if (picked) picked.verified = true
    }
    if (!picked && typeof handshake === 'function') {
      for (const c of base.candidates) {
        if (!c.url || c.error) continue
        try {
          const r = await handshake(c.url, c.token, 2500)
          c.probe = r?.state
          if (r?.state === 'connected') {
            c.verified = true
            c.selfId = r.selfId
            picked = c
            break
          }
          if (r?.hint) c.hint = r.hint
        } catch (err) {
          c.probe = 'error'
          c.hint = String(err?.message ?? err)
        }
      }
    }
    if (!picked) {
      const usable = base.candidates.find((c) => c.url && !c.error)
      if (usable) {
        picked = usable
        picked.verified = false
      }
    }
  }

  return {
    ...base,
    onebot: { picked, candidates: base.candidates },
  }
}
