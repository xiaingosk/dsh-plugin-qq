/**
 * 会话标题的两条规则。
 *
 * 背景：DSH 里唯一「显式 resume 会话且不开回合」的 RPC 是 `session/rename`，
 * 所以唤醒一个会话时不得不调用它。但它会顺带改标题 —— 早期版本把标题直接写成
 * `QQ <机器人号>`，结果用户每次绑定/唤醒一个已有会话，那个会话就被改名，
 * 很快就出现好几个同名会话。
 *
 * 规则收敛成两条，纯函数，好测：
 *   1. 唤醒时：**永远不覆盖已有标题**，原样传回去。
 *   2. 命名时：只有插件自己新建的会话才用 `QQ <机器人号>`。
 */

/** 唤醒会话时该用的标题：有就用原来的，没有才退回 sessionId。 */
export function titleForWake(currentTitle, sessionId) {
  const t = String(currentTitle ?? '').trim()
  if (t) return t
  return String(sessionId ?? '')
}

/** 插件新建会话的标题。拿不到机器人号时退回 QQ 号，再退回固定字样。 */
export function titleForNewSession(botSelfId, userId) {
  const bot = String(botSelfId ?? '').trim()
  if (bot) return `QQ ${bot}`
  const u = String(userId ?? '').trim()
  if (u) return `QQ ${u}`
  return 'QQ 会话'
}
