/**
 * 「这段话该怎么送到 QQ」——纯决策，不含任何副作用。
 *
 * 这块逻辑被改坏过两次，两次都是静默的：
 *   ① 早先把"工具调用之后的那段话"也丢了 —— 模型把"还要问你的问题"放在那里，
 *      用户就永远等不到。
 *   ② 后来改成一律转发，结果模型每轮都在那里补一句"已发出询问，等待确认"，
 *      用户收到 3 条正事 + 1 条废话。
 *
 * 两次是同一个根因：**工具调用之后那块文字空间，到底算不算"说话的地方"？**
 * 现在的答案是"不算"，见 planTurnEnd。所以把它从事件回调里拆出来，
 * 让每条规则都能在 test/delivery.mjs 里钉住。
 *
 * 两种模式对**过程性文字**的态度仍然相反，这是主要的分歧点：
 *
 *   管家（attach=false）  工具调用之前的文字是"喘气"。用户就在手机前等一条
 *                        结论，中间每句"我先看看"都是额外的通知音。丢掉，
 *                        只留最后一次工具调用之后那句做兜底（见 planTurnEnd）。
 *
 *   遥控（attach=true）   人在外面，看不见网页，也看不见工具在跑。这时候
 *                        "我先看看"就是唯一的进度信号，一句都不许丢，
 *                        而且要立刻发——攒到回合结束，长任务就等于全程失联。
 */

/**
 * 助手说了一段话，这一刻该怎么处理。
 *
 * @param {object} input
 * @param {boolean} input.attach 是否遥控模式（绑定到用户自己的会话）
 * @param {boolean} input.hasToolCall 这一步的助手消息里有没有工具调用
 * @param {string} input.text 已经是纯文本、已转好格式的文字（可能为空串）
 * @returns {{ action: 'send'|'collect'|'reset'|'drop', text: string }}
 *   send    立刻发出去（遥控模式）
 *   collect 先留着，回合结束时由 planTurnEnd 决定要不要兜底
 *   reset   把之前留的清掉（工具调用之前的文字是过程性输出）
 *   drop    这段没内容，什么也不做
 */
export function planAssistantText({ attach, hasToolCall, text } = {}) {
  // 纯空白等于没说：mdToPlain 之后可能只剩换行，发出去就是一条空气泡
  const body = String(text ?? '').trim()

  if (attach) {
    // 遥控：有字就发，没字就等下一步。工具调用与否不影响判断——
    // 过程性文字本身就是要送的东西。
    return body ? { action: 'send', text: body } : { action: 'drop', text: '' }
  }

  // 管家：这一步要调工具，说这些是为了调工具，不是给用户的结论。
  // 注意即使带文字也要 reset —— 那正是"我先看看"。
  if (hasToolCall) return { action: 'reset', text: '' }

  if (!body) return { action: 'drop', text: '' }
  return { action: 'collect', text: body }
}

/**
 * 回合结束了，还没送出去的东西怎么处理。
 *
 * 这里有一条硬规矩：**只要这一轮用过 qq_send_message，收尾那段文字就不转。**
 *
 * 为什么：回合必须等到一条"没有任何工具调用的助手消息"才结束，所以模型
 * 在最后一次工具调用之后永远还有一格文字空间。它以为那是"还能补一句"，
 * 于是写出了"已发出询问，等待用户确认后再去 D 盘取文件"。提示词里禁止过，
 * 换个说法就绕过去了——列举式禁令挡不住同义改写，只能从机制上关掉这块地方。
 *
 * 保留的兜底：**整轮一次 qq_send_message 都没用过**，却有文字。那说明模型
 * 压根没走通道（或者这个壳子里压根没那个工具），这段文字就是唯一能到用户
 * 手上的东西，必须转发，否则用户对着空气等。
 *
 * @param {object} input
 * @param {boolean} input.usedTool 这一轮有没有通过 qq_send_message 发过话
 * @param {boolean} input.sentAny 这一轮有没有已经送出去过东西（遥控模式的即时转发）
 * @param {string} input.tail 收尾时还没送出去的文字
 * @param {string} input.reason 回合结束的原因（completed / cancelled / ...）
 * @returns {{ action: 'relay'|'placeholder'|'none', text?: string, reason?: string }}
 */
export function planTurnEnd({ usedTool, sentAny, tail, reason } = {}) {
  const body = String(tail ?? '').trim()

  if (body) {
    // 说过话了 → 这是那句"我以为还能补一句"的状态说明，丢掉
    if (usedTool) return { action: 'none' }
    // 没说过话 → 兜底，这是唯一能到用户手上的东西
    return { action: 'relay', text: body }
  }

  // 整轮既没说话也没用工具：给个占位，别让用户对着空气等
  if (!usedTool && !sentAny) return { action: 'placeholder', reason }
  return { action: 'none' }
}

/**
 * 一整轮结束了，却没有任何文字送出去时的兜底话术。
 *
 * 完全不说话要告诉用户一声，否则他对着 QQ 干等，分不清是"在干活"还是"挂了"。
 * reason 来自 DSH 的 turn/end 事件。
 */
export function placeholderFor(reason) {
  return reason === 'completed' ? '（这一轮没有文字输出）' : `（这一轮以 ${reason} 结束）`
}
