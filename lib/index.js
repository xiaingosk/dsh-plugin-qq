/**
 * dsh-plugin-qq — 把 QQ 私聊接进 DSH
 *
 * 架构（混合式）：
 *   新建会话 → 走 HTTP RPC（DSH 内部 preset 组装太复杂，不重造）
 *   投递消息 → in-process  agent.followup(...)
 *   接收回复 → in-process  ctx.on('session/event')
 *   发回 QQ  → OneBot v11 WebSocket
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  readdirSync,
  renameSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { basename, join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadConfig, DSH_HOME, CONFIG_PATH } from './config.js'
import { registerSettingsRoutes } from './settings-api.js'
import { readNapcatConfig as readNapcatConfigFrom, resolveNapcatRoot } from './napcat-config.js'
import { detectNapcatRoot, pickLauncher } from './napcat-detect.js'
import { formatQuotedMessage } from './quote.js'
import { titleForWake, titleForNewSession } from './session-title.js'
import { Rpc } from './rpc.js'
import { OneBotClient, chunkText, sleep } from './onebot.js'
import { mdToPlain } from './md-to-plain.js'
import { planAssistantText, planTurnEnd, placeholderFor } from './delivery.js'

export const name = 'dsh-plugin-qq'
export const inject = []

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_FILE = join(ROOT, 'plugin.log')
const SESSIONS_FILE = join(DSH_HOME, 'dsh-plugin-qq-sessions.json')
// 版本号只写一处（package.json），别再在这里抄一遍——抄了必然忘记同步
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
// 兜底工作目录：配置里没填时才用。原名 probe-sandbox，是早期探测留下的，现在指向正式工作区。
const FALLBACK_WORKSPACE = join(DSH_HOME, 'qq-workspace')

// QQ 会话用的 agent preset（在 cordis.patch.yml 里声明，id 必须一致）。
// preset 只在建会话时生效且随后锁定，所以换壳子 = 建新会话。
// 老版本 DSH 或没装上 preset 时会报 agent-preset/not-found，届时降级为默认 preset。
const QQ_AGENT_PRESET = 'qq-butler'

/** 一条模型可见的用户消息。 */
function makeUserMessage(content) {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  return createUserMessage({ content: parts, source: { kind: 'user' } })
}

