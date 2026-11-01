/**
 * 设置页用的 HTTP 接口。
 *
 * 为什么不用 gateway RPC：插件注册 RPC 命名空间要走 dsh-api-gateway 的
 * typert 反射，重；而 `ctx.webServer.register` 就是一个 Node http handler，
 * 客户端同源 fetch 即可。
 *
 * 安全边界：只接受本机回环 + 同源请求。DSH 默认绑 127.0.0.1，但这层校验
 * 仍然要做——否则本机任意进程都能改掉这个能驱动电脑的插件的配置。
 */
import { existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PREFIX = '/dsh-plugin-qq/api'

/** 只允许本机回环 + 同源。返回 null 表示放行，否则返回拒绝原因。 */
function rejectReason(req) {
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return `只允许本机访问（来源 ${remote}）`

  // 浏览器同源请求会带 Origin；缺少 Origin 的一般是非浏览器客户端，也放行（已限回环）。
  const origin = req.headers?.origin
  if (origin) {
    const host = req.headers?.host
    try {
      if (new URL(origin).host !== host) return `来源站不符（${origin}）`
    } catch {
      return `Origin 无法解析（${origin}）`
    }
  }
  return null
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBody(req, limitBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 注册设置页接口。
 *
 * @param {object} opts
 * @param {object} opts.ctx      已注入 webServer 的 scoped ctx
 * @param {(m:string)=>void} opts.log
 * @param {() => object} opts.getState   当前状态快照
 * @param {(next:object)=>Promise<object>} opts.applyConfig  应用新配置
 * @param {()=>Promise<object>} opts.listSessions  列出可选会话
 * @param {(id:string|null)=>Promise<object>} opts.bindSession 绑定/解除会话
 * @param {string} opts.configPath       配置文件路径（保存用）
 * @returns {Array<Function>} disposers
 */
export function registerSettingsRoutes({
  ctx,
  log,
  getState,
  applyConfig,
  listSessions,
  bindSession,
  probeNapcat,
  revealPath,
  readNapcatConfig,
  resolveNapcat,
  launchNapcat,
  pickNapcatDir,
  detectNapcatPath,
  readLogTail,
  configPath,
}) {
  const disposers = []

  const wrap = (name, fn) => (req, res) => {
    const denied = rejectReason(req)
    if (denied) {
      log(`[设置接口] 拒绝 ${name}：${denied}`)
      sendJson(res, 403, { ok: false, error: denied })
      return
    }
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        log(`[设置接口] ${name} 出错: ${err?.stack ?? err}`)
        try {
          sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
        } catch {
          /* 响应可能已发出 */
        }
      })
  }

  // GET /state —— 状态快照
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/state`,
      handler: wrap('state', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        sendJson(res, 200, { ok: true, state: getState() })
      }),
    }),
  )

  // POST /config —— 保存并立即生效
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/config`,
      handler: wrap('config', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        const body = await readBody(req)

        const result = await applyConfig(body)

        // 只写回"用户可改"的字段，其余保持默认推导
        const persisted = {
          enabled: result.config.enabled,
          selftest: result.config.selftest,
          whitelist: result.config.whitelist,
          allowAllWhenEmpty: result.config.allowAllWhenEmpty,
          workspace: result.config.workspace,
          qqSystemPrompt: result.config.qqSystemPrompt,
          qqPersona: result.config.qqPersona,
          napcatPath: result.config.napcatPath,
          onebot: result.config.onebot,
          behavior: result.config.behavior,
        }
        try {
          mkdirSync(dirname(configPath), { recursive: true })
          writeFileSync(configPath, JSON.stringify(persisted, null, 2) + '\n', 'utf8')
          log(`[设置接口] 配置已保存到 ${configPath}`)
        } catch (err) {
          log(`[设置接口] 写配置失败: ${err?.message ?? err}`)
          return sendJson(res, 500, { ok: false, error: `保存失败：${err?.message ?? err}`, notes: result.notes })
        }

        sendJson(res, 200, { ok: true, notes: result.notes, state: getState() })
      }),
    }),
  )

  // POST /client-log —— 客户端把激活/渲染阶段的错误回传到这里。
  // 渲染进程的 console 我们看不到；客户端条目激活失败又会让应用打不开，
  // 所以需要一条"客户端 → 服务端"的回传通道来定位问题。
  const clientLogPath = join(dirname(configPath), 'dsh-plugin-qq-client.log')
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/client-log`,
      handler: wrap('client-log', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        const body = await readBody(req, 64 * 1024)
        const line = `[${new Date().toISOString()}] [${body?.level ?? 'info'}] ${body?.msg ?? ''}${
          body?.stack ? `\n${String(body.stack).slice(0, 2000)}` : ''
        }\n`
        try {
          appendFileSync(clientLogPath, line, 'utf8')
        } catch {
          /* ignore */
        }
        log(`[客户端] [${body?.level ?? 'info'}] ${String(body?.msg ?? '').slice(0, 400)}`)
        sendJson(res, 200, { ok: true })
      }),
    }),
  )

  // GET /sessions —— 可选会话列表
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/sessions`,
      handler: wrap('sessions', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        if (!listSessions) return sendJson(res, 501, { ok: false, error: '该实例没有提供会话列表' })
        const r = await listSessions()
        sendJson(res, 200, { ok: true, ...r })
      }),
    }),
  )

  // POST /bind —— 绑定到指定会话；{ sessionId: null } 表示解除（下条消息新建）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/bind`,
      handler: wrap('bind', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!bindSession) return sendJson(res, 501, { ok: false, error: '该实例没有提供会话绑定' })
        const body = await readBody(req)
        const r = await bindSession(body?.sessionId ?? null)
        if (!r?.ok) return sendJson(res, 400, r)
        sendJson(res, 200, { ...r, state: getState() })
      }),
    }),
  )

  // GET /napcat —— 探测 NapCat / OneBot 的当前状况
  // 返回 state 三选一：connected / reachable-no-auth / unreachable（另加 timeout）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/napcat`,
      handler: wrap('napcat', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        if (!probeNapcat) return sendJson(res, 501, { ok: false, error: '该实例没有提供探测能力' })
        const url = req.query ? req.query.url : undefined
        const token = req.query ? req.query.token : undefined
        const r = await probeNapcat({ url, token })
        sendJson(res, 200, { ok: true, ...r })
      }),
    }),
  )

  // POST /reveal —— 在资源管理器里定位一个文件（只定位，不执行）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/reveal`,
      handler: wrap('reveal', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!revealPath) return sendJson(res, 501, { ok: false, error: '该实例没有提供定位能力' })
        const body = await readBody(req)
        const r = await revealPath(body?.path ?? '')
        sendJson(res, r?.ok ? 200 : 400, r)
      }),
    }),
  )

  // GET /napcat-config —— 读 NapCat 自己的配置文件，供界面拼链接和自动填地址
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/napcat-config`,
      handler: wrap('napcat-config', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        if (!readNapcatConfig) return sendJson(res, 501, { ok: false, error: '该实例没有提供读配置能力' })
        const r = await readNapcatConfig()
        sendJson(res, 200, r)
      }),
    }),
  )

  // POST /detect-napcat —— 从当前端口反查 NapCat 装在哪（进程链 + config/webui.json 判定）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/detect-napcat`,
      handler: wrap('detect-napcat', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!detectNapcatPath) return sendJson(res, 501, { ok: false, error: '该实例没有提供检测能力' })
        const r = await detectNapcatPath()
        sendJson(res, 200, r)
      }),
    }),
  )

  // POST /napcat-pick —— 弹 DSH 主机的目录选择器，返回选中路径（取消返回 cancelled）
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/napcat-pick`,
      handler: wrap('napcat-pick', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!pickNapcatDir) return sendJson(res, 501, { ok: false, error: '该实例没有提供目录选择能力' })
        const r = await pickNapcatDir()
        sendJson(res, r?.ok ? 200 : 400, r)
      }),
    }),
  )

  // POST /napcat-resolve —— 解析用户填的路径（目录或脚本），回填根目录与启动脚本
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/napcat-resolve`,
      handler: wrap('napcat-resolve', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!resolveNapcat) return sendJson(res, 501, { ok: false, error: '该实例没有提供解析能力' })
        const body = await readBody(req)
        // inspectNapcat 是异步的（要读 NapCat 的配置文件）
        const r = await resolveNapcat(body?.path ?? '')
        sendJson(res, r?.ok ? 200 : 400, r)
      }),
    }),
  )

  // POST /napcat-launch —— 启动并登录：定位脚本 + 读配置 + 回 WebUI 链接
  // 不替用户启动 NapCat（它必须活在 DSH 外面），只在资源管理器里选中脚本
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/napcat-launch`,
      handler: wrap('napcat-launch', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        if (!launchNapcat) return sendJson(res, 501, { ok: false, error: '该实例没有提供启动能力' })
        const body = await readBody(req)
        const r = await launchNapcat(body?.path ?? '')
        sendJson(res, r?.ok ? 200 : 400, r)
      }),
    }),
  )

  // GET /log —— plugin.log 的末尾若干行
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/log`,
      handler: wrap('log', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        if (!readLogTail) return sendJson(res, 501, { ok: false, error: '该实例没有提供日志读取' })
        const n = req.query ? req.query.lines : undefined
        sendJson(res, 200, readLogTail(n))
      }),
    }),
  )

  return disposers
}

/** 配置文件所在目录是否存在——启动时用得上。 */
export function configDirExists(configPath) {
  return existsSync(dirname(configPath))
}

export { PREFIX }
