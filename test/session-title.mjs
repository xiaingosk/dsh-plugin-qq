/**
 * lib/session-title.js 的单测。
 *
 * 这一组是**回归防线**：曾经的 bug 是「绑定/唤醒一个已有会话时把它改名」，
 * 用户很快就攒出好几个同名会话。规则很简单，但写错了就是数据损失
 * （原标题被覆盖后无处可查）。
 */
import { titleForWake, titleForNewSession } from '../lib/session-title.js'

let ok = true
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) ok = false
  process.stdout.write(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n      期望 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`}\n`)
}

process.stdout.write('\n[titleForWake —— 唤醒时绝不覆盖原标题]\n')

check('有标题就原样保留', titleForWake('第七周作业', 'session-abc'), '第七周作业')
check('用户自己起的名字不动', titleForWake('帮我看下这个表格', 'session-abc'), '帮我看下这个表格')
check('就算旧标题是 QQ 号也不动', titleForWake('QQ 3166153003', 'session-abc'), 'QQ 3166153003')
check('标题是空的才退回 sessionId', titleForWake(null, 'session-abc'), 'session-abc')
check('空字符串同样退回', titleForWake('', 'session-abc'), 'session-abc')
check('全空白也算空', titleForWake('   ', 'session-abc'), 'session-abc')
check('什么都没给时返回空串而不是崩', titleForWake(undefined, undefined), '')

process.stdout.write('\n[titleForNewSession —— 只有新建会话才命名]\n')

check('有机器人号就用它', titleForNewSession('3166153003', '2076255291'), 'QQ 3166153003')
check('没机器人号退回用户 QQ', titleForNewSession(null, '2076255291'), 'QQ 2076255291')
check('都没有时给固定字样', titleForNewSession(undefined, undefined), 'QQ 会话')
check('数字会转成字符串', titleForNewSession(3166153003, 2076255291), 'QQ 3166153003')

process.stdout.write(ok ? '\n全部通过\n' : '\n有失败项\n')
process.exit(ok ? 0 : 1)
