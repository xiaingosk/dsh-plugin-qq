/**
 * lib/delivery.js 的单测。
 *
 * 这块逻辑被改坏过两次，两次都是**静默**的：用户只看到"消息少了"或
 * "同一条发了两遍"，日志里一个错都没有。所以每种组合都要钉住。
 */
import { planAssistantText, planTurnEnd, placeholderFor } from '../lib/delivery.js'

let ok = true
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) ok = false
  process.stdout.write(
    `  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n      期望 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`}\n`,
  )
}

process.stdout.write('\n[planAssistantText · 管家模式]\n')

check(
  '调工具 + 带"喘气"文字 → 清空已攒的（这句是过程，不是结论）',
  planAssistantText({ attach: false, hasToolCall: true, text: '我先看看文件' }),
  { action: 'reset', text: '' },
)

check(
  '调工具 + 没文字 → 一样要清空（上一步攒的也不能留）',
  planAssistantText({ attach: false, hasToolCall: true, text: '' }),
  { action: 'reset', text: '' },
)

check(
  '不调工具 + 有文字 → 攒着，回合结束统一发',
  planAssistantText({ attach: false, hasToolCall: false, text: '结论是好的' }),
  { action: 'collect', text: '结论是好的' },
)

check(
  '不调工具 + 没文字 → 什么也不做',
  planAssistantText({ attach: false, hasToolCall: false, text: '' }),
  { action: 'drop', text: '' },
)

process.stdout.write('\n[planAssistantText · 遥控模式]\n')

check(
  '调工具 + 带文字 → 立刻发（这是唯一的进度信号，不能丢）',
  planAssistantText({ attach: true, hasToolCall: true, text: '我先看看文件' }),
  { action: 'send', text: '我先看看文件' },
)

check(
  '不调工具 + 有文字 → 也是立刻发，不等回合结束',
  planAssistantText({ attach: true, hasToolCall: false, text: '好了，都改完了' }),
  { action: 'send', text: '好了，都改完了' },
)

check(
  '调工具 + 没文字 → 不做事（别发空消息）',
  planAssistantText({ attach: true, hasToolCall: true, text: '' }),
  { action: 'drop', text: '' },
)

check('不调工具 + 没文字 → 不做事', planAssistantText({ attach: true, hasToolCall: false, text: '' }), {
  action: 'drop',
  text: '',
})

process.stdout.write('\n[planAssistantText · 边界]\n')

check('附件名之类的空白文字不该当成消息', planAssistantText({ attach: true, text: '   ' }), {
  action: 'drop',
  text: '',
})

check('没有参数也不炸', planAssistantText(), { action: 'drop', text: '' })

process.stdout.write('\n[planTurnEnd · 收尾那段文字怎么处理]\n')

check(
  '用过工具 + 收尾有"已发出询问…" → 丢掉（这就是那个 bug）',
  planTurnEnd({ usedTool: true, sentAny: false, tail: '已发出询问，等待用户确认后再去 D 盘取文件。', reason: 'completed' }),
  { action: 'none' },
)

check(
  '没用过工具 + 收尾有文字 → 兜底转发（模型没走通道，这是唯一能到用户手上的东西）',
  planTurnEnd({ usedTool: false, sentAny: false, tail: '工作区里没有 hanoi.c', reason: 'completed' }),
  { action: 'relay', text: '工作区里没有 hanoi.c' },
)

check(
  '用过工具 + 没有收尾文字 → 什么也不做（别发占位，用户已经收到消息了）',
  planTurnEnd({ usedTool: true, sentAny: false, tail: '', reason: 'completed' }),
  { action: 'none' },
)

check(
  '没用过工具 + 没有文字 → 占位（别让用户对着空气等）',
  planTurnEnd({ usedTool: false, sentAny: false, tail: '', reason: 'completed' }),
  { action: 'placeholder', reason: 'completed' },
)

check(
  '遥控模式已经即时转发过 + 没有收尾文字 → 什么也不做',
  planTurnEnd({ usedTool: false, sentAny: true, tail: '', reason: 'completed' }),
  { action: 'none' },
)

check(
  '收尾只有空白 → 当成没有文字',
  planTurnEnd({ usedTool: false, sentAny: false, tail: '  \n ', reason: 'completed' }),
  { action: 'placeholder', reason: 'completed' },
)

check('没有参数也不炸', planTurnEnd(), { action: 'placeholder', reason: undefined })

process.stdout.write('\n[placeholderFor]\n')

check('正常结束', placeholderFor('completed'), '（这一轮没有文字输出）')
check('被取消', placeholderFor('cancelled'), '（这一轮以 cancelled 结束）')
check('出错也要有话说', placeholderFor('error'), '（这一轮以 error 结束）')

process.stdout.write(ok ? '\n全部通过\n' : '\n有失败\n')
process.exit(ok ? 0 : 1)
