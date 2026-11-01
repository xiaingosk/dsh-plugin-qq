/**
 * 反查 NapCat 装在哪。
 *
 * 场景：用户自己找到 WebUI 链接、自己填了地址和令牌，连上了 —— 但他没填
 * 启动脚本路径，所以「读配置」用不了。这时从**正在监听的那个端口**反查进程，
 * 一路向上追父进程，找到含有 config/webui.json 的目录，那就是 NapCat 根目录。
 *
 * 为什么用「有没有 config/webui.json」来判定，而不是按进程名匹配：
 * 启动方式有好几种（launcher-user.bat / launcher.bat / 直接跑 NapCatWinBootMain.exe），
 * 中间可能夹着 cmd.exe、wt.exe 等。用文件存在性验证，不依赖任何名字约定。
 *
 * 追进程要调 PowerShell（Node 没有枚举进程的能力），所以这里把
 * **纯逻辑**（从链里挑目录、从目录里挑启动脚本）和 **IO**（跑 PowerShell）分开，
 * 前者可以单测。
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 跑一段 PowerShell，返回 stdout；失败返回 null。 */
export function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout ?? '')),
      )
    } catch {
      resolve(null)
    }
  })
}

/** 拼出「某端口 → 进程链」的 PowerShell 脚本。只读，不改任何东西。 */
export function processChainScript(port) {
  const p = Number(port)
  return [
    `$c = Get-NetTCPConnection -LocalPort ${Number.isFinite(p) ? p : 0} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if (-not $c) { '[]'; exit }`,
    `$id = $c.OwningProcess`,
    `$out = @()`,
    `for ($i = 0; $i -lt 6 -and $id -ne 0; $i++) {`,
    `  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue`,
    `  if (-not $p) { break }`,
    `  $out += [pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; path = $p.ExecutablePath }`,
    `  $id = $p.ParentProcessId`,
    `}`,
    `$out | ConvertTo-Json -Compress`,
  ].join('\n')
}

/**
 * 从进程链里找出 NapCat 根目录：第一个「目录下有 config/webui.json」的进程。
 *
 * @param {{pid:number, path:string|null}[]} chain
 * @param {(dir:string)=>boolean} hasConfig 传入注入的存在性判断，便于单测
 * @returns {{root:string, byPid:number, exePath:string}|null}
 */
export function findRootFromChain(chain, hasConfig) {
  if (!Array.isArray(chain)) return null
  for (const item of chain) {
    const exe = item?.path
    if (!exe) continue
    const dir = dirname(exe)
    if (hasConfig(dir)) return { root: dir, byPid: item.pid, exePath: exe }
  }
  return null
}

/** 在 NapCat 根目录里挑启动脚本：优先用户级，其次通用。 */
export function pickLauncher(dir, has = existsSync) {
  const order = ['launcher-user.bat', 'launcher-win10-user.bat', 'launcher.bat', 'launcher-win10.bat']
  for (const name of order) {
    const full = join(dir, name)
    if (has(full)) return full
  }
  return null
}

/**
 * 反查：从端口一路找到 { root, launcher, webuiConfigExists }。
 *
 * @param {number} port 正在监听的 OneBot WebSocket 端口
 */
export async function detectNapcatRoot(port) {
  if (!Number.isFinite(Number(port)) || Number(port) <= 0) {
    return { ok: false, error: '当前没有可用的端口 —— 先把地址填上并连上，或者直接填启动脚本路径' }
  }
  const stdout = await runPowerShell(processChainScript(port))
  if (stdout == null) {
    return { ok: false, error: '调用 PowerShell 失败（可能被系统策略拦住）' }
  }
  let chain
  try {
    chain = JSON.parse(stdout.trim() || '[]')
  } catch {
    return { ok: false, error: `没看懂 PowerShell 的输出：${stdout.slice(0, 120)}` }
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, error: `端口 ${port} 上没有找到监听进程` }
  }

  const hit = findRootFromChain(chain, (dir) => existsSync(join(dir, 'config', 'webui.json')))
  if (!hit) {
    let extra = ''
    try {
      const names = readdirSync(dirname(chain[0]?.path ?? ''))
      if (names) extra = ''
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: `从端口 ${port} 追了 ${chain.length} 层进程，没找到含 config/webui.json 的目录`,
      chain: chain.map((c) => ({ pid: c.pid, path: c.path })),
      extra,
    }
  }

  const launcher = pickLauncher(hit.root)
  return {
    ok: true,
    root: hit.root,
    launcher,
    launcherMissing: launcher == null,
    byPid: hit.byPid,
    exePath: hit.exePath,
  }
}
