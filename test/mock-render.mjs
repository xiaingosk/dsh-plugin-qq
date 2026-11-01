/**
 * 在 Node 里模拟 DSH 客户端宿主，真正执行 QQSettings 组件，
 * 验证渲染期间不会抛错，并且折叠/展开两种分支都能渲染出关键内容。
 *
 * 这不是替代浏览器测试，但能抓住"变量名写错""属性访问 undefined"这类
 * 会让整个设置页白屏的错误。
 */
import { readFileSync } from 'node:fs'

const code = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

// 按 URL 路由的 mock：不同接口返回不同形状，才能驱动出真实的分支
let mockState = null
let mockNapcat = { state: 'unreachable', hint: '测试用' }

globalThis.fetch = (url) => {
  const u = String(url)
  if (u.includes('/napcat')) {
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, ...mockNapcat }) })
  }
  if (u.includes('/sessions')) {
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, sessions: [], groups: [], current: null }) })
  }
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, state: mockState }) })
}

// Node 24 的 globalThis.navigator 只有 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})

/** 执行一次完整链路：加载模块 → 注册 → 渲染 → 收集文本 */
function run({ expandAll, primitivesMissing, state, napcat }) {
  mockState = state ?? null
  mockNapcat = napcat ?? { state: 'unreachable', hint: '测试用' }
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    // expandAll 时把布尔状态取反，让折叠区也渲染出来
    useState: (init) => [expandAll && typeof init === 'boolean' ? !init : init, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    Fragment: 'Fragment',
  }

  const require = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      // primitivesMissing=true 时什么都不给，验证"缺组件用朴素替代"那层兜底
      return primitivesMissing ? {} : { Button: (p) => React.createElement('button', p, p.children) }
    }
    throw new Error(`unexpected module: ${name}`)
  }

  // eslint-disable-next-line no-eval
  eval(code)
  const mod = loaded.factory(require)

  let renderFn = null
  mod.apply({
    slots: {
      inject: (_name, cb) => cb(),
      register: (_descriptor, render) => {
        renderFn = render
        return () => {}
      },
    },
  })
  if (typeof renderFn !== 'function') throw new Error('没有拿到 render 函数')

  const element = renderFn()
  const tree = element.type() // 真正执行函数组件

  const texts = []
  ;(function walk(n) {
    if (n == null) return
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') { texts.push(String(n)); return }
    if (n.props) for (const v of Object.values(n.props)) if (typeof v === 'string') texts.push(v)
    ;(n.children ?? []).forEach(walk)
  })(tree)

  return { texts, childCount: tree?.children?.length }
}

const cases = [
  {
    name: '默认（五步流程，折叠区收起）',
    opts: { expandAll: false, primitivesMissing: false },
    expect: [
      // 顶部：状态行 + 启用/停用按钮（state 还没回来时按钮显示「启用」且不可点）
      '启用',
      // 五步的标题与关键控件
      '①',
      '安装 NapCat',
      '下载链接',
      '②',
      '启动 NapCat',
      '选择…',
      '填上目录后，这里会显示找到的启动脚本',
      '③',
      '你的 QQ 号',
      '④',
      '连接',
      'NapCat WebSocket 地址',
      '⑤',
      '保存并检测',
      // 更多设置里的既有功能不能丢
      '更多设置',
      'QQ 接进哪个会话',
      '新会话的工作目录',
    ],
    forbid: ['还差', 'OneBot WebSocket 地址', '测试连接', '刷新状态', '启动并登录', '启用 QQ 桥接'],
  },
  {
    name: '展开（人设 / 行为参数 / 日志都渲染出来）',
    opts: { expandAll: true, primitivesMissing: false },
    expect: [
      '人设',
      '你是谁',
      // 契约在 agent preset 里，设置页不该再有它的编辑入口
      '追加在「QQ 管家」契约之后',
      '行为参数',
      '运行日志',
    ],
    // 这两个是上一版的入口，现在必须彻底消失——留一半最糟
    forbid: ['行为层', '人格层', '核心约束', '解锁修改'],
  },
  {
    name: '宿主组件库缺件（走朴素替代）',
    opts: { expandAll: false, primitivesMissing: true },
    expect: ['NapCat', '启用', '保存并检测', '选择…'],
    forbid: [],
  },
]

