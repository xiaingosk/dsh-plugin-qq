/**
 * 把「引用回复」拍成一行前缀。
 *
 * QQ 的引用消息里只有被引用那条的 message_id，内容要另外用 `get_msg` 去拿。
 * 拿回来之后统一拍平成 `[引用 张三：原文…]` 贴在用户消息前面 —— 这样模型能
 * 看到"他在回哪句话"，而不是只看到一句没头没尾的回答。
 *
 * 拍平逻辑是纯函数，单独放这里好测。
 */

/** 图片、表情这类非文字段，压成一个占位，别让它们撑爆前缀。 */
function segmentText(seg) {
  if (!seg || typeof seg !== 'object') return ''
  if (seg.type === 'text') return seg.data?.text ?? ''
  if (seg.type === 'image') return '[图片]'
  if (seg.type === 'face') return '[表情]'
  if (seg.type === 'at') return `@${seg.data?.qq ?? ''}`
  if (seg.type === 'forward') return '[聊天记录]'
  if (seg.type === 'file') return '[文件]'
  return ''
}

/**
 * @param {object|null} record `get_msg` 的返回
 * @param {number} limit 正文最多保留多少字
 * @returns {string|null} 拍平后的前缀；拿不到内容时返回 null
 */
export function formatQuotedMessage(record, limit = 80) {
  if (!record || typeof record !== 'object') return null
  const data = record.data && typeof record.data === 'object' ? record.data : record

  const sender = data.sender ?? {}
  const who = String(sender.card || sender.nickname || sender.user_id || '某人')

  let body = ''
  const msg = data.message ?? data.raw_message
  if (typeof msg === 'string') {
    body = msg
  } else if (Array.isArray(msg)) {
    body = msg.map(segmentText).join('')
  }
  body = body.replace(/\s+/g, ' ').trim()
  if (!body) return null

  const n = Math.max(1, Number(limit) || 80)
  const cut = body.length > n ? body.slice(0, n) + '…' : body
  return `[引用 ${who}：${cut}]`
}
