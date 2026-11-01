/**
 * 插件配置。
 *
 * 没有 settings 服务，所以自己读 JSON 文件：
 *   默认 ~/.dsh/dsh-plugin-qq.json
 *   不存在就用默认值（不报错，首次运行很正常）
 *
 * 设置界面做出来之前，改配置就是改这个文件。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const CONFIG_PATH = join(DSH_HOME, 'dsh-plugin-qq.json')

export const DEFAULTS = {
  enabled: false, // 总开关：true 才真正连 QQ
  selftest: true, // 加载时跑一次 DSH 内部连通性自测
  whitelist: [], // 允许驱动电脑的 QQ 号；空 = 谁都不理
  allowAllWhenEmpty: false,
  // 默认放在 DSH 自己的目录下：任何机器上都存在且可写。
  // 不要硬编码某个盘符下的路径——换台机器就失效了。
  workspace: join(DSH_HOME, 'qq-workspace'),

  /**
   * NapCat 启动脚本的路径（用户填一次，记下来）。
   * 只用来在设置页「打开所在文件夹」时定位——插件不会执行它。
   */
  napcatPath: '',

  /**
   * 注入到「QQ 会话」的系统提示，只对管家模式（插件自己建的会话）生效。
   *
   * 行为契约的正主是 agent preset「QQ 管家」（见 cordis.patch.yml）；这一段只是
   * **没装上 preset 时的退路**（老版本 DSH，或者只装了插件没装 bundle）。
   * **设置页没有它的入口**——契约只在 preset 里改。真有人手改这个 JSON，
   * 说明他知道自己在做什么，插件不拦（它排在契约之前，order -90）。
   * 设成空字符串就不注入。
   */
  qqSystemPrompt: [
    '你在通过 QQ 私聊和用户说话，对方在手机上看。',
    '',
    '· 带 [QQ] 前缀的消息来自 QQ，是用户在跟你说话。回复必须用 qq_send_message 发出——你输出的普通文字传不到 QQ。',
    '· messages 是数组，一个元素一条。每条不超过 30 字，只讲一件事；要讲两件事就发两条。',
    '· 结论放第一句。不复述用户刚说的话，不解释你接下来要做什么。',
    '· 不用 Markdown：不要表格、不要 # 标题、不要代码块围栏、不要加粗星号。QQ 不渲染，只会显示成乱字符。',
    '· 不用说"收到""好的"这类客套话；结束时也不要写"消息已发送""等用户回复""任务完成"。',
    '· 需要用户拍板时，用一句话直接问，然后结束这一轮等回复。',
  ].join('\n'),

  /**
   * 人设：你是谁、怎么称呼对方、什么语气。
   *
   * 这是**设置页唯一能编辑的提示词**，排在「QQ 管家」契约之后（order 10），
   * 而且每轮注入——改完下一条消息就生效，已经存在的会话也跟着变。
   *
   * 留空 = 不注入，模型按契约里的默认人设说话。参考 qq-bridge 的做法：
   * 人格卡只写人设，不写工具用法（工具协议会变，写进去必然过期）。
   */
  qqPersona: '',

  onebot: {
    url: 'ws://127.0.0.1:3001',
    token: '',
  },
  behavior: {
    ackMessage: '',
    // 投给模型时给消息加的前缀。模型据此区分"这是 QQ 来的，必须走工具回复"。
    promptPrefix: '[QQ] ',
    coalesceWindowMs: 2000,
    sendChunkSize: 4000,
    pollIntervalMs: 1200,
    replyTimeoutMs: 600000,
    convertMarkdown: true,
  },
}

/** 深合并两个普通对象。数组直接替换，不合并。 */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] ? merge(base[k], v) : v
  }
  return out
}

export function loadConfig() {
  let user = {}
  let found = false
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
      found = true
    } catch (err) {
      user = {}
      console.error(`[qq-plugin] 配置文件解析失败，用默认值: ${err.message}`)
    }
  }
  return { config: merge(DEFAULTS, user), found }
}
