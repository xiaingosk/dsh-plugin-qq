/**
 * lib/napcat-detect.js 里「纯逻辑」部分的单测。
 *
 * 真正跑 PowerShell 追进程的那部分不在这里测 —— 那依赖本机装了什么样的进程，
 * 没法在测试里稳定复现。这里只保证"拿到链之后怎么判断"是对的，
 * 而那正是容易写错的地方。
 */
import { join } from 'node:path'
import { findRootFromChain, pickLauncher, processChainScript } from '../lib/napcat-detect.js'

let ok = true
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) ok = false
  process.stdout.write(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n      期望 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`}\n`)
}

process.stdout.write('\n[findRootFromChain]\n')

// 真实形状：QQ → QQ → NapCatWinBootMain（这一层有 config/webui.json）→ cmd → explorer
const chain = [
  { pid: 8556, ppid: 21856, path: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe' },
  { pid: 21856, ppid: 31516, path: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe' },
  { pid: 31516, ppid: 30824, path: 'D:\\NapCatShell\\NapCatWinBootMain.exe' },
  { pid: 30824, ppid: 3900, path: 'C:\\WINDOWS\\system32\\cmd.exe' },
  { pid: 3900, ppid: 1788, path: 'C:\\WINDOWS\\explorer.exe' },
]
const onlyNapcat = (dir) => dir === 'D:\\NapCatShell'

const hit = findRootFromChain(chain, onlyNapcat)
check('挑出含 config/webui.json 的那一层', hit?.root, 'D:\\NapCatShell')
check('一并带回 pid 和 exe 路径', [hit?.byPid, hit?.exePath], [31516, 'D:\\NapCatShell\\NapCatWinBootMain.exe'])
check('没有匹配的层时返回 null', findRootFromChain(chain, () => false), null)
check('传入不是数组时返回 null', findRootFromChain(null, onlyNapcat), null)
check(
  'path 为 null 的层跳过',
  findRootFromChain([{ pid: 1, path: null }, { pid: 2, path: 'D:\\X\\a.exe' }], (d) => d === 'D:\\X')?.root,
  'D:\\X',
)

process.stdout.write('\n[pickLauncher]\n')
const has = (list) => (full) => list.includes(full)
check('优先用户级脚本', pickLauncher('D:\\N', has([join('D:\\N', 'launcher-user.bat'), join('D:\\N', 'launcher.bat')])), join('D:\\N', 'launcher-user.bat'))
check('没有用户级就用通用', pickLauncher('D:\\N', has([join('D:\\N', 'launcher.bat')])), join('D:\\N', 'launcher.bat'))
check('都没有返回 null', pickLauncher('D:\\N', () => false), null)

process.stdout.write('\n[processChainScript]\n')
const s = processChainScript(3001)
check('脚本里带上端口', s.includes('3001'), true)
check('只查 Listen 状态', s.includes('-State Listen'), true)
check('向上最多追 6 层', s.includes('-lt 6'), true)
check('非法端口退化成 0（不会注入命令）', processChainScript('3001; rm -rf /').includes('3001;'), false)
check('NaN 也退化成 0', processChainScript(NaN).includes('-LocalPort 0'), true)

process.stdout.write(ok ? '\n全部通过\n' : '\n有失败项\n')
process.exit(ok ? 0 : 1)
