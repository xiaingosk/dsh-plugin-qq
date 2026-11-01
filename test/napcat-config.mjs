/**
 * lib/napcat-config.js 的单测。
 *
 * 这些用例全都用临时目录造假配置，不碰真实的 NapCat —— 否则测试会随
 * 用户机器上装没装 NapCat 而飘。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNapcatFiles, readNapcatConfig, usableHost, resolveNapcatRoot } from '../lib/napcat-config.js'

let ok = true
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) ok = false
  process.stdout.write(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n      期望 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`}\n`)
}

/** 造一个 NapCat 目录：<tmp>/config/*.json，外加一个假的启动脚本 */
function makeNapcat(files) {
  const root = mkdtempSync(join(tmpdir(), 'napcat-test-'))
  const cfg = join(root, 'config')
  mkdirSync(cfg, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(cfg, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
  }
  const launcher = join(root, 'launcher-user.bat')
  writeFileSync(launcher, '@echo off\n', 'utf8')
  return { root, launcher }
}

const webui = (host, port, token) => ({ host, port, token })
const onebot = (port, token, enable = true) => ({
  network: { websocketServers: [{ enable, name: 'ws', host: '127.0.0.1', port, token, messagePostFormat: 'array' }] },
})

const tmpdirs = []
const series = []

process.stdout.write('\n[usableHost]\n')
check('通配 :: 映射成回环', usableHost('::'), '127.0.0.1')
check('0.0.0.0 映射成回环', usableHost('0.0.0.0'), '127.0.0.1')
check('空值用回环', usableHost(''), '127.0.0.1')
check('正常地址原样保留', usableHost('192.168.1.5'), '192.168.1.5')

process.stdout.write('\n[readNapcatFiles 的各种坏情况]\n')
check('没填路径', readNapcatFiles('').problems[0], '还没填 NapCat 启动脚本的路径')
check('路径不存在', readNapcatFiles('D:\\不存在的目录\\x.bat').ok, false)

{
  const d = makeNapcat({})
  rmSync(join(d.root, 'config'), { recursive: true, force: true })
  tmpdirs.push(d.root)
  check('没有 config 子目录', readNapcatFiles(d.launcher).ok, false)
}

{
  const d = makeNapcat({ 'webui.json': webui('::', 6099, 'tok123') })
  tmpdirs.push(d.root)
  const r = readNapcatFiles(d.launcher)
  check('只有 webui.json 时 ok', r.ok, true)
  check('链接用回环而不是 ::', r.webui.url, 'http://127.0.0.1:6099/webui?token=tok123')
  check('没有 onebot 配置会提示建服务端', r.problems.some((p) => p.includes('还没在 WebUI 里建过')), true)
}

{
  const d = makeNapcat({ 'webui.json': webui('127.0.0.1', 6100, 't'), 'onebot11_123.json': onebot(3001, 'a') })
  tmpdirs.push(d.root)
  const r = readNapcatFiles(d.root) // 直接给目录也要认
  check('直接给目录也能读', r.candidates.length, 1)
  check('候选解析出 port/token/qq', [r.candidates[0].port, r.candidates[0].token, r.candidates[0].qq], [3001, 'a', '123'])
}

{
  const d = makeNapcat({ 'webui.json': webui('127.0.0.1', 6100, 't'), 'onebot11_1.json': onebot(3001, 'a', false) })
  tmpdirs.push(d.root)
  const r = readNapcatFiles(d.launcher)
  // 未启用的那份不当作可用候选，但要留下记录说明原因
  check('enable=false 不产生可用候选', r.candidates.filter((c) => c.url).length, 0)
  check('enable=false 会记为带错误的条目', r.candidates[0].error, '没有启用中的 WebSocket 服务端')
}

{
  const bom = '\uFEFF' + JSON.stringify(webui('127.0.0.1', 7000, 'bom-token'))
  const d = makeNapcat({ 'webui.json': bom })
  tmpdirs.push(d.root)
  check('带 BOM 的 webui.json 也能读', readNapcatFiles(d.launcher).webui.port, 7000)
}

process.stdout.write('\n[readNapcatConfig 挑候选]\n')
{
  // 两个号都登过：onebot11_111 和 onebot11_222
  const d = makeNapcat({
    'webui.json': webui('127.0.0.1', 6100, 't'),
    'onebot11_111.json': onebot(3001, 'ta'),
    'onebot11_222.json': onebot(3002, 'tb'),
  })
  tmpdirs.push(d.root)

  const bySelf = await readNapcatConfig({
    napcatPath: d.launcher,
    selfId: '222',
    handshake: async () => {
      throw new Error('有 selfId 时不该去握手')
    },
  })
  check('按 selfId 直接选中对应文件', bySelf.onebot.picked.qq, '222')
  check('按 selfId 选中视为已验证', bySelf.onebot.picked.verified, true)

  // 没有 selfId：靠握手挑。模拟只有 3002 那个能连上
  const tried = []
  const byProbe = await readNapcatConfig({
    napcatPath: d.launcher,
    selfId: null,
    handshake: async (url) => {
      tried.push(url)
      return url.includes('3002') ? { state: 'connected', selfId: '222' } : { state: 'unreachable', hint: '没人听' }
    },
  })
  check('握手挑出能连上的那个', byProbe.onebot.picked.port, 3002)
  check('握手挑中的标记为已验证', byProbe.onebot.picked.verified, true)
  check('失败的那个带上原因', byProbe.onebot.candidates.find((c) => c.port === 3001)?.hint, '没人听')

  // 一个都连不上：退回第一个可用的，但明确标成未验证
  const none = await readNapcatConfig({
    napcatPath: d.launcher,
    selfId: null,
    handshake: async () => ({ state: 'unreachable', hint: '没人听' }),
  })
  check('全都连不上时仍给一个候选', !!none.onebot.picked, true)
  check('但标成未验证', none.onebot.picked.verified, false)
  check('候选都保留了', none.onebot.candidates.length, 2)
}

for (const d of tmpdirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.stdout.write(ok ? '\n全部通过\n' : '\n有失败项\n')
process.exit(ok ? 0 : 1)
