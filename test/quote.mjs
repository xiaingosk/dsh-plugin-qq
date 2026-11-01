/**
 * lib/quote.js 的单测。
 *
 * 这些用例都是真实 `get_msg` 返回的形状（数组消息 / raw_message / 卡片昵称），
 * 不是编的——拍平写错的话，模型会看到一段没头没尾的引用。
 */
import { formatQuotedMessage } from '../lib/quote.js'

let ok = true
const check = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) ok = false
  process.stdout.write(`  ${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n      期望 ${JSON.stringify(want)}\n      得到 ${JSON.stringify(got)}`}\n`)
}

process.stdout.write('\n[formatQuotedMessage]\n')

check(
  '数组消息取 text 段',
  formatQuotedMessage({ sender: { nickname: '小名' }, message: [{ type: 'text', data: { text: '你好呀' } }] }),
  '[引用 小名：你好呀]',
)

check(
  '优先用群名片 card',
  formatQuotedMessage({ sender: { card: '别名', nickname: '小名' }, raw_message: '原文' }),
  '[引用 别名：原文]',
)

check(
  '没有昵称就退回 QQ 号',
  formatQuotedMessage({ sender: { user_id: 123 }, message: [{ type: 'text', data: { text: '在' } }] }),
  '[引用 123：在]',
)

check(
  '图片压成占位',
  formatQuotedMessage({
    sender: { nickname: 'a' },
    message: [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: {} }],
  }),
  '[引用 a：看这个[图片]]',
)

check(
  '表情也压成占位',
  formatQuotedMessage({ sender: { nickname: 'a' }, message: [{ type: 'face', data: {} }] }),
  '[引用 a：[表情]]',
)

check(
  '超长按字数截断并加省略号',
  formatQuotedMessage({ sender: { nickname: 'a' }, raw_message: '字'.repeat(200) }, 10),
  '[引用 a：' + '字'.repeat(10) + '…]',
)

check(
  '内容够短时不加省略号',
  formatQuotedMessage({ sender: { nickname: 'a' }, raw_message: '短' }, 10),
  '[引用 a：短]',
)

check('空白内容返回 null', formatQuotedMessage({ sender: { nickname: 'a' }, message: [{ type: 'text', data: { text: '   ' } }] }), null)
check('空数组返回 null', formatQuotedMessage({ sender: { nickname: 'a' }, message: [] }), null)
check('null 返回 null', formatQuotedMessage(null), null)
check('非对象返回 null', formatQuotedMessage('x'), null)
check('折行被压成单空格', formatQuotedMessage({ sender: { nickname: 'a' }, raw_message: '第一行\n第二行' }), '[引用 a：第一行 第二行]')

process.stdout.write(ok ? '\n全部通过\n' : '\n有失败项\n')
process.exit(ok ? 0 : 1)
