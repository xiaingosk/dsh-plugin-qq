/**
 * dsh-plugin-qq 的设置页（客户端包）。
 *
 * 格式：window.__ModuleLoader__.load({ id, factory })，factory 里的 require
 * 由宿主注入（react、@deepseek-ai/dsh-client-ui-primitives 等）。
 *
 * ⚠️ 设计红线：这个包**绝对不能把异常抛给宿主**。
 * 客户端条目激活失败会让整个 web boot 判定失败、应用直接打不开
 * （"web boot: 1 entry did not activate"），用户只能靠安全模式恢复。
 * 所以从 factory 到 apply 到渲染，全部包了兜底：最坏情况是设置页少一节，
 * 而不是打不开应用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-qq',
  factory: (require) => {
    /** 回传：渲染进程的 console 我们看不到，出错必须让服务端知道 */
    const report = (level, msg, stack) => {
      try {
        void fetch('/dsh-plugin-qq/api/client-log', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level, msg: String(msg), stack: stack ? String(stack) : undefined }),
        }).catch(() => {})
      } catch {
        /* ignore */
      }
      try {
        console.error(`[dsh-plugin-qq] ${level}: ${msg}`)
      } catch {
        /* ignore */
      }
    }

    /** 兜底：任何失败都退化成"什么都不做"的合法模块 */
    const fallback = (why) => {
      report('error', 'client entry disabled', why?.stack ?? why)
      return {
        name: 'dsh-plugin-qq',
        inject: [],
        apply() {
          /* 故意空实现：没有设置页，但应用照常启动 */
        },
      }
    }

    report('info', 'factory 开始执行')
    try {
      return buildModule(require, report)
    } catch (err) {
      return fallback(err)
    }
  },
})