let allOk = true
for (const c of cases) {
  process.stdout.write(`\n[${c.name}]\n`)
  let r
  try {
    r = run(c.opts)
  } catch (err) {
    allOk = false
    process.stdout.write(`  ✗ 抛错: ${err?.stack ?? err}\n`)
    continue
  }
  process.stdout.write(`  渲染成功，子元素 ${r.childCount} 个\n`)
  for (const kw of c.expect) {
    const hit = r.texts.some((s) => s.includes(kw))
    if (!hit) allOk = false
    process.stdout.write(`  ${hit ? '✓' : '✗'} ${kw}\n`)
  }
  for (const kw of c.forbid ?? []) {
    const hit = r.texts.some((s) => s.includes(kw))
    if (hit) allOk = false
    process.stdout.write(`  ${hit ? '✗' : '✓'} 不该出现：${kw}\n`)
  }
}

process.stdout.write(allOk ? '\n渲染用例全部通过\n' : '\n渲染用例有失败项\n')

// ── 纯函数单测：状态行、检测结论与第 ④ 步的只读文案 ──────────────
{
  const base = {
    enabled: true,
    connection: { url: 'ws://127.0.0.1:3001', token: 't', status: 'connected', selfId: '3166153003' },
    whitelist: ['2076255291'],
    workspace: { path: 'D:\\qq-workspace', exists: true, workspaceId: 'w1' },
    prompt: { behavior: '', persona: '' },
    session: { qqUser: '2076255291', sessionId: 'session-abc' },
  }
  const connecting = { ...base, connection: { ...base.connection, status: 'connecting' } }

  const mod = (() => {
    let loaded = null
    globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
    // eslint-disable-next-line no-eval
    eval(code)
    return loaded.factory((n) => {
      if (n === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useCallback: (f) => f, useEffect: () => {} }
      if (n.includes('primitives')) return {}
      throw new Error('unexpected ' + n)
    })
  })()

  const { describe, describeProbe, describePicked } = mod.__test

  const unit = [
    ['连上时状态行显示机器人号', describe(base, { state: 'connected' }).text.includes('3166153003'), true],
    ['未启用时状态行说未启用', describe({ ...base, enabled: false }, { state: 'connected' }).text, '未启用'],
    ['not-onebot 时状态行点出来', describe(connecting, { state: 'not-onebot' }).dot, 'error'],
    // 需求：UI 里只保留 NapCat 这个名词，状态行不许再把 NapCat 叫成 OneBot
    ['状态行不提 OneBot', /OneBot/.test(describe(connecting, { state: 'not-onebot' }).text), false],

    // 第 ⑤ 步「保存并检测」的结论：四种失败要各自说清该改哪里
    ['检测通过时给出下一步', describeProbe({ state: 'connected' }).title, '检测通过，可以点上面的「启用」了'],
    ['令牌不对时指到复制令牌', describeProbe({ state: 'reachable-no-auth' }).advice.includes('复制令牌'), true],
    ['连不上时给排查顺序', describeProbe({ state: 'unreachable' }).advice.includes('启动'), true],
    ['端口不对时以 NapCat 为主语', describeProbe({ state: 'not-onebot' }).title, '这个端口不是 NapCat 的服务端'],
    ['超时单独说', describeProbe({ state: 'timeout' }).dot, 'warning'],
    ['没填地址时指向第 ④ 步', describeProbe({ state: 'no-url' }).title, '还没填 WebSocket 地址'],
    ['接口没返回时不让页面卡死', describeProbe(null).title, '检测没做成'],

    // 第 ④ 步：读到了就收成一行只读，令牌只报"填了没有"
    [
      '读到服务端时只读行说令牌已填',
      describePicked({ url: 'ws://127.0.0.1:3001', token: 'abc' }),
      '已从 NapCat 读取：ws://127.0.0.1:3001 · 令牌已填',
    ],
    [
      '没令牌时不假装填了',
      describePicked({ url: 'ws://127.0.0.1:3001', token: '' }),
      '已从 NapCat 读取：ws://127.0.0.1:3001 · 没有令牌',
    ],

    // 需求：整份客户端源码里，「OneBot」只允许出现在 NapCat 自己的菜单名里
    ['「OneBot」只出现在 NapCat 菜单名里', (code.match(/OneBot/g) ?? []).length, 1],
  ]

  let unitOk = true
  process.stdout.write('\n[纯函数单测]\n')
  for (const [name, got, want] of unit) {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) unitOk = false
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(want)}，得到 ${JSON.stringify(got)}`}\n`)
  }
  allOk = allOk && unitOk
  process.stdout.write(unitOk ? '\n单测全部通过\n' : '\n单测有失败项\n')
}

process.exit(allOk ? 0 : 1)