/** 从 magic bytes 判断图片类型。 */
function sniffMediaType(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * 日志超过这个大小就在启动时轮转一次：plugin.log → plugin.log.1，然后重新开始。
 * 只保留一份历史，够排查用，也不会无限长。
 */
const LOG_MAX_BYTES = 5 * 1024 * 1024

function rotateLogIfNeeded(logFile) {
  try {
    if (!existsSync(logFile)) return false
    const size = statSync(logFile).size
    if (size < LOG_MAX_BYTES) return false
    const prev = `${logFile}.1`
    try {
      if (existsSync(prev)) writeFileSync(prev, '', 'utf8')
    } catch {
      /* ignore */
    }
    renameSync(logFile, prev)
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  const { config, found } = loadConfig()

  if (rotateLogIfNeeded(LOG_FILE)) {
    try {
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] 日志超过 ${LOG_MAX_BYTES / 1024 / 1024}MB，已轮转为 plugin.log.1\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  const log = (m) => {
    try {
      appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`, 'utf8')
    } catch {
      /* ignore */
    }
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[qq] ${m}`)
    } catch {
      /* ignore */
    }
  }

  log('================ 插件启动 ================')
  log(`配置: ${found ? '已加载' : '默认值'}  enabled=${config.enabled}`)

  // ⚠️ 即使 enabled=false 也必须把 run() 跑起来：
  // 设置页的 HTTP 接口是在 run() 里注册的。全新安装默认 enabled=false，
  // 如果这里提前返回，用户就永远读不到状态、也保存不了——死锁。
  // 连接 OneBot 与否由 run() 内部按 config.enabled 决定。
  if (!config.enabled) {
    log('enabled=false：只启动设置接口，不连接 QQ（可在设置页里启用）')
  }

  ctx.inject(['agents', 'webServer', 'attachments', 'commands', 'approval'], (scoped) => {
    run({
      ctx: scoped,
      agents: scoped.get('agents'),
      attachments: scoped.get('attachments'),
      commands: scoped.get('commands'),
      approval: scoped.get('approval'),
      port: scoped.get('webServer')?.port,
      config,
      log,
    }).catch((err) => log(`运行异常: ${err?.stack ?? err}`))
  })
}

async function run({ ctx, agents, attachments, commands, approval, port, config, log }) {
  if (!agents || !port) {
    log('缺少 agents / webServer 服务，中止')
    return
  }

  const rpc = new Rpc(`http://127.0.0.1:${port}`)
  log(
    `服务检查: agents=${!!agents} attachments=${!!attachments} commands=${!!commands} ` +
      `commands.list=${typeof commands?.list} commands.execute=${typeof commands?.execute} port=${port}`,
  )

  // 先把这个工作目录注册成工作区，否则会话在界面上会落进"未分组"
  void ensureWorkspace()

  // ---------- 会话映射 ----------
  /**
   * 绑定表：userId -> { sessionId, mode }
   *
   * mode 决定这个会话该怎么接待 QQ：
   *   'auto'   插件自己建的管家会话。注入行为契约与人格、注册 qq_* 工具、
   *            把审批关掉（QQ 上没人能点）。会话是插件的一次性产物。
   *   'attach' 遥控。绑到用户在网页里已有的会话上：那个会话有自己的提示词、
   *            自己的人格、自己的审批策略，插件一个字节都不许注入，只做
   *            镜像转发（过程文字和执行结果都送到 QQ）。
   *
   * 旧版本存的是 userId -> sessionId 的纯字符串，读进来一律按 auto 迁移；
   * 老数据里不可能有遥控绑定，所以这样判断是安全的。
   */
  let sessions = {}
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
      for (const [uid, v] of Object.entries(raw ?? {})) {
        if (typeof v === 'string' && v) {
          sessions[uid] = { sessionId: v, mode: 'auto' }
        } else if (v && typeof v === 'object' && v.sessionId) {
          sessions[uid] = {
            sessionId: String(v.sessionId),
            mode: v.mode === 'attach' ? 'attach' : 'auto',
          }
        }
      }
    }
  } catch (err) {
    log(`读取会话映射失败，按空处理: ${err?.message ?? err}`)
    sessions = {}
  }
  const saveSessions = () => {
    try {
      mkdirSync(dirname(SESSIONS_FILE), { recursive: true })
      writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8')
    } catch (err) {
      log(`保存会话映射失败: ${err?.message ?? err}`)
    }
  }
  const boundOf = (userId) => sessions[userId] ?? null
  const boundId = (userId) => sessions[userId]?.sessionId ?? null
  const isAttached = (userId) => sessions[userId]?.mode === 'attach'
  /** 写绑定；sessionId 传 null 表示解除。唯一改 sessions 的入口。 */
  const bindTo = (userId, sessionId, mode) => {
    if (!sessionId) delete sessions[userId]
    else sessions[userId] = { sessionId: String(sessionId), mode: mode === 'attach' ? 'attach' : 'auto' }
    saveSessions()
  }
  log(
    `已有会话映射: ${Object.keys(sessions).length} 个` +
      (Object.keys(sessions).length
        ? `（${Object.entries(sessions)
            .map(([u, v]) => `${u}:${v.mode}`)
            .join(', ')}）`
        : ''),
  )

  // ---------- OneBot ----------
  let bot = null
  const disposers = [] // 设置页路由的清理函数
  const send = async (userId, text) => {
    if (!bot?.connected) {
      log('发送失败：OneBot 未连接')
      return
    }
    try {
      await bot.sendPrivate(userId, text)
    } catch (err) {
      log(`发送给 ${userId} 失败: ${err?.message ?? err}`)
    }
  }

  const live = new Map() // sessionId -> { userId, texts, sentCount }
  const promptApplied = new Set() // 工具与审批已经装配过的会话
  const promptEffects = new Map() // sessionId -> { text, persona, disposers[] } 提示词注册，可热更新
  const qqInjections = new Map() // sessionId -> { cleanups[], priorPolicy } 工具/审批注入，可撤销
  const pendingRename = new Map() // sessionId -> 第一轮结束后要改成的标题
  let workspaceId = null // QQ 会话所属的工作区；建会话时要带上

  /**
   * 把工作目录注册成 DSH 的「工作区」，并记住它的 id。
   *
   * 光是目录存在还不够：界面按 workspace.sessionIds 分组，
   * 不把会话建在这个工作区里，它就会落到"未分组"。
   * 已存在时 workspace/create 返回 created:false 并带回同一个 workspace 对象，所以幂等。
   */
  async function ensureWorkspace() {
    const ws = config.workspace || FALLBACK_WORKSPACE
    try {
      // 首次运行目录还不存在，先建出来——否则 workspace/create 和建会话都会失败
      if (!existsSync(ws)) {
        mkdirSync(ws, { recursive: true })
        log(`工作目录不存在，已创建：${ws}`)
      }
    } catch (err) {
      log(`创建工作目录失败: ${err?.message ?? err}`)
    }
    try {
      const r = await rpc.call('workspace/create', { path: ws, title: 'QQ' })
      workspaceId = r?.workspace?.workspaceId ?? null
      if (r?.created) log(`已把 ${ws} 注册为工作区（workspaceId=${workspaceId}）`)
      else log(`工作区已存在: ${ws}（workspaceId=${workspaceId}）`)
    } catch (err) {
      log(`注册工作区失败（不影响使用）: ${err?.message ?? err}`)
    }
  }

  /**
   * 从模型可见的工具清单里拿掉一个工具。
   *
   * 关键是那条 `unknown global tool`：这个壳子里**本来就没装**那个工具时会抛它。
   * 那不是失败，正是我们想要的结果——工具本来就不在，模型照样调不到。
   * 以前它会以"失败"的名义写进日志，天天一行，真出事的时候反而看不出真假。
   *
   * @param {object} scoped agent 的 ctx
   * @param {string} name 工具名
   * @param {string} prefix 日志前缀（遥控模式用）
   * @returns {Function|null} 撤销函数；没装上或不适用时返回 null
   */
  function denyTool(scoped, name, prefix = '') {
    try {
      const d = scoped.tools?.restrict?.({ deny: [name] })
      if (typeof d !== 'function') {
        log(`${prefix}这个壳子没有 restrict，${name} 跳过（可能压根没装）`)
        return null
      }
      log(`${prefix}已禁用 ${name}（QQ 端无应答者，会死锁）`)
      return d
    } catch (err) {
      const msg = `${err?.message ?? err}`
      if (msg.includes('unknown global tool')) {
        log(`${prefix}${name} 本来就不在这个壳子里，跳过（效果相同：模型调不到）`)
        return null
      }
      log(`${prefix}禁用 ${name} 失败: ${msg}`)
      return null
    }
  }

  /**
   * 装配 QQ 专用能力。两种模式差别极大，别混：
   *
   *   管家（auto）  插件自己建的会话，什么都由插件提供：行为契约与人格
   *                （来自配置）、qq_* 工具、审批 never。会话是消耗品，
   *                /new 就换一个。
   *   遥控（attach）用户自己的会话，插件只是「远程显示器 + 键盘」：
   *                一个字节都不注入，只把它的输出转到 QQ、把 QQ 的话
   *                塞进它的收件箱。它的性格、工具、审批都归它自己。
   *
   * 必须注册在 agent 自己的 ctx 上——注册到根 ctx 会影响网页端所有会话。
   * 这些注册都是 Cordis effect，agent 上下文销毁时自动回收。
   */
  function applyQqSession(sessionId, agent, userId) {
    const scoped = agent?.ctx
    if (!scoped) {
      log('agent.ctx 不存在，跳过 QQ 专用能力装配')
      return
    }

    // 遥控模式：目标会话是用户自己在网页里用的那个，有自己的提示词和人格，
    // 插件一个字节都不注入，只做镜像转发（在 turn/end 与 assistant/message 里）。
    // 模式变了（管家 ←→ 遥控）就先把上一套整套撤掉，免得两种挂载叠在一起。
    const attach = isAttached(userId)
    const mounted = qqInjections.get(sessionId)
    if (mounted && mounted.mode !== (attach ? 'attach' : 'auto')) {
      log(`会话 ${sessionId} 的挂载方式要从 ${mounted.mode} 改成 ${attach ? 'attach' : 'auto'}，先整套撤销`)
      releaseQqSession(sessionId)
    }

    if (attach) {
      // 之前按管家模式注入过的提示词层也要撤：换绑到同一个会话时可能残留
      const stale = promptEffects.get(sessionId)
      if (stale) {
        for (const dispose of stale.disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
        promptEffects.delete(sessionId)
        log(`遥控模式：已撤掉会话 ${sessionId} 上残留的管家提示词层`)
      }
      if (promptApplied.has(sessionId)) return
      promptApplied.add(sessionId)

      // 只留一条硬约束：提问工具在 QQ 上没有应答者，一调就永久挂起。
      // 这个会话在网页里也许有人在看，但 QQ 这边等不到回答，宁可不给。
      const cleanups = []
      const dq = denyTool(scoped, 'ask_user_question', '遥控模式：')
      if (dq) cleanups.push(dq)
      // 审批策略**不动**：这是用户自己的会话，他可能就在电脑前，顺手在网页上点了。
      // 强改成 never 会把"能用"的会话变成"处处被拒"。真需要远程决策，
      // 得等「审批转发」做出来——那是另一件事，不能拿改策略凑合。
      qqInjections.set(sessionId, { cleanups, priorPolicy: null, mode: 'attach' })
      log('遥控模式已挂载：不注入提示词、不注册 qq_* 工具、审批策略保持原样')
      return
    }

    // ① 系统提示（两层）。提示词允许热改，所以这里不能"一次性"：
    //    NamedEntries 同名重复注册会抛错，必须先释放旧注册再挂新的。
    //    因此记住"上次挂的是什么文本"，变了就重挂；没变就不动，免得每轮抖动。
    //
    //    位置有讲究：agent preset 里的责任段叫 deployment:persona-prefix，order = 0。
    //      · qq-chat-mode 走 -90，排在契约【之前】——它是"没装 preset 时的退路"，
    //        界面上已经没有入口，只有手改 JSON 的人才会用到。
    //      · qq-persona 走 10，排在契约【之后】——人设是追加，不是覆盖，
    //        而且每轮注入，改完下一条消息就生效，已经存在的会话也跟着变。
    const text = String(config.qqSystemPrompt ?? '').trim()
    const persona = String(config.qqPersona ?? '').trim()
    const prev = promptEffects.get(sessionId)
    const unchanged = prev && prev.text === text && prev.persona === persona

    if (!unchanged) {
      if (prev) {
        for (const dispose of prev.disposers) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
      const disposers = []
      if (text) {
        try {
          const d = scoped.systemPrompt.section({ name: 'qq-chat-mode', order: -90, text })
          if (typeof d === 'function') disposers.push(d)
          log(`${prev ? '已更新' : '已注入'} QQ 行为规则（${text.length} 字）`)
        } catch (err) {
          log(`注入 QQ 行为规则失败: ${err?.message ?? err}`)
        }
      }
      if (persona) {
        try {
          const d = scoped.systemPrompt.section({ name: 'qq-persona', order: 10, text: persona })
          if (typeof d === 'function') disposers.push(d)
          log(`${prev ? '已更新' : '已注入'} QQ 人格（${persona.length} 字）`)
        } catch (err) {
          log(`注入 QQ 人格失败: ${err?.message ?? err}`)
        }
      } else if (prev?.persona) {
        log('qqPersona 已清空，人格层已撤掉')
      }
      promptEffects.set(sessionId, { text, persona, disposers })
    }

    // 工具与审批只在第一次装配；上面那层提示词更新不受这里影响
    if (promptApplied.has(sessionId)) return
    promptApplied.add(sessionId)

    // ② 工具
    if (!scoped.tools?.register) {
      log('agent.ctx 上没有 tools，跳过工具注册')
      return
    }

    const guardPath = (p) => {
      const s = String(p ?? '').trim()
      if (!s) return { error: '需要提供文件路径' }
      if (!isAbsolute(s)) return { error: `必须是绝对路径：${s}` }
      if (!existsSync(s)) return { error: `文件不存在：${s}` }
      return { path: s }
    }

    const sendImage = defineTool({
      name: 'qq_send_image',
      description:
        '把一张本机图片发给当前 QQ 用户（对方在手机上）。用于展示截图、图表、渲染结果。' +
        '只在确实需要"看"的时候用；纯文字能说清的不要发图。',
      parameters: {
        path: { type: 'string', required: true, description: '图片文件的绝对路径，支持 png/jpg/gif/webp' },
        caption: { type: 'string', description: '可选的一句说明，先发文字再发图' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => [{ type: 'text', text: v?.ok ? `已发送图片（${v.bytes} 字节）` : `发送失败：${v?.error}` }],
      },
      execute: async (args) => {
        const g = guardPath(args.path)
        if (g.error) return { ok: false, error: g.error }
        let buf
        try {
          buf = readFileSync(g.path)
        } catch (err) {
          return { ok: false, error: `读取失败：${err?.message ?? err}` }
        }
        if (buf.length > 8 * 1024 * 1024) return { ok: false, error: '图片超过 8MB' }
        const mt = sniffMediaType(buf)
        if (!mt) return { ok: false, error: '不是可识别的图片格式' }
        if (!bot?.connected) return { ok: false, error: 'QQ 通道未连接（NapCat 没在运行？）' }
        if (args.caption) await send(userId, String(args.caption).slice(0, 300))
        try {
          const res = await bot.call('send_private_msg', {
            user_id: Number(userId),
            message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}` } }],
          })
          log(`已发送图片 ${g.path} (${buf.length} 字节)`)
          return { ok: true, bytes: buf.length, mediaType: mt, messageId: res?.message_id ?? null }
        } catch (err) {
          return { ok: false, error: `${err?.message ?? err}` }
        }
      },
    })

    const sendFile = defineTool({
      name: 'qq_send_file',
      description:
        '把一个本机文件发给当前 QQ 用户。用于交付报告、表格、代码、日志等。' +
        '比贴大段文本更适合——手机上好保存。',
      parameters: {
        path: { type: 'string', required: true, description: '文件的绝对路径' },
        caption: { type: 'string', description: '可选的一句说明，先发文字再发文件' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => [{ type: 'text', text: v?.ok ? `已发送文件 ${v.name}（${v.bytes} 字节）` : `发送失败：${v?.error}` }],
      },
      execute: async (args) => {
        const g = guardPath(args.path)
        if (g.error) return { ok: false, error: g.error }
        let size
        try {
          size = statSync(g.path).size
        } catch (err) {
          return { ok: false, error: `读取失败：${err?.message ?? err}` }
        }
        if (size > 100 * 1024 * 1024) return { ok: false, error: '文件超过 100MB' }
        if (!bot?.connected) return { ok: false, error: 'QQ 通道未连接（NapCat 没在运行？）' }
        if (args.caption) await send(userId, String(args.caption).slice(0, 300))
        try {
          const res = await bot.call(
            'upload_private_file',
            { user_id: Number(userId), file: g.path, name: basename(g.path) },
            120_000,
          )
          log(`已发送文件 ${g.path} (${size} 字节)`)
          return { ok: true, bytes: size, name: basename(g.path), fileId: res?.file_id ?? null }
        } catch (err) {
          return { ok: false, error: `${err?.message ?? err}` }
        }
      },
    })

    // 说话要走工具：这样"说什么、分几条、什么时候说"由模型显式决定，
    // 而不是靠系统提示里的一句嘱咐。参考 qq-bridge 二代仿真的做法。
    const sendMessage = defineTool({
      name: 'qq_send_message',
      description:
        '把要说的话发给当前 QQ 用户。**你想让用户看到的所有内容都必须通过这个工具发出——' +
        '你的普通文本输出不会传到 QQ。** messages 是字符串数组，一个元素一条消息：' +
        '想说三句就给三个元素，用户会收到三条。\n' +
        '建议的节奏：接到任务先发一条确认（例如"收到，我看一下"），' +
        '中途有值得说的进展就发一条，最后把结论发出来。不要攒到最后一次性发完。',
      parameters: {
        messages: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '要发送的消息，一条一个元素。一次 1-5 条为宜，每条 1-3 句。',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, v) => [{ type: 'text', text: v?.ok ? `已发送 ${v.count} 条消息` : `发送失败：${v?.error}` }],
      },
      execute: async (args) => {
        const list = Array.isArray(args?.messages) ? args.messages : [args?.messages]
        const cleaned = list.map((s) => String(s ?? '').trim()).filter(Boolean)
        if (cleaned.length === 0) return { ok: false, error: 'messages 为空' }
        if (!bot?.connected) return { ok: false, error: 'QQ 通道未连接（NapCat 没在运行？）' }

        let count = 0
        for (const one of cleaned) {
          const plain = config.behavior.convertMarkdown ? mdToPlain(one) : one
          if (!plain) continue
          for (const part of chunkText(plain, config.behavior.sendChunkSize)) {
            await send(userId, part)
            count += 1
          }
          await sleep(150) // 别让几条消息挤在一起，QQ 端会乱序
        }
        const st = live.get(sessionId)
        if (st) st.usedTool = true
        log(`模型主动发送 ${count} 条消息`)
        return { ok: true, count }
      },
    })

    // 记住每一项注册的 disposer，解绑时要能逐项撤销
    const cleanups = []

    for (const [label, factory] of [
      ['qq_send_message', sendMessage],
      ['qq_send_image', sendImage],
      ['qq_send_file', sendFile],
    ]) {
      try {
        const d = scoped.tools.register(factory)
        if (typeof d === 'function') cleanups.push(d)
        log(`已注册工具 ${label}`)
      } catch (err) {
        log(`注册工具 ${label} 失败: ${err?.message ?? err}`)
      }
    }

    // ③ 硬约束：把会造成死锁的东西从机制上关掉
    // 提问工具在 QQ 上没有应答者，一调就永久挂起。提示词只是软约束，
    // restrict 会让它从模型可见的工具清单里彻底消失——想调也调不到。
    const dq = denyTool(scoped, 'ask_user_question')
    if (dq) cleanups.push(dq)

    // 审批同理：需要审批的操作在 QQ 上会卡死。政策设成 never 之后，
    // DSH 会直接拒绝这类操作，并把「审批已禁用」自动写进模型可见的提示里，
    // 模型就不会再尝试申请提权。
    //
    // 注意：审批策略是**会话事件**，不是 Cordis effect，不会被自动回收。
    // 所以要记下原来的策略，解绑时恢复——否则解绑之后那条会话仍然是 never。
    let priorPolicy = null
    try {
      priorPolicy = typeof approval.effectivePolicy === 'function' ? approval.effectivePolicy(agent.session) : 'ask'
      approval.setPolicy(agent, 'never')
      log(`已把审批政策设为 never（原来是 ${priorPolicy ?? '(未知)'}）`)
    } catch (err) {
      log(`设置审批政策失败: ${err?.message ?? err}`)
    }

    qqInjections.set(sessionId, { cleanups, priorPolicy, mode: 'auto' })

    // 证据：把当前会话真正可见的工具列出来。
    // 模型看到的不是"提示词里的说明"，而是每次请求附带的 function schema。
    // 注意 schemas() 必须传 agent 作用域，不传参返回的是别的东西（会误导）。
    try {
      const raw = scoped.tools.schemas(agent) ?? []
      const list = Array.isArray(raw) ? raw : Object.values(raw)
      const names = list
        .map((s) => s?.name ?? s?.function?.name ?? s?.schema?.name)
        .filter(Boolean)
      log(`会话可见工具 ${names.length} 个: ${names.join(', ')}`)
      for (const n of names) {
        if (String(n).startsWith('qq_')) log(`  ↑ 插件贡献的: ${n}`)
      }
    } catch (err) {
      log(`读取工具列表失败: ${err?.message ?? err}`)
    }
  }

  /**
   * 撤销某个会话上的 QQ 注入：提示词、三个工具、提问工具禁用、审批策略。
   *
   * 提示词和工具都是 Cordis effect，本来会在 agent 销毁时自动回收；但
   * **绑定切走之后那个会话还在**，所以必须主动释放。审批策略更特殊——
   * 它是会话事件，永远不会自动回收，只能显式写回原值。
   *
   * @returns {boolean} 有没有真的撤销掉什么
   */
  function releaseQqSession(sessionId) {
    if (!sessionId) return false
    let didSomething = false

    // 提示词
    const pe = promptEffects.get(sessionId)
    if (pe) {
      for (const dispose of pe.disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      promptEffects.delete(sessionId)
      didSomething = true
    }

    // 工具 / restrict / 审批
    const inj = qqInjections.get(sessionId)
    if (inj) {
      for (const dispose of inj.cleanups) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
      qqInjections.delete(sessionId)
      promptApplied.delete(sessionId)
      didSomething = true

      const agent = agents.get(sessionId)
      if (agent && inj.priorPolicy && inj.priorPolicy !== 'never') {
        try {
          approval.setPolicy(agent, inj.priorPolicy)
          log(`已恢复会话 ${sessionId} 的审批策略为 ${inj.priorPolicy}`)
        } catch (err) {
          log(`恢复审批策略失败: ${err?.message ?? err}`)
        }
      }
    }

    if (didSomething) log(`已撤销会话 ${sessionId} 上的 QQ 注入`)
    return didSomething
  }

  /**
   * 取 plugin.log 的末尾若干行，供设置页查看。
   * 轮转把文件压在 5MB 以内，所以整文件读入再切尾是安全的。
   */
  function readLogTail(lines = 200) {
    const n = Math.max(1, Math.min(2000, Number(lines) || 200))
    try {
      if (!existsSync(LOG_FILE)) return { ok: true, lines: [], sizeKB: 0 }
      const text = readFileSync(LOG_FILE, 'utf8')
      return {
        ok: true,
        lines: text.split('\n').slice(-n),
        sizeKB: Math.round(Buffer.byteLength(text) / 1024),
        path: LOG_FILE,
      }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  // ---------- 回复回流 ----------
  ctx.on('session/event', (session, event) => {
    const sid = session?.id ?? session?.header?.id
    if (!sid) return
    const st = live.get(sid)
    if (!st) return

    // 遥控模式下审批是最阴的坑：策略保持原样，真触发了没人通知，
    // QQ 这边就是一片死寂，看起来像卡死了。这里只**提醒**，不做决定——
    // 决定要回网页上点。完整的「审批转发」（QQ 里回一句就批准）还没做。
    // 管家模式不会走到这里：那里审批策略被设成 never，ask 事件根本不会发生。
    if (event?.type === 'approval/asked') {
      const d = event.data ?? {}
      log(`会话 ${sid} 在等审批：${d.toolName ?? '?'}（${d.reason ?? '没说原因'}）`)
      send(
        st.userId,
        [
          `⚠️ 这一步要你批准：${d.toolName ?? '某个操作'}`,
          d.reason ? d.reason : '',
          '这条只是提醒，批准得回网页上点。',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return
    }

    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content ?? []
      const raw = content
        .filter((p) => p?.type === 'text' && p.text)
        .map((p) => p.text)
        .join('')
        .trim()
      const text = raw ? (config.behavior.convertMarkdown ? mdToPlain(raw) : raw) : ''
      // 该怎么送，交给纯函数决定（lib/delivery.js，单测钉住了每种组合）
      const plan = planAssistantText({
        attach: st.attach,
        hasToolCall: content.some((p) => p?.type === 'tool-call'),
        text,
      })
      if (plan.action === 'send') {
        st.sentAny = true
        for (const part of chunkText(plan.text, config.behavior.sendChunkSize)) send(st.userId, part)
      } else if (plan.action === 'reset') {
        st.texts.length = 0
      } else if (plan.action === 'collect') {
        st.texts.push(plan.text)
      }
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason?.kind
      const tail = st.texts.join('\n')
      const plan = planTurnEnd({ usedTool: st.usedTool, sentAny: st.sentAny, tail, reason })
      if (plan.action === 'relay') {
        // 模型这一轮压根没用 qq_send_message 说过话 —— 这段是唯一能到用户手上的东西
        for (const part of chunkText(plan.text, config.behavior.sendChunkSize)) send(st.userId, part)
        log(`兜底转发收尾文字 ${plan.text.length} 字（本轮没用 qq_send_message）`)
      } else if (plan.action === 'placeholder') {
        // 整轮既没说话也没用工具：给个占位，别让用户对着空气等
        send(st.userId, placeholderFor(reason))
      }
      log(
        `回合结束 ${sid} reason=${reason} 文本块=${st.texts.length} 用过工具=${st.usedTool} ` +
          `收尾=${plan.action}${plan.action === 'none' && tail ? `（丢弃 ${tail.length} 字）` : ''} ` +
          `遥控=${!!st.attach}`,
      )
      lastDoneAt = Date.now()
      live.delete(sid)

      // 新建的 QQ 会话在第一轮结束后固定改名，方便在会话列表里认出来
      if (pendingRename.has(sid)) {
        const title = pendingRename.get(sid)
        pendingRename.delete(sid)
        rpc.call('session/rename', { sessionId: sid, title }).then(
          () => log(`会话已改名为「${title}」`),
          (err) => log(`改名失败: ${err?.message ?? err}`),
        )
      }
    }
  })

  // ---------- 会话创建 ----------
  /**
   * 解析出这次该用哪个会话，并尽量把它变成"活的"。
   *
   * 重启后持久化会话不在进程内的 agent 注册表里，`agents.get()` 必然拿不到；
   * 要把它装回去，只有「显式 resume 会话」的 RPC 才有效。按 DSH 源码语义：
   *   session/rename      — "Rename one Session after explicitly resuming it"（会唤醒，且不开回合）
   *   session/prompt      — "Admit one prompt after explicitly resuming its Session"（会唤醒，但直接开一轮）
   *   session/projections — "Read all registered projections without activating an Agent"（只读，不会唤醒）
   * 所以这里用 rename 唤醒，同时顺手把标题改成机器人号。
   *
   * 注意：session/create 带 sessionId 内部确实会走 agents.resume，但前提是 cwd 与
   * 持久化 header 里的 cwd 完全一致，对不上会报 session/conflict，不适合当唤醒手段。
   *
   * 实在唤不醒就退回 RPC 投递（session/prompt）：那一轮没有 qq_* 工具，回复只能靠
   * 兜底自动转发，但能借它把会话 resume 起来，下一轮恢复正常。
   *
   * @returns {{ sessionId: string, agent: object|null, isNew: boolean }}
   */
  /**
   * 唤醒一个持久化会话（显式 resume，不开回合）。
   *
   * 只能用 `session/rename` —— 它是唯一"resume 后不开回合"的 RPC。
   * 但它的副作用是**改标题**，对用户自己建的会话是破坏性的（会造出好几个同名会话）。
   * 所以这里一律用**当前标题**去 rename：目的只是唤醒，标题一个字都不动。
   *
   * 新会话的命名交给 pendingRename（第一轮结束后按需改），那是另一条路径。
   */
  async function wakeSession(sessionId) {
    let title = null
    try {
      const r = await rpc.call('session/list', {})
      const hit = (r?.items ?? []).find((s) => s.sessionId === sessionId)
      title = hit?.projections?.values?.title ?? null
    } catch (err) {
      log(`唤醒前读标题失败（不影响唤醒）: ${err?.message ?? err}`)
    }
    // titleForWake 保证：有标题就用原来的，绝不覆盖用户起的名字
    await rpc.call('session/rename', { sessionId, title: titleForWake(title, sessionId) })
  }

  async function ensureSession(userId) {
    const known = boundId(userId)
    if (known) {
      let agent = agents.get(known)
      if (!agent) {
        // 唤醒只能用「会显式 resume 会话」的接口。源码注释写得很明确：
        //   session/projections  — "Read all registered projections without activating an Agent"（不会唤醒）
        //   session/rename       — "Rename one Session after explicitly resuming it"（会唤醒）
        //   session/prompt       — "Admit one prompt after explicitly resuming its Session"（会唤醒，但会开一轮）
        try {
          await wakeSession(known)
          agent = agents.get(known)
          if (agent) log(`会话 ${known} 已唤醒`)
        } catch (err) {
          log(`唤醒会话 ${known} 失败: ${err?.message ?? err}`)
        }
      }
      if (agent) return { sessionId: known, agent, isNew: false }
      log(`会话 ${known} 唤不醒，本轮改用 RPC 投递`)
      return { sessionId: known, agent: null, isNew: false }
    }

    try {
      mkdirSync(FALLBACK_WORKSPACE, { recursive: true })
    } catch {
      /* ignore */
    }
    // session.create 里 workspaceId 和 cwd 是二选一的：
    // 给 workspaceId 时 cwd 由工作区推导。带上 workspaceId 会话才会归到分组里。
    const base = workspaceId ? { workspaceId } : { cwd: config.workspace || FALLBACK_WORKSPACE }
    let created
    try {
      created = await rpc.createSession({ ...base, agentPreset: QQ_AGENT_PRESET })
    } catch (err) {
      const msg = `${err?.message ?? err}`
      // preset 没装上（老版本 DSH、或 bundle patch 没生效）：降级成默认壳子。
      // 宁可没有管家人格，也不能让 QQ 完全用不了。
      if (!msg.includes('agent-preset')) throw err
      log(`preset「${QQ_AGENT_PRESET}」不可用（${msg}），本次改用默认 preset`)
      created = await rpc.createSession(base)
    }
    const sid = created.sessionId
    bindTo(userId, sid, 'auto')
    log(`为 QQ ${userId} 新建管家会话 ${sid} (preset=${created.agentPreset ?? '默认'})`)
    // 标题要等第一轮跑完再改：标题是「首条消息生成」的，先改会被覆盖。
    // 只有插件自己新建的会话才命名，已有会话一律不动。
    pendingRename.set(sid, titleForNewSession(bot?.selfId, userId))
    return { sessionId: sid, agent: agents.get(sid) ?? null, isNew: true }
  }

  /** 把 OneBot 的 image 段取成 base64。 */
  async function fetchImage(data) {
    const file = data?.file
    if (!file) return null
    try {
      const res = await bot.call('get_image', { file })
      const got = res?.file ?? res

      /** 统一把「本地路径 / base64 / URL」转成 base64 内容段。 */
      const fromAny = (value) => {
        if (typeof value !== 'string') return null
        if (value.startsWith('base64://')) {
          const b64 = value.slice('base64://'.length)
          const buf = Buffer.from(b64, 'base64')
          const mt = sniffMediaType(buf)
          return mt ? { mediaType: mt, data: b64, size: buf.length } : { error: '无法识别图片格式' }
        }
        let p = value
        if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7))
        // NapCat 常返回 QQ 客户端的本地缓存路径，直接读盘最快
        if (existsSync(p)) {
          const buf = readFileSync(p)
          const mt = sniffMediaType(buf)
          if (!mt) return { error: '无法识别图片格式' }
          return { mediaType: mt, data: buf.toString('base64'), size: buf.length }
        }
        if (p.startsWith('http://') || p.startsWith('https://')) {
          return { error: `返回了远程 URL，暂不支持下载: ${p.slice(0, 80)}` }
        }
        return { error: `返回的路径不存在: ${p.slice(0, 120)}` }
      }

      const one = fromAny(got)
      if (one) return one
      if (res?.base64) {
        const buf = Buffer.from(res.base64, 'base64')
        const mt = sniffMediaType(buf)
        return mt
          ? { mediaType: mt, data: res.base64, size: buf.length }
          : { error: '无法识别图片格式' }
      }
      return { error: `get_image 返回形状未知: ${JSON.stringify(res).slice(0, 160)}` }
    } catch (err) {
      return { error: `get_image 调用失败: ${err?.message ?? err}` }
    }
  }

  // ---------- 指令 ----------
  const allowSet = new Set((config.whitelist ?? []).map(String))
  if (allowSet.size === 0 && !config.allowAllWhenEmpty) {
    log('⚠️ 白名单为空且 allowAllWhenEmpty=false —— 不会响应任何消息')
  }

  const seen = new Map()
  const isDup = (id) => {
    if (id == null) return false
    const k = String(id)
    if (seen.has(k)) return true
    seen.set(k, Date.now())
    if (seen.size > 200) {
      const cutoff = Date.now() - 600_000
      for (const [kk, t] of seen) if (t < cutoff) seen.delete(kk)
    }
    return false
  }

  const buffered = new Map()

  /**
   * 投递一条消息给 agent。
   * @param {string} userId
   * @param {Array|string} content 文本或内容段数组
   * @param {string} label 日志里显示的摘要
   */
  async function deliver(userId, content, label) {
    const { sessionId, agent, isNew } = await ensureSession(userId)

    // 组装内容段（[QQ] 前缀）。图片保持"编码态"，走哪条路由哪边决定怎么准入。
    let parts = (typeof content === 'string' ? [{ type: 'text', text: content }] : content).map((p) => ({ ...p }))

    // 给文本加 [QQ] 前缀：模型据此知道"这句话是人从手机上说的"。
    // 管家模式下它还暗示回复要走 qq_send_message；遥控模式下那个工具根本不存在，
    // 前缀就只是个来源标记。不想要就把 behavior.promptPrefix 清空。
    const prefix = String(config.behavior.promptPrefix ?? '')
    if (prefix) {
      const firstText = parts.find((p) => p?.type === 'text')
      if (firstText) firstText.text = prefix + firstText.text
      else parts.unshift({ type: 'text', text: prefix.trim() })
    }

    live.set(sessionId, {
      userId,
      texts: [],
      sentCount: 0,
      usedTool: false,
      sentAny: false,
      attach: isAttached(userId),
    })

    if (agent) {
      // ── 正常路径：in-process 投递（管家模式带 qq_* 工具，遥控模式没有）
      applyQqSession(sessionId, agent, userId)

      // 图片必须先过附件准入，变成 attachment 引用；直接塞裸 base64 会让 LLM 传输失败
      if (parts.some((p) => p?.type === 'image')) {
        if (!attachments) {
          live.delete(sessionId)
          send(userId, '这个实例没有附件服务，图片发不了。')
          log('缺少 attachments 服务，图片无法准入')
          return
        }
        try {
          parts = await attachments.admitPromptContent(parts)
          log(`附件准入成功，内容段=${parts.map((p) => p.type).join(',')}`)
        } catch (err) {
          live.delete(sessionId)
          log(`附件准入失败: ${err?.message ?? err}`)
          send(userId, `图片处理失败：${err?.message ?? err}`)
          return
        }
      }

      log(`→ [${userId}] ${label}${isNew ? ' [新会话]' : ''}`)
      agent.followup(makeUserMessage(parts))
      return
    }

    // ── 兜底路径：会话唤不醒，交给 DSH 用 RPC 投递（它会顺便 resume）。
    // 这一轮没有 qq_* 工具，也没有 QQ 系统提示，回复会走兜底转发（单条）。
    // 下一轮会话就活了，恢复正常。
    log(`→ [${userId}] ${label}（RPC 投递，本轮无 QQ 工具）`)
    try {
      await rpc.call('session/prompt', {
        sessionId,
        requestId: `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: 'queue',
        content: parts,
      })
    } catch (err) {
      live.delete(sessionId)
      log(`RPC 投递失败: ${err?.stack ?? err}`)
      send(userId, `投递失败：${err?.message ?? err}`)
    }
  }

  const buffer = (userId, text) => {
    let e = buffered.get(userId)
    if (e) {
      e.parts.push(text)
      clearTimeout(e.timer)
    } else {
      e = { parts: [text], timer: null }
      buffered.set(userId, e)
      if (config.behavior.ackMessage) send(userId, config.behavior.ackMessage)
    }
    e.timer = setTimeout(() => {
      buffered.delete(userId)
      const merged = e.parts.join('\n')
      log(`合并 ${e.parts.length} 条 → 一轮（${merged.length} 字）`)
      deliver(userId, merged, merged.slice(0, 60)).catch((err) => log(`处理失败: ${err?.stack ?? err}`))
    }, config.behavior.coalesceWindowMs)
  }

  /**
   * 解析「引用回复」：reply 段只有被引用那条的 message_id，内容要另外问。
   * 拿不到就当没有引用，不影响正文。
   */
  async function resolveReply(messageId) {
    if (!messageId) return null
    try {
      const res = await bot.call('get_msg', { message_id: messageId }, 8000)
      const line = formatQuotedMessage(res)
      if (line) log(`引用已解析：${line.slice(0, 60)}`)
      return line
    } catch (err) {
      log(`get_msg 失败: ${err?.message ?? err}`)
      return null
    }
  }

  /** 把合并转发的聊天记录拍平成文本。 */
  async function resolveForward(id) {
    try {
      const res = await bot.call('get_forward_msg', { id }, 60_000)
      const nodes = res?.messages ?? res?.message ?? res?.data?.messages ?? []
      if (!Array.isArray(nodes) || nodes.length === 0) {
        log(`get_forward_msg 返回不含节点: ${JSON.stringify(res).slice(0, 200)}`)
        return null
      }
      const lines = ['【转发的聊天记录】']
      // 节点清单进日志：万一将来某类消息被拍平时丢掉，能一眼看出是哪一种
      log(
        `转发记录节点 ${nodes.length} 个: ${nodes
          .slice(0, 8)
          .map((n) => {
            const s = n?.sender ?? {}
            const who = s.card || s.nickname || s.user_id || '?'
            const segs = Array.isArray(n?.message) ? n.message : Array.isArray(n?.content) ? n.content : []
            return `${who}/${segs.map((x) => x?.type ?? '?').join('+') || typeof n?.message}`
          })
          .join(' | ')}`,
      )
      for (const node of nodes) {
        const s = node?.sender ?? {}
        const who = s.card || s.nickname || String(s.user_id ?? '?')
        const segs = Array.isArray(node?.message)
          ? node.message
          : Array.isArray(node?.content)
            ? node.content
            : []
        const body = segs
          .map((seg) => {
            if (seg?.type === 'text') return seg.data?.text ?? ''
            if (seg?.type === 'image') return '[图片]'
            if (seg?.type === 'face') return '[表情]'
            if (seg?.type === 'at') return `@${seg.data?.qq ?? ''}`
            if (seg?.type === 'forward') return '[嵌套转发]'
            return ''
          })
          .join('')
          .trim()
        if (body) lines.push(`${who}：${body}`)
      }
      return lines.length > 1 ? lines.join('\n') : null
    } catch (err) {
      log(`get_forward_msg 失败: ${err?.message ?? err}`)
      return null
    }
  }

  /**
   * 把 QQ 发来的文件落到工作区的 inbox/ 里，返回本地路径。
   *
   * 文件不走附件准入：模型需要的是"能用工具解析的本地文件"，不是一段二进制。
   * 图片才需要准入，因为模型要真的"看"。
   */
  async function fetchFileToDisk(data) {
    const id = data?.file_id
    const rawName = String(data?.file ?? '').trim() || `qq-file-${Date.now()}`
    const name = rawName.replace(/[\\/:*?"<>|]/g, '_')
    if (!id) return { error: '消息里没有 file_id' }

    const pickBytes = (res) => {
      const got = res?.file ?? res
      if (typeof got === 'string') {
        if (got.startsWith('base64://')) return Buffer.from(got.slice('base64://'.length), 'base64')
        let p = got.startsWith('file://') ? decodeURIComponent(got.slice(7)) : got
        if (existsSync(p)) return readFileSync(p)
      }
      if (res?.base64) return Buffer.from(res.base64, 'base64')
      return null
    }

    let buf = null
    let lastErr = ''

    // 首选 get_file（OneBot 标准动作）
    try {
      const res = await bot.call('get_file', { file_id: id }, 120_000)
      buf = pickBytes(res)
      if (!buf) lastErr = `get_file 返回形状未知: ${JSON.stringify(res).slice(0, 160)}`
    } catch (err) {
      lastErr = `get_file 失败: ${err?.message ?? err}`
    }

    // 退路：拿下载 URL 自己拉
    if (!buf) {
      try {
        const info = await bot.call('get_private_file_url', { file_id: id }, 60_000)
        const url = info?.url ?? info?.file
        if (typeof url === 'string' && url.startsWith('http')) {
          const r = await fetch(url)
          if (r.ok) buf = Buffer.from(await r.arrayBuffer())
          else lastErr += ` / 下载 HTTP ${r.status}`
        } else {
          lastErr += ` / get_private_file_url 无 URL: ${JSON.stringify(info).slice(0, 120)}`
        }
      } catch (err) {
        lastErr += ` / get_private_file_url 失败: ${err?.message ?? err}`
      }
    }

    if (!buf || buf.length === 0) return { error: lastErr || '拿不到文件内容' }

    try {
      const dir = join(config.workspace || FALLBACK_WORKSPACE, 'inbox')
      mkdirSync(dir, { recursive: true })
      const target = join(dir, name)
      writeFileSync(target, buf)
      return { path: target, bytes: buf.length, name }
    } catch (err) {
      return { error: `写盘失败: ${err?.message ?? err}` }
    }
  }

  // ---------- 斜杠命令 ----------
  const startedAt = Date.now()
  let lastDoneAt = null
  let msgCount = 0
  /** /bind 上一次列出来的顺序，编号 → sessionId（手机上手打 id 太苦，用数字回选） */
  const bindPicks = new Map()

  function agoRel(t) {
    if (!t) return '还没有'
    const s = Math.floor((Date.now() - t) / 1000)
    if (s < 60) return `${s} 秒前`
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分前`
  }

  /** 插件自己实现的命令。返回 true 表示已处理，不再往下传。 */
  async function handleLocalCommand(userId, line) {
    const parts = line.slice(1).split(/\s+/)
    const cmd = String(parts[0] ?? '').toLowerCase()

    if (cmd === 'help') {
      // 先确保会话是活的：重启后持久化会话不会自动 resume，
      // 不唤醒就拿不到 agent，命令列表自然也是空的。
      let agent
      try {
        const resolved = await ensureSession(userId)
        agent = resolved.agent
        if (agent) applyQqSession(resolved.sessionId, agent, userId)
      } catch (err) {
        log(`/help 准备会话失败: ${err?.message ?? err}`)
      }
      let dshCmds = []
      try {
        if (agent && commands?.list) {
          dshCmds = commands.list(agent).map((c) => `/${c.name}  ${c.description ?? ''}`)
        }
        log(`/help: agent=${!!agent} commands=${!!commands} 取到 ${dshCmds.length} 个 DSH 命令`)
      } catch (err) {
        log(`列命令失败: ${err?.message ?? err}`)
      }
      await send(
        userId,
        [
          '本地命令：',
          '/status  会话状态、上下文压力、队列',
          '/bind    接进哪个会话（/bind 看列表，/bind 编号 选 = 遥控，/bind auto = 断开重来）',
          '/new     重建会话（上下文清零）',
          '/help    这条帮助',
          '',
          dshCmds.length ? `DSH 命令：\n${dshCmds.join('\n')}` : '（DSH 命令列表不可用）',
        ].join('\n'),
      )
      return true
    }

    if (cmd === 'new' || cmd === 'reset') {
      const oldBind = boundOf(userId)
      if (oldBind?.sessionId) releaseQqSession(oldBind.sessionId)
      bindTo(userId, null)
      const sid = (await ensureSession(userId)).sessionId
      const agent = agents.get(sid)
      if (agent) applyQqSession(sid, agent, userId)
      await send(
        userId,
        [
          '已重建管家会话。',
          `旧：${oldBind ? `${oldBind.sessionId}（${oldBind.mode === 'attach' ? '遥控' : '管家'}）` : '（无）'}`,
          `新：${sid}`,
        ].join('\n'),
      )
      return true
    }

    if (cmd === 'status') {
      const sid = (await ensureSession(userId)).sessionId
      let info = {}
      try {
        const list = await rpc.call('session/list', {})
        const me = (list.items ?? []).find((s) => s.sessionId === sid)
        info = me?.projections?.values ?? {}
      } catch (err) {
        log(`读取状态失败: ${err?.message ?? err}`)
      }
      const p = info.contextPressure ?? {}
      const usage = info.tokenUsage ?? {}
      const pct = p.contextWindow ? ((p.pressureTokens ?? 0) / p.contextWindow) * 100 : null
      const queued = (info.inbox?.['next-turn']?.length ?? 0) > 0
      const cur = boundOf(userId)
      await send(
        userId,
        [
          `会话：${sid}${cur ? `（${cur.mode === 'attach' ? '遥控' : '管家'}）` : ''}`,
          `工作区：${config.workspace || FALLBACK_WORKSPACE}`,
          pct == null ? '上下文：未知' : `上下文：${pct.toFixed(1)}%（${p.pressureTokens ?? 0} / ${p.contextWindow}）`,
          `累计 token：输入 ${usage.uncachedInputTokens ?? 0} / 输出 ${usage.outputTokens ?? 0}`,
          `本次运行收到：${msgCount} 条`,
          `上次完成一轮：${agoRel(lastDoneAt)}`,
          `状态：${queued ? '有排队' : '空闲'}`,
          `桥接已运行：${Math.floor((Date.now() - startedAt) / 60000)} 分钟`,
        ].join('\n'),
      )
      return true
    }

    // /bind —— 在 QQ 上切换绑定的会话（等同设置页那个下拉框）
    if (cmd === 'bind' || cmd === 'switch') {
      const rawArg = String(parts[1] ?? '').trim()
      const arg = rawArg.toLowerCase()
      const { sessions: list, groups, error: listError } = await listSessionsForPicker()
      const binding = boundId(userId)
      log(`/bind arg="${arg}" 候选=${list.length} 分组=${groups.length} 错误=${listError ?? '无'}`)

      if (!arg || arg === 'list') {
        const flat = []
        const lines = []
        const useGroups = groups.length > 0 ? groups : [{ id: '', title: '全部会话', sessions: list }]
        for (const g of useGroups) {
          lines.push(`【${g.title}】`)
          for (const s of g.sessions) {
            flat.push(s.sessionId)
            const short = String(s.sessionId).replace(/^session-/, '').slice(0, 8)
            const mark = s.sessionId === binding ? '  ←当前' : ''
            const kind = s.agentPreset === QQ_AGENT_PRESET ? ' · 管家' : ''
            lines.push(`  ${flat.length}. ${s.title || '(无标题)'} · ${short}${kind}${mark}`)
          }
          const hidden = (g.total ?? g.sessions.length) - g.sessions.length
          if (hidden > 0) lines.push(`  …这个工作区还有 ${hidden} 个没列出`)
        }
        bindPicks.set(userId, flat)
        log(`/bind 列出 ${flat.length} 个会话`)
        const cur = boundOf(userId)
        const bodyText = flat.length
          ? [
              `可切换的会话（只列已归入工作区的，共 ${flat.length} 个）：`,
              ...lines,
              '',
              '回 /bind 编号 切换；/bind auto 断开重来。',
              cur
                ? `当前：${cur.sessionId}（${cur.mode === 'attach' ? '遥控，不注入任何东西' : '管家，插件自己建的'}）`
                : '当前：未绑定（下条消息会新建管家会话）',
            ].join('\n')
          : `没有可选会话${listError ? `（list 接口报错：${listError}）` : ''}——先去网页里建一个，并把它归到某个工作区。`
        // 列表可能很长，按 QQ 的分片上限发
        for (const part of chunkText(bodyText, config.behavior.sendChunkSize)) await send(userId, part)
        return true
      }

      if (arg === 'auto' || arg === 'off' || arg === 'none' || arg === '0') {
        const r = await bindSession(null)
        bindPicks.delete(userId)
        await send(userId, (r?.notes ?? ['已解除绑定']).join('\n'))
        return true
      }

      let target = null
      if (/^\d+$/.test(arg)) {
        let picks = bindPicks.get(userId) ?? []
        // 没先看列表也能直接用编号：拿这次刚查到的列表重建一遍
        if (picks.length === 0) {
          picks = list.map((s) => s.sessionId)
          bindPicks.set(userId, picks)
          log(`/bind 编号无缓存，按本次列表重建 ${picks.length} 项`)
        }
        target = picks[Number(arg) - 1] ?? null
        log(`/bind 选第 ${arg} 项 → ${target ?? '越界'}（候选 ${picks.length}）`)
        if (!target) {
          await send(userId, `没有第 ${arg} 项（当前列表 ${picks.length} 个）。先发 /bind 看列表。`)
          return true
        }
      } else {
        const probe = rawArg.replace(/^session-/, '').toLowerCase()
        const hits = list.filter((s) => String(s.sessionId).toLowerCase().includes(probe))
        if (hits.length === 1) target = hits[0].sessionId
        else if (hits.length > 1) {
          await send(userId, `有 ${hits.length} 个会话都匹配「${rawArg}」，多打几位，或者先 /bind 看编号。`)
          return true
        } else {
          await send(userId, `没找到会话「${rawArg}」。先发 /bind 看列表。`)
          return true
        }
      }

      const r = await bindSession(target)
      bindPicks.delete(userId)
      if (!r?.ok) {
        await send(userId, `切换失败：${r?.error ?? '未知原因'}`)
        return true
      }
      const label = r.mode === 'auto' ? '管家' : '遥控'
      await send(
        userId,
        [
          ...(r.notes ?? []),
          `当前会话：${target}（${label}）`,
          r.mode === 'auto'
            ? '这条会话自带管家人格，行为和新建的管家会话一样。'
            : '这个会话不会再被塞 QQ 专用提示或工具，它的输出原样转到 QQ。',
          '要断开就回 /bind auto，下条消息重新建管家会话。',
        ].join('\n'),
      )
      return true
    }

    return false
  }

  /** 不是本地命令的，交给 DSH 的 command runtime。 */
  async function runDshCommand(userId, line) {
    const resolved = await ensureSession(userId)
    const sessionId = resolved.sessionId
    const agent = resolved.agent
    if (!agent) {
      await send(userId, '会话还没唤醒，命令没执行。再发一次通常就好了。')
      return
    }
    applyQqSession(sessionId, agent, userId)

    const name = line.split(/\s+/)[0]
    try {
      if (!commands?.execute) {
        await send(userId, '这个实例没有命令服务，执行不了。')
        log('commands 服务不可用')
        return
      }
      const ac = new AbortController()
      const res = await commands.execute(agent, line, [], ac.signal)
      if (res === undefined) {
        await send(userId, `没有这个命令：${name}\n发 /help 看看有哪些。`)
        return
      }
      if (res?.text) {
        const plain = config.behavior.convertMarkdown ? mdToPlain(res.text) : res.text
        for (const part of chunkText(plain, config.behavior.sendChunkSize)) await send(userId, part)
      } else {
        await send(userId, `${name} 已执行（${res?.kind ?? 'ok'}）`)
      }
      log(`命令 ${line} 执行完成 kind=${res?.kind}`)
    } catch (err) {
      log(`命令 ${line} 失败: ${err?.stack ?? err}`)
      await send(userId, `${name} 执行失败：${err?.message ?? err}`)
    }
  }

  async function handleCommand(userId, line) {
    if (await handleLocalCommand(userId, line)) return
    await runDshCommand(userId, line)
  }

  // ---------- 消息处理 ----------
  async function handleEvent(event) {
    if (event?.post_type !== 'message') return
    if (event?.message_type !== 'private') return
    const userId = String(event.user_id ?? '')
    if (!userId) return
    if (bot.selfId && userId === String(bot.selfId)) return
    if (isDup(event.message_id)) return

    const allowed = allowSet.size > 0 ? allowSet.has(userId) : config.allowAllWhenEmpty
    if (!allowed) {
      log(`忽略非白名单 ${userId}`)
      return
    }
    msgCount += 1

    const segs = Array.isArray(event.message) ? event.message : []
    const types = segs.map((s) => s?.type).filter(Boolean)
    log(`收到消息 userId=${userId} 段类型=[${types.join(',')}]`)

    let text = ''
    const images = []
    const forwards = []
    const files = []
    const replies = []
    const others = []

    if (typeof event.message === 'string') {
      text = event.message.replace(/\[CQ:[^\]]*\]/g, '')
    } else {
      for (const seg of segs) {
        if (!seg) continue
        if (seg.type === 'text') text += seg.data?.text ?? ''
        else if (seg.type === 'image') images.push(seg.data)
        else if (seg.type === 'file') files.push(seg.data)
        else if (seg.type === 'reply') {
          if (seg.data?.id) replies.push(seg.data.id)
        } else if (seg.type === 'forward') {
          if (seg.data?.id) forwards.push(seg.data.id)
          else others.push('forward(无id)')
        } else if (seg.type === 'at' || seg.type === 'face') continue
        else others.push(seg.type)
      }
    }

    // 引用回复：把被引用的那句原话贴在前面，让模型知道他在回什么
    for (const rid of replies) {
      const line = await resolveReply(rid)
      if (line) text = line + '\n' + text
      else others.push('reply(解析失败)')
    }

    // 合并转发：拿 id 去问 NapCat 要节点列表，拍平成文本
    for (const fid of forwards) {
      const rec = await resolveForward(fid)
      if (rec) {
        text += (text ? '\n\n' : '') + rec
        log(`转发记录已解析: ${rec.split('\n').length} 行`)
      } else {
        others.push('forward(解析失败)')
      }
    }

    // 文件：落到工作区 inbox/，把路径告诉模型，让它自己读
    for (const f of files) {
      const got = await fetchFileToDisk(f)
      if (got?.path) {
        const kb = Math.round(got.bytes / 1024)
        text += `\n（用户发来文件：${got.name}，${kb} KB，已保存到 ${got.path}）`
        log(`文件已落盘: ${got.path} (${got.bytes} 字节)`)
      } else {
        const why = got?.error ?? '未知原因'
        text += `\n（用户发来一个文件，但我取不下来：${why}）`
        log(`文件取不下来: ${why}`)
      }
    }

    if (others.length > 0) {
      log(`未处理的消息段: ${others.join(',')} 内容=${JSON.stringify(segs.filter((s) => others.includes(s?.type))).slice(0, 400)}`)
    }

    // 纯文本走合并窗口
    if (images.length === 0) {
      text = text.trim()
      if (!text) {
        if (others.length > 0) send(userId, `这种消息我还看不懂（${others.join('/')}）。`)
        return
      }
      if (text.startsWith('/')) {
        await handleCommand(userId, text)
        return
      }
      buffer(userId, text)
      return
    }

    // 带图片：立刻处理，不参与合并
    const content = [{ type: 'text', text: text.trim() || '（发来图片）' }]
    const notes = []
    for (const img of images) {
      const got = await fetchImage(img)
      if (got?.mediaType) {
        content.push({ type: 'image', mediaType: got.mediaType, data: got.data })
        log(`图片已取到: ${got.mediaType} ${Math.round(got.size / 1024)}KB`)
      } else {
        notes.push(got?.error ?? '取图失败')
        log(`图片取不到: ${got?.error ?? '未知'}`)
      }
    }
    if (notes.length > 0 && content.length === 1) {
      send(userId, `图片我看不了：${notes[0]}`)
      return
    }
    deliver(userId, content, `${text.trim().slice(0, 40)} [+${images.length} 图]`).catch((err) =>
      log(`处理失败: ${err?.stack ?? err}`),
    )
  }

  // ---------- OneBot 生命周期（可热重启）----------
  function createBot() {
    return new OneBotClient({
      url: config.onebot.url,
      token: config.onebot.token,
      logger: {
        info: (m) => log(`[onebot] ${m}`),
        warn: (m) => log(`[onebot][warn] ${m}`),
        error: (m) => log(`[onebot][err] ${m}`),
      },
      onEvent: (event) => {
        handleEvent(event).catch((err) => log(`onEvent 异常: ${err?.stack ?? err}`))
      },
    })
  }

  function startBot() {
    if (bot) return
    bot = createBot()
    bot.start()
    log('OneBot 已启动，等待消息')
  }

  function stopBot() {
    if (!bot) return
    try {
      bot.stop()
    } catch {
      /* ignore */
    }
    bot = null
    log('OneBot 已停止')
  }

  // ---------- 设置页接口 ----------
  function getState() {
    const [firstUser, firstBind] = Object.entries(sessions)[0] ?? []
    return {
      plugin: { name: 'dsh-plugin-qq', version: PKG_VERSION },
      enabled: config.enabled === true,
      connection: {
        url: config.onebot.url,
        token: config.onebot.token,
        // connected 是 WS 真的通了；enabled=false 时一律显示未启用
        status: !config.enabled ? 'disabled' : bot?.connected ? 'connected' : 'connecting',
        selfId: bot?.selfId ? String(bot.selfId) : null,
      },
      whitelist: config.whitelist ?? [],
      workspace: {
        path: config.workspace || FALLBACK_WORKSPACE,
        workspaceId,
        exists: existsSync(config.workspace || FALLBACK_WORKSPACE),
      },
      prompt: {
        behavior: config.qqSystemPrompt ?? '',
        persona: config.qqPersona ?? '',
      },
      // 行为参数（注意别和上面的 prompt.behavior 混了，那个是提示词文本）
      behavior: {
        coalesceWindowMs: config.behavior.coalesceWindowMs,
        sendChunkSize: config.behavior.sendChunkSize,
        convertMarkdown: config.behavior.convertMarkdown,
      },
      napcat: {
        path: config.napcatPath ?? '',
        exists: !!(config.napcatPath && existsSync(config.napcatPath)),
      },
      session: {
        qqUser: firstUser ?? null,
        sessionId: firstBind?.sessionId ?? null,
        mode: firstBind?.mode ?? null,
      },
    }
  }

  async function applyConfig(input) {
    const notes = []
    const before = {
      enabled: config.enabled === true,
      url: config.onebot.url,
      token: config.onebot.token,
      workspace: config.workspace,
      napcatPath: config.napcatPath,
    }
    const promptBefore = {
      system: config.qqSystemPrompt,
      persona: config.qqPersona,
    }

    // ── 就地合并，这样 run() 里所有闭包持有的 config 引用立刻看到新值
    if (typeof input.enabled === 'boolean') config.enabled = input.enabled
    if (Array.isArray(input.whitelist)) {
      config.whitelist = [...new Set(input.whitelist.map((x) => String(x).trim()).filter((x) => /^\d+$/.test(x)))]
    }
    if (typeof input.workspace === 'string' && input.workspace.trim()) config.workspace = input.workspace.trim()
    if (typeof input.qqSystemPrompt === 'string') config.qqSystemPrompt = input.qqSystemPrompt
    if (typeof input.qqPersona === 'string') config.qqPersona = input.qqPersona
    if (typeof input.napcatPath === 'string') config.napcatPath = input.napcatPath.trim()

    // 行为参数：就地改，下一轮消息立刻按新值走
    if (input.behavior && typeof input.behavior === 'object') {
      const b = input.behavior
      const clamp = (v, lo, hi, dflt) => {
        const n = Number(v)
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt
      }
      const before = { ...config.behavior }
      config.behavior.coalesceWindowMs = clamp(b.coalesceWindowMs, 0, 60_000, config.behavior.coalesceWindowMs)
      config.behavior.sendChunkSize = clamp(b.sendChunkSize, 200, 20_000, config.behavior.sendChunkSize)
      if (typeof b.convertMarkdown === 'boolean') config.behavior.convertMarkdown = b.convertMarkdown
      if (JSON.stringify(before) !== JSON.stringify(config.behavior)) {
        notes.push(`行为参数已更新：合并窗口 ${config.behavior.coalesceWindowMs}ms、分片 ${config.behavior.sendChunkSize} 字`)
      }
    }
    if (input.onebot && typeof input.onebot === 'object') {
      if (typeof input.onebot.url === 'string') config.onebot.url = input.onebot.url.trim()
      if (typeof input.onebot.token === 'string') config.onebot.token = input.onebot.token.trim()
    }

    // 白名单即时生效
    allowSet.clear()
    for (const x of config.whitelist ?? []) allowSet.add(String(x))

    // 工作区变了 → 重新注册工作区，并清掉 QQ 会话（新工作区要新会话）
    if (config.workspace !== before.workspace) {
      await ensureWorkspace()
      if (Object.keys(sessions).length > 0) {
        sessions = {}
        saveSessions()
        notes.push('工作区已更改：QQ 会话映射已清空，下一条消息会在新工作区新建会话')
      } else {
        notes.push('工作区已更改')
      }
    }

    // 连接与开关
    const urlChanged = config.onebot.url !== before.url || config.onebot.token !== before.token
    if (!config.enabled) {
      if (bot) stopBot()
      notes.push('插件已停用，不再连接 QQ')
    } else if (!before.enabled) {
      startBot()
      notes.push('插件已启用，正在连接 NapCat')
    } else if (urlChanged) {
      stopBot()
      startBot()
      notes.push('连接参数已更改，正在重连')
    }

    // 提示词是挂在会话上的 section。改了之后必须重挂才生效，
    // 所以这里把"已挂过"的记录清掉，下一条消息进来时会用新文本重挂。
    if (promptBefore.system !== config.qqSystemPrompt || promptBefore.persona !== config.qqPersona) {
      promptEffects.clear()
      notes.push('提示词已更新，下一条 QQ 消息会用新版本')
    }

    return { config, notes }
  }

  // ---------- NapCat 探活 ----------

  /** TCP 层有没有人在听（区分"端口没人"和"不是 WebSocket"）。 */
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

  /**
   * 用原始 TCP 发一次 WebSocket 升级请求，看服务端怎么回。
   *
   * 为什么不能用普通 HTTP GET：NapCat 同时也跑着 WebUI 的网页服务，
   * 普通 GET 会被它接住并返回 HTML，从而把"令牌不对"误判成"不是 OneBot"。
   * 带上 Upgrade 头才能看出这个端口到底认不认 WebSocket。
   *
   * @returns {Promise<{status:number, contentType:string}|null>} 连不上返回 null
   */
  function wsPeek(host, port, path = '/', timeoutMs = 2000) {
    return new Promise((resolve) => {
      let settled = false
      let sock
      const done = (r) => {
        if (settled) return
        settled = true
        try {
          sock?.destroy()
        } catch {
          /* ignore */
        }
        resolve(r)
      }
      try {
        sock = netConnect({ host, port })
      } catch {
        return done(null)
      }
      sock.setTimeout(timeoutMs)
      let buf = ''
      sock.once('connect', () => {
        try {
          sock.write(
            `GET ${path} HTTP/1.1\r\n` +
              `Host: ${host}:${port}\r\n` +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          )
        } catch {
          done(null)
        }
      })
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1')
        const end = buf.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = buf.slice(0, end)
        const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) ?? [])[1] ?? 0)
        const ct = ((/content-type:\s*([^\r\n]+)/i.exec(head) ?? [])[1] ?? '').trim()
        done({ status, contentType: ct })
      })
      sock.once('timeout', () => done(null))
      sock.once('error', () => done(null))
    })
  }

  /** 带令牌握一次手，问 get_login_info。 */
  function oneBotHandshake(url, token, timeoutMs = 4000) {
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
      const timer = setTimeout(() => finish({ state: 'timeout', hint: '握手超时：地址可能错了' }), timeoutMs)
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
        if (ok) {
          const selfId = String(d.data?.user_id ?? '')
          finish({ state: 'connected', selfId, hint: `已连接 · 机器人 ${selfId || '(未知)'}` })
        } else {
          finish({
            state: 'reachable-no-auth',
            hint: `端口有服务但握手被拒（${d.retcode ?? ''} ${d.message ?? ''}）—— 多半是令牌不对`,
          })
        }
      }
      // 握手失败时再发一次带 Upgrade 头的原始请求，把"端口被别的程序占了"
      // 和"令牌不对"分开。WebSocket 的 error/close 事件不带 HTTP 状态码。
      const classify = async (fallbackHint) => {
        let host = ''
        let port = 0
        let path = '/'
        try {
          const u = new URL(url)
          host = u.hostname
          port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
          path = u.pathname || '/'
        } catch {
          return { state: 'unreachable', hint: `${fallbackHint}（地址解析不了）` }
        }
        const peek = await wsPeek(host, port, path)
        if (peek == null) {
          return { state: 'unreachable', hint: `${fallbackHint}，而且这个端口没有响应 WebSocket 升级请求` }
        }
        // 先看是不是网页：NapCat 的 WebUI 会对普通请求回 401 + HTML，
        // 如果先看状态码就会把它误判成"令牌不对"。网页一定不是 OneBot 的端口。
        if (/text\/html/i.test(peek.contentType)) {
          return {
            state: 'not-onebot',
            hint: `这个端口返回的是网页（HTTP ${peek.status}）—— 多半是 NapCat 的 WebUI 端口，不是消息端口`,
          }
        }
        if (peek.status === 101) {
          return {
            state: 'reachable-no-auth',
            hint: '端口确实是 WebSocket 服务端，但刚才的握手没成功 —— 多半是令牌不对',
          }
        }
        if (peek.status === 401 || peek.status === 403) {
          return {
            state: 'reachable-no-auth',
            hint: `端口上有服务，但要求鉴权（HTTP ${peek.status}）—— 多半是令牌不对`,
          }
        }
        return {
          state: 'not-onebot',
          hint: `这个端口有服务，但不接受 WebSocket 升级（HTTP ${peek.status}）—— 多半被别的程序占了`,
        }
      }

      ws.onerror = () => {
        clearTimeout(timer)
        void classify('连接被拒').then(finish)
      }
      ws.onclose = () => {
        clearTimeout(timer)
        void classify('连接被关闭').then(finish)
      }
    })
  }

  /** 探测 NapCat/OneBot 的当前状况。不给参数就用当前配置。 */
  async function probeNapcat(input) {
    const url = String(input?.url ?? config.onebot.url ?? '').trim()
    const token = String(input?.token ?? config.onebot.token ?? '').trim()

    // 短路：已经在连着、而且问的就是当前配置 —— 直接复用现有连接，
    // 不必为了探活每 10 秒新建一条 WebSocket（会刷满日志、也打扰 NapCat）。
    if (!input?.url && !input?.token && bot?.connected) {
      const selfId = bot.selfId ? String(bot.selfId) : ''
      return { state: 'connected', selfId, hint: `已连接 · 机器人 ${selfId || '(未知)'}` }
    }

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return { state: 'unreachable', hint: `地址格式不对：${url}` }
    }
    const host = parsed.hostname
    const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80))

    const alive = await tcpAlive(host, port)
    if (!alive) {
      return {
        state: 'unreachable',
        hint:
          `${host}:${port} 上没有服务在监听 —— ` +
          '可能是 NapCat 没启动、它的 WebSocket 服务端没开，' +
          '也可能只是它还没登录 QQ（NapCat 要登录成功后才开始监听）',
      }
    }
    const r = await oneBotHandshake(url, token)
    log(`探活 ${url} → ${r.state}${r.selfId ? ` (${r.selfId})` : ''}`)
    return r
  }

  /** 在资源管理器里定位一个文件。只定位，不执行。 */
  async function revealPath(p) {
    const target = String(p ?? '').trim()
    if (!target) return { ok: false, error: '路径为空' }
    if (!existsSync(target)) return { ok: false, error: `路径不存在：${target}` }
    try {
      await rpc.call('session/openWorkspacePath', { path: target, action: 'reveal' })
      log(`已在资源管理器定位：${target}`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }



  // ---------- 会话选择 ----------
  const MAX_PICKER = 40
  const WORKSPACE_STORE = join(DSH_HOME, 'storages', 'workspace.json')

  /**
   * 读 DSH 的工作区登记表，得到「会话 → 工作区」的归属。
   *
   * 没有可用的工作区 RPC：workspace/follow 是流式的，workspace/create 会建工作区，
   * 所以直接读 storages/workspace.json。读不到就当没有分组信息，UI 会退化成平铺。
   *
   * @returns {Map<string, {id: string, title: string, path: string}>}
   */
  function readWorkspaceIndex() {
    const index = new Map()
    let doc
    try {
      doc = JSON.parse(readFileSync(WORKSPACE_STORE, 'utf8').replace(/^\uFEFF/, ''))
    } catch (err) {
      if (existsSync(WORKSPACE_STORE)) log(`工作区登记表读不了: ${err?.message ?? err}`)
      return index
    }
    const table = doc?.tables?.workspaces ?? {}
    for (const [id, ws] of Object.entries(table)) {
      const info = {
        id,
        title: ws?.title || (ws?.path ? basename(ws.path) : id),
        path: ws?.path ?? '',
      }
      for (const raw of ws?.sessionIds ?? []) {
        const key = String(raw)
        index.set(key, info)
        // 老版本登记的是裸 uuid，两种形态都记，查的时候不用猜
        if (!key.startsWith('session-')) index.set(`session-${key}`, info)
      }
    }
    return index
  }

  /** 列出可选会话：按工作区分组，未加入任何工作区的不列（当前绑定的除外）。 */
  async function listSessionsForPicker() {
    const current = Object.values(sessions)[0]?.sessionId ?? null
    const wsIndex = readWorkspaceIndex()
    try {
      const r = await rpc.call('session/list', {})
      const all = (r?.items ?? []).map((s) => {
        const ws = wsIndex.get(s.sessionId) ?? null
        return {
          sessionId: s.sessionId,
          title: s.projections?.values?.title ?? null,
          // agentPreset 是会话投影里就有的字段（SessionProjectionMap.agentPreset），
          // 用它认出「这条本来就是 QQ 管家会话」，绑定的时候才不会当成遥控对象
          agentPreset: s.projections?.values?.agentPreset ?? null,
          cwd: s.cwd ?? null,
          updatedAt: s.updatedAt ?? null,
          blank: s.blank === true,
          workspace: ws ? { id: ws.id, title: ws.title, path: ws.path } : null,
        }
      })

      // 登记表读不到时无法判断归属，退回平铺（不按未分组过滤，否则会列出 0 个）
      const filterByWorkspace = wsIndex.size > 0
      const eligible = all.filter((s) => s.sessionId === current || (!s.blank && (!filterByWorkspace || s.workspace)))

      // 先按工作区分桶，组内按更新时间倒序；当前绑定的那条提到组内首位
      const byGroup = new Map()
      for (const s of eligible) {
        const key = s.workspace?.id ?? ''
        if (!byGroup.has(key)) {
          byGroup.set(key, {
            id: key,
            title: s.workspace?.title ?? '未分组',
            path: s.workspace?.path ?? '',
            sessions: [],
          })
        }
        byGroup.get(key).sessions.push(s)
      }
      for (const g of byGroup.values()) g.sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

      const groupsAll = [...byGroup.values()]
      let currentGroup = null
      for (const g of groupsAll) {
        const at = g.sessions.findIndex((s) => s.sessionId === current)
        if (at >= 0) {
          if (at > 0) g.sessions.unshift(g.sessions.splice(at, 1)[0])
          currentGroup = g
        }
      }
      const latestOf = (g) => g.sessions[0]?.updatedAt ?? 0
      // 组顺序：当前绑定所在组最前，其余按最近活跃——不能再按标题字母排，
      // 否则「QQ」这类排在后面的工作区会被 MAX_PICKER 整组截掉
      const orderedGroups = currentGroup
        ? [currentGroup, ...groupsAll.filter((g) => g !== currentGroup).sort((a, b) => latestOf(b) - latestOf(a))]
        : [...groupsAll].sort((a, b) => latestOf(b) - latestOf(a))

      // 轮转取样：第 1 轮每组取最新的一条，第 2 轮取第二条……保证每个工作区都露脸，
      // 不会因为某个组会话特别多就把别的组挤没
      const picked = new Map()
      let pickedTotal = 0
      for (let round = 0; pickedTotal < MAX_PICKER; round++) {
        let added = false
        for (const g of orderedGroups) {
          if (pickedTotal >= MAX_PICKER) break
          const s = g.sessions[round]
          if (!s) continue
          if (!picked.has(g)) picked.set(g, [])
          picked.get(g).push(s)
          pickedTotal += 1
          added = true
        }
        if (!added) break
        const exhausted = orderedGroups.every((g) => g.sessions.length <= round + 1)
        if (exhausted) break
      }

      const groups = orderedGroups
        .map((g) => ({
          id: g.id,
          title: g.title,
          path: g.path,
          total: g.sessions.length,
          sessions: picked.get(g) ?? [],
        }))
        .filter((g) => g.sessions.length > 0)
      const list = groups.flatMap((g) => g.sessions)

      return { sessions: list, groups, current }
    } catch (err) {
      log(`列会话失败: ${err?.message ?? err}`)
      return { sessions: [], groups: [], current, error: String(err?.message ?? err) }
    }
  }

  // ---------- 读 NapCat 自己的配置 ----------
  // 具体读取逻辑在 lib/napcat-config.js（纯函数 + 一个可注入 handshake 的入口），
  // 这样能单测。这里只负责把当前配置和探活能力接过去。
  async function readNapcatConfig() {
    return readNapcatConfigFrom({
      napcatPath: config.napcatPath,
      selfId: bot?.selfId ? String(bot.selfId) : null,
      handshake: oneBotHandshake,
    })
  }

  /**
   * 解析用户填的 NapCat 位置：目录或启动脚本路径都认。
   *
   * 只解析用户给的那一个路径，不做全盘扫描（扫盘慢且不可控）。
   * 返回挑中的启动脚本，找不到就明说 launcherMissing。
   */
  function resolveNapcatPath(input) {
    const raw = String(input ?? '').trim() || String(config.napcatPath ?? '').trim()
    if (!raw) return { ok: false, error: '先填 NapCatShell 目录' }
    const resolved = resolveNapcatRoot(raw)
    if (!resolved) return { ok: false, error: '路径为空' }
    if (!resolved.exists) return { ok: false, error: `路径不存在：${raw}`, root: raw, exists: false }
    const launcher = pickLauncher(resolved.root)
    return {
      ok: true,
      input: raw,
      root: resolved.root,
      configDir: resolved.configDir,
      launcher,
      launcherMissing: !launcher,
    }
  }

  /**
   * 看一眼这个 NapCat 目录处于什么阶段，前端据此渲染步骤。
   *
   * 三个独立信号（都靠读本地文件，不联网）：
   *   started   —— config/webui.json 在不在（决定「有没有链接」）
   *   servers   —— onebot11_*.json 里的 websocketServers（决定「要不要进 WebUI 建服务端」）
   *   accounts  —— napcat_*.json（决定「登录过没有」）
   */
  async function inspectNapcat(input) {
    const r = resolveNapcatPath(input)
    if (!r.ok) return r
    let cfg = null
    try {
      cfg = await readNapcatConfigFrom({
        napcatPath: r.root,
        selfId: bot?.selfId ? String(bot.selfId) : null,
        handshake: oneBotHandshake,
      })
    } catch (err) {
      log(`读取 NapCat 配置失败: ${err?.message ?? err}`)
    }
    const started = Boolean(cfg?.webui)
    const servers = cfg?.onebot?.candidates ?? []
    return {
      ...r,
      started,
      webui: cfg?.webui ?? null,
      onebot: cfg?.onebot ?? null,
      servers,
      hasServer: servers.length > 0,
      problems: cfg?.problems ?? [],
    }
  }

  /**
   * 「打开文件夹」：定位脚本 → 读配置 → 给出 WebUI 链接。
   *
   * 注意它不会替用户启动 NapCat（NapCat 必须活在 DSH 外面），
   * 只在资源管理器里选中脚本，用户双击即可。
   */
  async function launchNapcat(input) {
    const r = await inspectNapcat(input)
    if (!r.ok) return r
    const target = r.launcher ?? r.root
    const revealed = await revealPath(target)
    return {
      ...r,
      revealed: revealed.ok,
      revealError: revealed.ok ? undefined : revealed.error,
    }
  }

  /**
   * 弹 DSH 主机的目录选择器。取消返回 { ok:false, cancelled:true }。
   *
   * 零参数 RPC：结果可能是 null（用户取消）或选中路径字符串。
   */
  async function pickNapcatDir() {
    try {
      // 用户可能要翻一会儿目录，给 120 秒
      const picked = await rpc.call('directoryPicker/pick', null, 120_000)
      if (!picked) return { ok: false, cancelled: true }
      return { ok: true, path: String(picked) }
    } catch (err) {
      log(`目录选择器调用失败: ${err?.message ?? err}`)
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  /**
   * 反查 NapCat 装在哪：用**当前配置的端口**追进程链。
   *
   * 给"用户自己找到链接、自己填了地址和令牌、但没填启动脚本路径"这种情况兜底 ——
   * 连上之后照样能把路径补回来。
   */
  async function detectNapcatPath() {
    let port = 0
    try {
      const u = new URL(config.onebot.url)
      port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80))
    } catch {
      /* ignore */
    }
    const r = await detectNapcatRoot(port)
    if (r.ok) log(`自动检测到 NapCat：${r.root}${r.launcher ? `（${r.launcher}）` : '（没找到启动脚本）'}`)
    else log(`自动检测 NapCat 失败：${r.error}`)
    return r
  }

  /** 把当前 QQ 绑定到指定会话；传 null 表示解除绑定（下条消息新建）。 */
  async function bindSession(sessionId) {
    const qqUser = Object.keys(sessions)[0] ?? String((config.whitelist ?? [])[0] ?? '')
    if (!qqUser) {
      return { ok: false, error: '先把「允许接收消息的 QQ 号」填上，再来选会话' }
    }

    const previous = boundId(qqUser)

    if (!sessionId) {
      bindTo(qqUser, null)
      // 真正撤销：提示词、工具、提问禁用、审批策略
      const released = releaseQqSession(previous)
      log(`已解除 QQ ${qqUser} 的会话绑定（撤销注入=${released}）`)
      return {
        ok: true,
        notes: [
          '已解除绑定：下一条 QQ 消息会在工作目录里新建会话',
          released
            ? '该会话上插件加的东西已撤销（提示词层、qq_* 工具、提问限制）'
            : '该会话上没有需要撤销的注入',
        ],
      }
    }

    const target = String(sessionId)

    // 换绑：先撤掉旧会话上的注入，否则它会一直带着 QQ 规则
    let releasedOld = false
    if (previous && previous !== target) {
      releasedOld = releaseQqSession(previous)
      if (releasedOld) log(`换绑：已撤销旧会话 ${previous} 上的 QQ 注入`)
    }

    // 绑到一个「QQ 管家」会话上，本来就该按管家模式接待——它有配套的人格，
    // 契约里写着要用 qq_send_message，不给工具它就发不出话。绑到别的会话才是遥控。
    // 依据是会话投影里的 agentPreset，问一次 session/list 就知道。
    let preset = null
    try {
      const list = await rpc.call('session/list', {})
      const hit = (list?.items ?? []).find((s) => s.sessionId === target)
      preset = hit?.projections?.values?.agentPreset ?? null
    } catch (err) {
      log(`绑定前读会话 preset 失败（按遥控处理）: ${err?.message ?? err}`)
    }
    const mode = preset === QQ_AGENT_PRESET ? 'auto' : 'attach'
    log(`绑定目标 ${target} 的 preset=${preset ?? '(无)'} → 模式 ${mode}`)

    bindTo(qqUser, target, mode)

    // 顺手唤醒，这样下一轮能直接 in-process 投递，不用走 RPC 兜底。
    // 注意：唤醒用 rename，但**不改标题** —— 绑定一个已有的会话不该给它改名。
    let woken = false
    try {
      await wakeSession(target)
      woken = !!agents.get(target)
    } catch (err) {
      log(`绑定后唤醒会话失败: ${err?.message ?? err}`)
    }

    log(`已把 QQ ${qqUser} 绑定到会话 ${target}（模式=${mode}，唤醒=${woken}，撤销旧注入=${releasedOld}）`)
    const modeNotes =
      mode === 'attach'
        ? [
            '遥控模式：不注入提示词、不注册 qq_* 工具、审批策略保持原样',
            '只动一样——提问工具对 QQ 隐藏（QQ 端没人能回答，一调就永久挂起）',
          ]
        : [
            `管家模式：这条会话本来就是「QQ 管家」（preset=${QQ_AGENT_PRESET}），按原样给它 QQ 工具`,
            '输出按管家规则发：只发最后那段，过程中的话不转',
          ]
    return {
      ok: true,
      mode,
      notes: [
        woken ? '已绑定，并且该会话现在是活的' : '已绑定；该会话暂时唤不醒，下条消息会用 RPC 投递一次',
        ...modeNotes,
        releasedOld ? `旧会话 ${previous} 上的 QQ 注入已撤销` : '',
      ].filter(Boolean),
    }
  }

  try {
    disposers.push(
      ...registerSettingsRoutes({
        ctx,
        log,
        getState,
        applyConfig,
        listSessions: listSessionsForPicker,
        bindSession,
        probeNapcat,
        revealPath,
        readNapcatConfig,
        resolveNapcat: inspectNapcat,
        launchNapcat,
        pickNapcatDir,
        detectNapcatPath,
        readLogTail,
        configPath: CONFIG_PATH,
      }),
    )
    log('设置页接口已注册：state / config / sessions / bind / napcat / reveal / client-log')
  } catch (err) {
    log(`注册设置页接口失败: ${err?.stack ?? err}`)
  }

  if (config.enabled) startBot()
  else log('enabled=false，不启动 NapCat 连接（可以在设置页里打开）')

  ctx.effect(
    () => () => {
      log('插件卸载，停止 OneBot')
      for (const d of disposers) {
        try {
          d()
        } catch {
          /* ignore */
        }
      }
      stopBot()
    },
    'qq-plugin/onebot',
  )
}