function buildModule(require, report) {
  report('info', '开始解析宿主模块')
  const React = require('react')
  const pri = require('@deepseek-ai/dsh-client-ui-primitives')
  report('info', `宿主模块解析成功，primitives 导出 ${pri ? Object.keys(pri).length : 0} 项`)

  const API = '/dsh-plugin-qq/api'
  // 固定指向「最新版的同名资产」，不用写死版本号
  const NAPCAT_DOWNLOAD = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip'

  // 宿主组件库版本差异时不要炸：缺了就用朴素替代
  const Button =
    pri?.Button ?? ((props) => React.createElement('button', props, props.children))
  const Input = pri?.Input ?? ((props) => React.createElement('input', props))
  const Switch =
    pri?.Switch ??
    ((props) =>
      React.createElement('input', {
        type: 'checkbox',
        checked: props.checked,
        disabled: props.disabled,
        onChange: (e) => props.onChange?.(e.target.checked),
      }))
  const StateDot = pri?.StateDot ?? (() => null)
  const Pill = pri?.Pill ?? ((props) => React.createElement('span', props, props.children))

  const S = {
    wrap: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px 24px' },
    row: { display: 'flex', flexDirection: 'column', gap: 6 },
    label: { fontSize: 13, opacity: 0.72 },
    hint: { fontSize: 12, opacity: 0.55, lineHeight: 1.5 },
    status: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
    actions: { display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 },
    note: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap' },
    // 五步流程：每一步一张卡，标题行左边一个圈号
    step: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      border: '1px solid rgba(127,127,127,0.22)',
      borderRadius: 12,
      padding: '12px 14px',
    },
    stepHead: { display: 'flex', alignItems: 'center', gap: 10 },
    stepNo: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      borderRadius: 10,
      border: '1px solid rgba(127,127,127,0.35)',
      fontSize: 12,
      opacity: 0.8,
      flexShrink: 0,
    },
    stepTitle: { fontSize: 13, fontWeight: 600, opacity: 0.9, flex: 1 },
    inline: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' },
    link: { color: 'inherit', textDecoration: 'underline', wordBreak: 'break-all' },
  }

  /**
   * 顶部状态行：把连接状态和 NapCat 探活合起来说。
   *
   * 只看 connection.status 不够——它只有 disabled / connected / connecting 三种，
   * 令牌填错、地址上没人监听都会一直显示「正在连接 NapCat…」，用户不知道该改哪里。
   * 探活那三种结论正好补上这个缺口；探活还没回来时再退回「正在连接」。
   */
  function describe(state, napcat) {
    if (!state) return { dot: 'ongoing', text: '读取中…' }
    if (!state.enabled) return { dot: 'idle', text: '未启用' }
    if (state.connection.status === 'connected') {
      return { dot: 'done', text: `已连接 · 机器人 ${state.connection.selfId ?? '(未知)'}` }
    }
    const probe = napcat?.state
    if (probe === 'unreachable') {
      return { dot: 'error', text: `连不上：${napcat.hint ?? '地址上没有服务在监听'}（启动 NapCat，或检查地址）` }
    }
    if (probe === 'reachable-no-auth') {
      return { dot: 'warning', text: `握手被拒：${napcat.hint ?? '地址通了但被拒绝'}（多半是令牌不对）` }
    }
    if (probe === 'timeout') {
      return { dot: 'warning', text: `探测超时：${napcat.hint ?? '地址没有响应'}` }
    }
    if (probe === 'not-onebot') {
      return { dot: 'error', text: `端口不是 NapCat 的服务端：${napcat.hint ?? '这个端口被别的程序占了'}` }
    }
    return { dot: 'warning', text: '正在连接 NapCat…' }
  }

  /**
   * 把「保存并检测」的探活结论翻译成"下一步该改什么"。
   *
   * 刻意不用一句「连不上」带过：NapCat 这条路上有四种典型卡点
   * （没启动 / 令牌不对 / 端口填成了 WebUI / 超时），每种要用户动手的地方都不一样。
   * 这里给的文案也直接出现在底部反馈块里，所以不写"上面""下面"这种会漂移的方位词。
   */
  function describeProbe(result) {
    const st = result?.state
    if (st === 'connected') {
      return { dot: 'done', title: '检测通过，可以点上面的「启用」了', hint: result?.hint ?? '', advice: null }
    }
    if (st === 'reachable-no-auth') {
      return {
        dot: 'warning',
        title: '令牌不对：NapCat 拒绝了这次握手',
        hint: result?.hint ?? '',
        advice: '用第 ② 步里的「复制令牌」重新填一遍，或回 NapCat 网页核对该 WebSocket 服务端的 token。',
      }
    }
    if (st === 'not-onebot') {
      return {
        dot: 'error',
        title: '这个端口不是 NapCat 的服务端',
        hint: result?.hint ?? '',
        advice: '多半填成了 WebUI 的端口，或者端口被别的程序占了。用第 ② 步读到的 NapCat 地址。',
      }
    }
    if (st === 'timeout') {
      return {
        dot: 'warning',
        title: '超时：地址没有响应',
        hint: result?.hint ?? '',
        advice: '地址可能写错了，或者被防火墙挡住。核对端口后重试。',
      }
    }
    if (st === 'unreachable') {
      return {
        dot: 'error',
        title: '连不上 NapCat',
        hint: result?.hint ?? '',
        advice: '按顺序查：NapCat 启动了吗 → 扫码登录了吗 → 第 ④ 步的 WebSocket 服务端建好了吗。',
      }
    }
    if (st === 'no-url') {
      return {
        dot: 'error',
        title: '还没填 WebSocket 地址',
        hint: '',
        advice: '先完成第 ④ 步：把 NapCat 的 WebSocket 地址填上，或者点第 ② 步让它自动读。',
      }
    }
    return {
      dot: 'error',
      title: '检测没做成',
      hint: result?.error ?? result?.hint ?? '',
      advice: '稍后再点一次「保存并检测」。',
    }
  }

  /**
   * 第 ④ 步「已读到」那行只读文字。
   *
   * 读到服务端后就不该再让人对着输入框抄地址了；令牌只说"填了没有"，
   * 不把令牌本身打到页面上。
   */
  function describePicked(picked) {
    if (!picked?.url) return ''
    return `已从 NapCat 读取：${picked.url}${picked.token ? ' · 令牌已填' : ' · 没有令牌'}`
  }

  function QQSettings() {
    const [state, setState] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [feedback, setFeedback] = React.useState(null)
    // 表单脏标记：只在 fetchState 的 updater 里读（用户动过表单就别被轮询冲掉），
    // 组件本身不需要它的值。
    const [, setDirty] = React.useState(false)
    const [sessionList, setSessionList] = React.useState({ sessions: [], groups: [], current: null })
    const [napcat, setNapcat] = React.useState(null)
    const [probe, setProbe] = React.useState(null)
    const [showPrompt, setShowPrompt] = React.useState(false)
    // 用户填的 NapCatShell 目录解析结果：
    // { ok, root, launcher, launcherMissing, started, webui, onebot, problems } 或 { ok:false, error }
    const [napcatResolved, setNapcatResolved] = React.useState(null)
    // 本地的「检测通过」标记：为真才允许从顶部启用（没连上就启用只会白跑）
    const [verified, setVerified] = React.useState(false)
    const [showTuning, setShowTuning] = React.useState(false)
    const [showLog, setShowLog] = React.useState(false)
    const [loadingLog, setLoadingLog] = React.useState(false)
    const [logs, setLogs] = React.useState(null)
    // 注意：这里没有 enabled —— 启停只走顶部那个按钮，表单不碰它
    const [form, setForm] = React.useState({
      url: '',
      token: '',
      whitelist: '',
      workspace: '',
      napcatPath: '',
      persona: '',
      coalesceWindowMs: 2000,
      sendChunkSize: 4000,
      convertMarkdown: true,
    })

    const probeNapcat = React.useCallback(async () => {
      try {
        const res = await fetch(`${API}/napcat`, { credentials: 'same-origin' })
        const json = await res.json()
        if (json.ok) setNapcat(json)
      } catch {
        /* 探测失败不影响其他功能 */
      }
    }, [])

    const fetchSessions = React.useCallback(async () => {
      try {
        const res = await fetch(`${API}/sessions`, { credentials: 'same-origin' })
        const json = await res.json()
        if (json.ok)
          setSessionList({
            sessions: json.sessions ?? [],
            groups: json.groups ?? [],
            current: json.current ?? null,
          })
      } catch {
        /* 列表拿不到不影响其他功能 */
      }
    }, [])

    /** '' 表示解除绑定（下条消息新建会话） */
    const pickSession = async (sessionId) => {
      setBusy(true)
      setFeedback(null)
      try {
        const res = await fetch(`${API}/bind`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId || null }),
        })
        const json = await res.json()
        if (!json.ok) {
          setFeedback({ ok: false, text: json.error ?? '绑定失败' })
        } else {
          setFeedback({ ok: true, text: (json.notes ?? []).join('\n') })
          if (json.state) setState(json.state)
          await fetchSessions()
        }
      } catch (err) {
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setBusy(false)
      }
    }

    const fetchState = React.useCallback(async () => {
      try {
        const res = await fetch(`${API}/state`, { credentials: 'same-origin' })
        const json = await res.json()
        if (!json.ok) return
        setState(json.state)
        // 用户动过表单就不再覆盖，避免边打字边被冲掉
        setDirty((wasDirty) => {
          if (!wasDirty) {
            setForm({
              url: json.state.connection.url ?? '',
              token: json.state.connection.token ?? '',
              whitelist: (json.state.whitelist ?? []).join(', '),
              workspace: json.state.workspace.path ?? '',
              napcatPath: json.state.napcat?.path ?? '',
              persona: json.state.prompt?.persona ?? '',
              coalesceWindowMs: json.state.behavior?.coalesceWindowMs ?? 2000,
              sendChunkSize: json.state.behavior?.sendChunkSize ?? 4000,
              convertMarkdown: json.state.behavior?.convertMarkdown !== false,
            })
          }
          return wasDirty
        })
      } catch {
        setState(null)
      }
    }, [])

    React.useEffect(() => {
      fetchState()
      fetchSessions()
      probeNapcat()
      const timer = setInterval(fetchState, 3000)
      const timer2 = setInterval(fetchSessions, 15000)
      const timer3 = setInterval(probeNapcat, 10000)
      return () => {
        clearInterval(timer)
        clearInterval(timer2)
        clearInterval(timer3)
      }
    }, [fetchState, fetchSessions, probeNapcat])

    /**
     * 改任何字段都算「配置变了」：刚才那次检测的结论作废，
     * 要重新点「保存并检测」才允许从顶部启用。
     */
    const set = (key) => (value) => {
      setDirty(true)
      setVerified(false)
      setForm((f) => ({ ...f, [key]: value }))
    }

    /**
     * 顶部启用 / 停用：只改 enabled 这一个字段，不碰用户正在编辑的表单。
     * 服务端返回的 state 直接写回，状态行立刻跟着变。
     */
    const toggleEnabled = async () => {
      if (!state || busy) return
      const next = !state.enabled
      setBusy(true)
      setFeedback(null)
      try {
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
        const json = await res.json()
        if (!json.ok) {
          setFeedback({ ok: false, text: json.error ?? (next ? '启用失败' : '停用失败') })
          return
        }
        if (json.state) setState(json.state)
        setFeedback({
          ok: true,
          text: next ? '已启用：下一条 QQ 消息就会进到 DSH。' : '已停用：不再接收 QQ 消息。',
        })
      } catch (err) {
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setBusy(false)
      }
    }

    /**
     * 唯一的主动作：先把表单存下去（**enabled 保持原值**，不顺手启用），
     * 再用存下去的那组 url/token 探一次活，把「能不能启用」变成确定的事实。
     */
    const saveAndVerify = async () => {
      setBusy(true)
      setFeedback(null)
      setProbe(null)
      try {
        const body = {
          // 不带 enabled：启停只走顶部按钮，保存不该偷偷改变开关
          onebot: { url: String(form.url).trim(), token: String(form.token).trim() },
          whitelist: String(form.whitelist)
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          workspace: String(form.workspace).trim(),
          napcatPath: String(form.napcatPath).trim(),
          // 不带 qqSystemPrompt：那个字段是"没装 preset 时的兜底规则"，
          // 界面上没有入口，这里也就不发它——不发＝保持原值，手改过 JSON 的人不会被覆盖。
          qqPersona: String(form.persona ?? ''),
          behavior: {
            coalesceWindowMs: Number(form.coalesceWindowMs),
            sendChunkSize: Number(form.sendChunkSize),
            convertMarkdown: !!form.convertMarkdown,
          },
        }
        const res = await fetch(`${API}/config`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!json.ok) {
          setVerified(false)
          setFeedback({ ok: false, text: json.error ?? '保存失败' })
          return
        }
        if (json.state) setState(json.state)
        setDirty(false)
        setFeedback({ ok: true, text: ['已保存。', ...(json.notes ?? [])].join('\n') })

        // 用**存下去的**地址令牌探活，而不是表单里可能还没生效的值
        const conn = json.state?.connection ?? {}
        const url = String(conn.url ?? form.url ?? '').trim()
        const token = String(conn.token ?? form.token ?? '').trim()
        if (!url) {
          setVerified(false)
          setProbe({ state: 'no-url' })
          return
        }
        const qs = new URLSearchParams({ url, token })
        const probeRes = await fetch(`${API}/napcat?${qs.toString()}`, { credentials: 'same-origin' })
        const result = await probeRes.json()
        if (!result.ok) {
          setVerified(false)
          setProbe({ state: 'error', error: result.error ?? '接口没有返回结果' })
          return
        }
        setVerified(result.state === 'connected')
        setProbe(result)
      } catch (err) {
        setVerified(false)
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setBusy(false)
      }
    }

    /** 复制到剪贴板；浏览器不给权限时说清楚该手动干什么。 */
    const copyText = async (text, what) => {
      const v = String(text ?? '').trim()
      if (!v) {
        setFeedback({ ok: false, text: `没有可复制的${what}` })
        return
      }
      try {
        await navigator.clipboard.writeText(v)
        setFeedback({ ok: true, text: `${what}已复制到剪贴板` })
      } catch {
        setFeedback({ ok: false, text: `复制失败：浏览器不允许访问剪贴板，请手动选中${what}复制` })
      }
    }

    /**
     * 解析结果里如果已经读到了 NapCat 的 WebSocket 服务端，就把它填进表单。
     * 第 ④ 步据此决定显示「一行只读」还是「两个输入框」。
     * 地址变了 => 之前那次检测作废。
     */
    const applyPicked = (json) => {
      const picked = json?.onebot?.picked
      if (!picked?.url) return false
      setDirty(true)
      setVerified(false)
      setForm((f) => ({ ...f, url: String(picked.url), token: String(picked.token ?? '') }))
      return true
    }

    /**
     * 解析用户填的 NapCat 位置（目录或脚本都行），把「找到哪个启动脚本」落到界面上。
     * 不做扫盘：只解析用户给的那一个路径。
     * 顺带读到 WebSocket 服务端时直接填进表单 —— 第 ④ 步就不用让人手抄地址了。
     */
    const resolveNapcatPath = async (raw) => {
      const p = String(raw ?? '').trim()
      if (!p) {
        setNapcatResolved(null)
        return
      }
      try {
        const res = await fetch(`${API}/napcat-resolve`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        const json = await res.json()
        setNapcatResolved(json)
        if (json?.ok) applyPicked(json)
      } catch (err) {
        setNapcatResolved({ ok: false, error: String(err?.message ?? err) })
      }
    }

    /**
     * 打开设置页时，把已保存的路径自动解析一次。
     *
     * 否则用户会看到"路径明明填着，却要重填一遍才认得出 launcher"——
     * 因为解析只在失焦/选择时才触发。依赖只放 state：表单字段变化不该反复打接口。
     */
    React.useEffect(() => {
      const saved = String(form.napcatPath || '').trim()
      if (!state || !saved || napcatResolved) return
      resolveNapcatPath(saved)
    }, [state])

    /** 弹 DSH 主机的目录选择器（原生对话框），选完直接解析 */
    const pickNapcatFolder = async () => {
      setBusy(true)
      setFeedback(null)
      try {
        const res = await fetch(`${API}/napcat-pick`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const json = await res.json()
        if (json?.cancelled) return
        if (!json?.ok) {
          setFeedback({ ok: false, text: json?.error ?? '选择目录失败' })
          return
        }
        setDirty(true)
        setForm((f) => ({ ...f, napcatPath: json.path }))
        await resolveNapcatPath(json.path)
      } catch (err) {
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setBusy(false)
      }
    }

    /**
     * 「启动」：在资源管理器里选中启动脚本 → 顺手读一遍配置（WebUI 链接、地址令牌）。
     * 不替用户启动 NapCat——它必须活在 DSH 外面，双击这一步留给人。
     */
    const launchNapcat = async () => {
      const p = String(form.napcatPath).trim()
      if (!p) {
        setFeedback({ ok: false, text: '先在第 ② 步里选一个 NapCat 目录' })
        return
      }
      setBusy(true)
      setFeedback(null)
      try {
        const res = await fetch(`${API}/napcat-launch`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        const json = await res.json()
        setNapcatResolved(json)
        if (!json.ok) {
          setFeedback({ ok: false, text: json.error ?? '没找到 NapCat' })
          return
        }
        applyPicked(json)
        const target = json.launcher || json.root
        setFeedback({
          ok: true,
          text:
            json.revealed === false
              ? `没能打开文件夹（${json.revealError ?? '未知原因'}），手动去 ${target} 双击启动脚本。`
              : `已在资源管理器里选中 ${target}。双击它启动 NapCat，启动一次后回来就能看到 WebUI 链接。`,
        })
      } catch (err) {
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setBusy(false)
      }
    }

    /**
     * 拉一次运行日志的尾巴。
     * 日志文件在启动时按 5MB 轮转，所以这里可以放心整读再切尾。
     */
    const loadLog = async () => {
      setLoadingLog(true)
      try {
        const res = await fetch(`${API}/log?lines=300`, { credentials: 'same-origin' })
        const json = await res.json()
        if (json.ok) {
          setLogs({ lines: json.lines ?? [], sizeKB: json.sizeKB ?? 0 })
          setShowLog(true)
        } else {
          setFeedback({ ok: false, text: json.error ?? '读日志失败' })
        }
      } catch (err) {
        setFeedback({ ok: false, text: String(err?.message ?? err) })
      } finally {
        setLoadingLog(false)
      }
    }

    const info = describe(state, napcat)

    // ── 第 ②④ 步要用的几个派生值
    const solved = napcatResolved?.ok === true
    const launcherName =
      solved && napcatResolved.launcher ? String(napcatResolved.launcher).split(/[\\/]/).pop() : ''
    const started = solved && napcatResolved.started === true
    const webuiUrl = solved ? String(napcatResolved.webui?.url ?? '') : ''
    const webuiToken = solved ? String(napcatResolved.webui?.token ?? '') : ''
    // 第 ② 步读回来的 WebSocket 服务端：有它就把第 ④ 步收成一行只读
    const picked = solved ? napcatResolved.onebot?.picked ?? null : null
    const probeInfo = probe ? describeProbe(probe) : null

    // 停用状态下必须"检测通过"才允许启用；已启用的随时可以停用
    const canToggle = Boolean(state) && !busy && (state.enabled === true || verified)

    /** 一个会话选项。标题 + 短 id + 目录 + 日期，窄屏也能分清。 */
    const renderSessionOption = (s) => {
      const title = s.title || '(无标题)'
      const dir = String(s.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ''
      return React.createElement(
        'option',
        { key: s.sessionId, value: s.sessionId },
        `${title} · ${String(s.sessionId).slice(8, 16)}${dir ? ` · ${dir}` : ''}${when ? ` · ${when}` : ''}`,
      )
    }

    /** 有工作区分组就用 optgroup 分组，没有分组信息就退回平铺。 */
    const renderSessionOptions = () => {
      const groups = sessionList.groups ?? []
      if (groups.length === 0) return sessionList.sessions.map(renderSessionOption)
      return groups.map((g) =>
        React.createElement(
          'optgroup',
          { key: g.id || g.title, label: g.title },
          ...(g.sessions ?? []).map(renderSessionOption),
        ),
      )
    }

    return React.createElement(
      'div',
      { style: S.wrap },

      // ── 顶部：状态 + 启用/停用
      // 停用状态下必须"检测通过"才让点 —— 没连上就打开，等于让插件在后台白跑。
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        React.createElement(
          'div',
          { style: S.status },
          React.createElement(StateDot, { state: info.dot }),
          React.createElement('span', { style: { flex: 1 } }, info.text),
          state?.session?.sessionId
            ? React.createElement(
                Pill,
                null,
                `${state.session.mode === 'attach' ? '遥控' : '管家'} ${String(state.session.sessionId).slice(8, 16)}…`,
              )
            : null,
          React.createElement(
            Button,
            {
              variant: state?.enabled ? 'outline' : 'primary',
              size: 'sm',
              onClick: toggleEnabled,
              disabled: !canToggle,
            },
            state?.enabled ? '停用' : '启用',
          ),
        ),
        state && state.enabled === false && !verified
          ? React.createElement(
              'div',
              { style: S.hint },
              busy
                ? '正在检查…'
                : '还没检测通过：先做第 ⑤ 步的「保存并检测」，通过后上面的「启用」才能点。',
            )
          : null,
      ),

      // ── 第 ① 步：装 NapCat。只给下载入口，长步骤交给 NapCat 自己的文档。
      React.createElement(
        'div',
        { style: S.step },
        React.createElement(
          'div',
          { style: S.stepHead },
          React.createElement('span', { style: S.stepNo }, '①'),
          React.createElement('span', { style: S.stepTitle }, '安装 NapCat'),
          React.createElement(
            Button,
            { variant: 'outline', size: 'sm', onClick: () => window.open(NAPCAT_DOWNLOAD, '_blank', 'noreferrer') },
            '下载链接',
          ),
        ),
        React.createElement(
          'div',
          { style: S.hint },
          '下载 Shell 包（约 36 MB），解压到一个固定目录。装好了再往下走。',
        ),
      ),

      // ── 第 ② 步：启动 NapCat。选目录 → 看启动脚本 → 启动过没有 → 给 WebUI 链接
      React.createElement(
        'div',
        { style: S.step },
        React.createElement(
          'div',
          { style: S.stepHead },
          React.createElement('span', { style: S.stepNo }, '②'),
          React.createElement('span', { style: S.stepTitle }, '启动 NapCat'),
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement(
            'span',
            { style: { ...S.hint, fontSize: 12.5, whiteSpace: 'nowrap' } },
            '解压缩的位置',
          ),
          React.createElement(Input, {
            value: form.napcatPath,
            placeholder: '点「选择…」挑 NapCat 目录，也可以直接粘路径',
            style: { flex: 1 },
            onChange: (e) => set('napcatPath')(e.target.value),
            onBlur: () => resolveNapcatPath(form.napcatPath),
            disabled: busy,
          }),
          React.createElement(
            Button,
            { variant: 'outline', size: 'sm', onClick: pickNapcatFolder, disabled: busy },
            '选择…',
          ),
        ),
        // 解析结果：找到哪个启动脚本（找不到就直说，不让人猜）
        React.createElement(
          'div',
          { style: S.inline },
          !String(form.napcatPath).trim()
            ? React.createElement('span', { style: S.hint }, '填上目录后，这里会显示找到的启动脚本')
            : solved
              ? launcherName
                ? React.createElement('span', { style: { fontSize: 12.5 } }, `已找到：${launcherName}`)
                : React.createElement(
                    'span',
                    { style: S.hint },
                    '这个目录里没有 launcher 脚本，请直接填 launcher-user.bat 的路径',
                  )
              : napcatResolved?.error
                ? React.createElement('span', { style: { ...S.hint, opacity: 0.9 } }, napcatResolved.error)
                : React.createElement('span', { style: S.hint }, '正在解析…'),
          launcherName
            ? React.createElement(
                Button,
                { variant: 'primary', size: 'sm', onClick: launchNapcat, disabled: busy },
                '启动',
              )
            : null,
        ),
        // 启动过没有决定下一步：没启动过 → 提示去双击；启动过 → WebUI 链接 + 复制令牌
        solved
          ? started
            ? React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                React.createElement(
                  'div',
                  { style: S.inline },
                  React.createElement(
                    'span',
                    { style: { fontSize: 12.5, opacity: 0.8 } },
                    'NapCat 启动过，WebUI 在这里：',
                  ),
                  webuiUrl
                    ? React.createElement(
                        'a',
                        { href: webuiUrl, target: '_blank', rel: 'noreferrer', style: S.link },
                        webuiUrl,
                      )
                    : React.createElement(
                        'span',
                        { style: S.hint },
                        '（没读到 WebUI 链接，去它的控制台窗口里找打印出来的地址）',
                      ),
                  webuiUrl
                    ? React.createElement(
                        Button,
                        {
                          variant: 'ghost',
                          size: 'sm',
                          onClick: () => copyText(webuiToken, '令牌'),
                          disabled: busy,
                        },
                        '复制令牌',
                      )
                    : null,
                ),
                React.createElement(
                  'div',
                  { style: S.hint },
                  '打开它扫码登录 QQ，然后在同一个页面里点「网络 → OneBot 配置 → 新建 WebSocket 服务端」。',
                ),
              )
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                React.createElement(
                  'div',
                  { style: { fontSize: 12.5, opacity: 0.8 } },
                  '还没启动过：点上面的「启动」，在弹出的文件夹里双击 launcher-user.bat',
                ),
                React.createElement(
                  'div',
                  { style: S.hint },
                  '启动后再点一次「启动」，这里就会变成 WebUI 链接。',
                ),
              )
          : null,
      ),

      // ── 第 ③ 步：你的 QQ 号（白名单）
      React.createElement(
        'div',
        { style: S.step },
        React.createElement(
          'div',
          { style: S.stepHead },
          React.createElement('span', { style: S.stepNo }, '③'),
          React.createElement('span', { style: S.stepTitle }, '你的 QQ 号'),
        ),
        React.createElement(Input, {
          value: form.whitelist,
          placeholder: '2076255291',
          onChange: (e) => set('whitelist')(e.target.value),
          disabled: busy,
        }),
        React.createElement(
          'div',
          { style: S.hint },
          '只有这个号发的消息才会被处理。多个用逗号分隔；留空 = 谁发的都不理。',
        ),
      ),

      // ── 第 ④ 步：连接。读到了就收成一行只读，读不到才让人手填。
      React.createElement(
        'div',
        { style: S.step },
        React.createElement(
          'div',
          { style: S.stepHead },
          React.createElement('span', { style: S.stepNo }, '④'),
          React.createElement('span', { style: S.stepTitle }, '连接'),
        ),
        picked
          ? React.createElement(
              'div',
              { style: { fontSize: 12.5, lineHeight: 1.6, wordBreak: 'break-all' } },
              describePicked(picked),
            )
          : React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
              React.createElement(
                'div',
                { style: S.row },
                React.createElement('div', { style: S.label }, 'NapCat WebSocket 地址'),
                React.createElement(Input, {
                  value: form.url,
                  placeholder: 'ws://127.0.0.1:3001',
                  onChange: (e) => set('url')(e.target.value),
                  disabled: busy,
                }),
              ),
              React.createElement(
                'div',
                { style: S.row },
                React.createElement('div', { style: S.label }, '访问令牌'),
                React.createElement(Input, {
                  value: form.token,
                  placeholder: '可留空',
                  onChange: (e) => set('token')(e.target.value),
                  disabled: busy,
                }),
              ),
              React.createElement('div', { style: S.hint }, 'NapCat 里建好服务端后会自动读到。'),
            ),
      ),

      // ── 更多设置：日常五步之外的部分，保持原样
      React.createElement('div', { style: { ...S.label, fontWeight: 600, opacity: 0.9 } }, '更多设置'),

      // 会话绑定：决定 QQ 消息接进哪段对话
      React.createElement(
        'div',
        { style: S.row },
        React.createElement('div', { style: S.label }, 'QQ 接进哪个会话'),
        React.createElement(
          'select',
          {
            value: sessionList.current ?? '',
            disabled: busy,
            onChange: (e) => pickSession(e.target.value),
            style: {
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid rgba(127,127,127,0.28)',
              background: 'transparent',
              color: 'inherit',
              fontSize: 13,
              fontFamily: 'inherit',
            },
          },
          React.createElement('option', { value: '' }, '自动 —— 每条新消息都在工作目录里开新会话'),
          ...renderSessionOptions(),
        ),
        sessionList.current
          ? React.createElement(
              'div',
              {
                style: {
                  ...S.hint,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  color: 'inherit',
                  border: '1px solid rgba(230,160,30,0.55)',
                  background: 'rgba(230,160,30,0.10)',
                  borderRadius: 10,
                  padding: '10px 12px',
                },
              },
              '已绑定会话按两种方式接待：绑到「QQ 管家」会话 → 管家模式（工具与契约照给）；' +
                '绑到别的会话 → 遥控模式，不改它的提示词、不加 QQ 工具、不动审批策略，' +
                '只在每一步把它的输出（包括过程中的话）转到 QQ。' +
                '两种都只动一样：提问工具对它隐藏——QQ 端没人能回答，一调就永久挂起。' +
                '切回「自动」会当场撤销这些，下一条消息在工作目录里新建管家会话。',
            )
          : null,
        React.createElement(
          'div',
          { style: S.hint },
          '只列已经归入某个工作区的会话（未分组的不显示）。选中即绑定，选「自动」解除。',
        ),
      ),

      // ── 人设：常规折叠，点开才编辑
      //     契约（怎么干活、怎么发消息）在 agent preset 里，这里改不到，所以这里不给入口。
      React.createElement(
        'div',
        {
          style: {
            ...S.row,
            border: '1px solid rgba(127,127,127,0.22)',
            borderRadius: 12,
            padding: '12px 14px',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', { style: { ...S.label, opacity: 0.9 } }, '人设'),
          React.createElement(
            'span',
            { style: { fontSize: 13, flex: 1, opacity: 0.7 } },
            form.persona.trim() ? '已自定义' : '默认（跟随「QQ 管家」契约）',
          ),
          React.createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setShowPrompt((v) => !v), disabled: busy },
            showPrompt ? '收起' : '编辑',
          ),
        ),

        showPrompt
          ? React.createElement(
              'div',
              { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 } },

              React.createElement(
                'div',
                { style: S.row },
                React.createElement('div', { style: S.label }, '你是谁'),
                React.createElement('textarea', {
                  value: form.persona,
                  rows: 8,
                  spellCheck: false,
                  placeholder: '留空 = 按默认人设说话。\n\n参考写法：\n# 名字\n- 身份、别人怎么称呼你\n- 说话风格、口头禅、用不用 emoji\n- 被夸 / 被怼时怎么反应\n- 几条「用户说 → 你回」的示例（只示范语气和长度）',
                  disabled: busy,
                  onChange: (e) => set('persona')(e.target.value),
                  style: {
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid rgba(127,127,127,0.28)',
                    background: 'transparent',
                    color: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.7,
                    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  },
                }),
                React.createElement(
                  'div',
                  { style: S.hint },
                  '追加在「QQ 管家」契约之后（order 10）。**只写人设，不要写工具怎么用** —— 工具协议会变，' +
                    '写进去必然过期。留空则不注入。',
                ),
              ),

              React.createElement(
                'div',
                { style: S.hint },
                '改完点保存：下一条 QQ 消息就会用新版本，不用重启 DSH，已经存在的会话也生效。',
              ),
            )
          : null,
      ),

      React.createElement(
        'div',
        { style: S.row },
        React.createElement('div', { style: S.label }, '新会话的工作目录'),
        React.createElement(Input, {
          value: form.workspace,
          placeholder: 'D:\\qq-workspace',
          onChange: (e) => set('workspace')(e.target.value),
          disabled: busy,
        }),
        React.createElement(
          'div',
          { style: S.hint },
          state?.workspace?.exists === false
            ? '⚠ 这个目录不存在'
            : '只影响「自动」模式下新建的会话，不改变已经绑定的会话。改了会解除现有绑定。',
        ),
      ),

      // ── 行为参数（折叠）
      React.createElement(
        'div',
        {
          style: {
            ...S.row,
            border: '1px solid rgba(127,127,127,0.22)',
            borderRadius: 12,
            padding: '12px 14px',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', { style: { ...S.label, opacity: 0.9 } }, '行为参数'),
          React.createElement(
            'span',
            { style: { fontSize: 12.5, flex: 1, opacity: 0.65 } },
            `${form.coalesceWindowMs}ms 合并 · ${form.sendChunkSize} 字分片`,
          ),
          React.createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: () => setShowTuning((v) => !v), disabled: busy },
            showTuning ? '收起' : '调整',
          ),
        ),

        showTuning
          ? React.createElement(
              'div',
              { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 } },

              React.createElement(
                'div',
                { style: S.row },
                React.createElement('div', { style: S.label }, '合并窗口（毫秒）'),
                React.createElement(Input, {
                  value: String(form.coalesceWindowMs),
                  onChange: (e) => set('coalesceWindowMs')(e.target.value),
                  disabled: busy,
                }),
                React.createElement(
                  'div',
                  { style: S.hint },
                  '你连着发好几条时，插件等这么久再合并成一轮。0 = 每条都单独发。',
                ),
              ),

              React.createElement(
                'div',
                { style: S.row },
                React.createElement('div', { style: S.label }, '单条最长字数'),
                React.createElement(Input, {
                  value: String(form.sendChunkSize),
                  onChange: (e) => set('sendChunkSize')(e.target.value),
                  disabled: busy,
                }),
                React.createElement(
                  'div',
                  { style: S.hint },
                  '超过就自动切成多条发。QQ 单条上限远大于这个值，切小只是更好读。',
                ),
              ),


              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 12 } },
                React.createElement(Switch, {
                  checked: !!form.convertMarkdown,
                  onChange: (v) => {
                    setDirty(true)
                    setForm((f) => ({ ...f, convertMarkdown: v }))
                  },
                  label: 'Markdown 转纯文本',
                  disabled: busy,
                }),
                React.createElement('span', null, '把 Markdown 转成纯文本（关掉的话表格和代码块会原样发出去）'),
              ),
            )
          : null,
      ),

      // ── 运行日志（折叠）
      React.createElement(
        'div',
        {
          style: {
            ...S.row,
            border: '1px solid rgba(127,127,127,0.22)',
            borderRadius: 12,
            padding: '12px 14px',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          React.createElement('span', { style: { ...S.label, opacity: 0.9 } }, '运行日志'),
          React.createElement(
            'span',
            { style: { fontSize: 12.5, flex: 1, opacity: 0.65 } },
            logs ? `最近 ${(logs.lines ?? []).length} 行（${logs.sizeKB} KB）` : '排查问题时看',
          ),
          React.createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              onClick: () => (showLog ? setShowLog(false) : loadLog()),
              disabled: busy || loadingLog,
            },
            loadingLog ? '读取中…' : showLog ? '收起' : '查看',
          ),
        ),

        showLog && logs
          ? React.createElement(
              'pre',
              {
                style: {
                  margin: '12px 0 0',
                  maxHeight: 320,
                  overflow: 'auto',
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  opacity: 0.85,
                },
              },
              (logs.lines ?? []).join('\n'),
            )
          : null,
      ),

      // ── 第 ⑤ 步：唯一的主动作。
      // 先存（enabled 保持原值），再用存下去的值探活；通过才允许从顶部启用。
      React.createElement(
        'div',
        { style: S.step },
        React.createElement(
          'div',
          { style: S.stepHead },
          React.createElement('span', { style: S.stepNo }, '⑤'),
          React.createElement('span', { style: S.stepTitle }, '保存并检测'),
        ),
        React.createElement(
          'div',
          { style: S.hint },
          '保存上面的设置（不会改变启用状态），再用保存后的地址探一次活。检测通过后，顶部的「启用」才点得动。',
        ),
        React.createElement(
          'div',
          { style: S.actions },
          React.createElement(
            Button,
            { variant: 'primary', size: 'md', onClick: saveAndVerify, disabled: busy },
            busy ? '检测中…' : '保存并检测',
          ),
        ),

        probeInfo
          ? React.createElement(
              'div',
              {
                style: {
                  ...S.note,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(127,127,127,0.24)',
                  background:
                    probe.state === 'connected'
                      ? 'rgba(46,160,67,0.10)'
                      : probe.state === 'unreachable' || probe.state === 'not-onebot' || probe.state === 'no-url'
                        ? 'rgba(209,67,67,0.10)'
                        : 'rgba(230,162,60,0.12)',
                },
              },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, probeInfo.title),
              probeInfo.hint ? React.createElement('div', null, probeInfo.hint) : null,
              probeInfo.advice
                ? React.createElement('div', { style: { marginTop: 6, opacity: 0.85 } }, probeInfo.advice)
                : null,
            )
          : null,

        feedback
          ? React.createElement(
              'div',
              { style: { ...S.note, color: feedback.ok ? 'inherit' : '#d33' } },
              feedback.text,
            )
          : null,
      ),
    )
  }

  /** 渲染函数也包一层：哪怕组件本身出错，也只影响这一节 */
  function renderSection() {
    try {
      report('info', '渲染设置页')
      return React.createElement(QQSettings)
    } catch (err) {
      report('error', '渲染设置页失败', err?.stack ?? err)
      return null
    }
  }

  function apply(ctx) {
    // 最后一道防线：注册失败也只是没有设置页，绝不让条目激活失败
    try {
      if (!ctx?.slots?.inject || !ctx?.slots?.register) {
        report('error', `slots 服务不可用（ctx.slots=${typeof ctx?.slots}），设置页跳过`)
        return
      }

      // 关键：必须用 slots.inject 等 "settings.section" 被父条目声明之后再注册。
      // 直接 register 会因为「父条目的 children 表还没声明这个插槽」而抛：
      //   slot "settings.section" is not declared
      // 而这取决于加载顺序 —— 顺序不巧就抛，正是之前时好时坏的原因。
      ctx.slots.inject('settings.section', () => {
        report('info', 'settings.section 已声明，开始注册')
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'qq',
            order: 60,
            label: () => 'QQ',
            inject: () => ({}),
          },
          renderSection,
        )
      })
      report('info', 'settings.section 注册已提交')
    } catch (err) {
      report('error', 'slots 注册失败', err?.stack ?? err)
    }
  }

  return {
    name: 'dsh-plugin-qq',
    inject: ['slots'],
    apply,
    // 只给测试用：宿主只读 name/inject/apply，这个字段不影响加载。
    // 纯函数直接单测比"模拟 React 状态"可靠得多。
    __test: { describe, describeProbe, describePicked },
  }
}
