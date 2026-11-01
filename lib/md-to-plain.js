/**
 * Markdown → QQ 纯文本。
 *
 * QQ 私聊不渲染 Markdown：`#`、`**`、表格竖线、代码围栏、LaTeX 全都会原样显示。
 * 这里做确定性的降级，不依赖模型自觉。
 *
 * 规则参考 Derpyu520/qq-bridge 的 md-to-plain.js，在此基础上改了三处：
 *   1. 表格中间的竖线换成 ` · `（他们保留原样，手机上看着像乱码）
 *   2. 表格识别改成「首尾都是 | 的行」，避免误伤正文里的单个竖线
 *   3. 加了 LaTeX 公式的 Unicode 降级
 *
 * 三个已知陷阱都在注释里标了，改动时别踩回去。
 */

/** 表格分隔行：只有 | - : 和空白，且至少有一个 - */
function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

// ---------------- LaTeX → Unicode ----------------

const SUP = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  n: 'ⁿ', i: 'ⁱ', x: 'ˣ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', k: 'ᵏ', m: 'ᵐ',
  o: 'ᵒ', p: 'ᵖ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', y: 'ʸ', z: 'ᶻ',
}
const SUB = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', i: 'ᵢ', n: 'ₙ', k: 'ₖ', m: 'ₘ', p: 'ₚ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ',
}
const SYMBOLS = {
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
  '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ',
  '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ', '\\sigma': 'σ', '\\tau': 'τ',
  '\\phi': 'φ', '\\chi': 'χ', '\\psi': 'ψ', '\\omega': 'ω',
  '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ', '\\Pi': 'Π',
  '\\Sigma': 'Σ', '\\Phi': 'Φ', '\\Psi': 'Ψ', '\\Omega': 'Ω',
  '\\times': '×', '\\div': '÷', '\\cdot': '·', '\\pm': '±', '\\mp': '∓',
  '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\ne': '≠', '\\neq': '≠',
  '\\approx': '≈', '\\equiv': '≡', '\\sim': '∼', '\\propto': '∝',
  '\\infty': '∞', '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←',
  '\\Rightarrow': '⇒', '\\Leftarrow': '⇐', '\\iff': '⇔',
  '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\supset': '⊃',
  '\\cup': '∪', '\\cap': '∩', '\\forall': '∀', '\\exists': '∃',
  '\\sum': '∑', '\\prod': '∏', '\\int': '∫', '\\partial': '∂', '\\nabla': '∇',
  '\\sqrt': '√', '\\angle': '∠', '\\perp': '⊥', '\\parallel': '∥',
  '\\degree': '°', '\\circ': '∘', '\\ldots': '…', '\\dots': '…',
  '\\quad': ' ', '\\qquad': ' ', '\\,': ' ', '\\;': ' ',
  '\\left': '', '\\right': '', '\\displaystyle': '',
  '\\mathrm': '', '\\mathbf': '', '\\mathit': '', '\\text': '',
}

/** 把一串字符映射成上下标；有一个映射不了就退回 `^(...)` 写法。 */
function mapScript(content, table, marker) {
  let out = ''
  for (const ch of content) {
    if (table[ch] !== undefined) out += table[ch]
    else return `${marker}(${content})`
  }
  return out
}

/**
 * LaTeX 片段 → Unicode 近似。转换不干净时返回 null，交给调用方退回原文。
 * @param {string} src
 * @returns {string|null}
 */
export function latexToUnicode(src) {
  let s = String(src ?? '').trim()
  if (!s) return null

  // 去掉定界符残留
  s = s.replace(/^\\\(|\\\)$/g, '').replace(/^\\\[|\\\]$/g, '').trim()

  // \sqrt{x} → √x　（必须先做，否则 \frac{\sqrt{3}}{2} 里的嵌套花括号会打断下面的匹配）
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a) => `√${a}`)
  // \frac{a}{b} → a/b
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a, b) => `${a}/${b}`)
  // 上标：^{...} 或 ^x
  s = s.replace(/\^\{([^{}]*)\}/g, (_, a) => mapScript(a, SUP, '^'))
  s = s.replace(/\^(\w)/g, (_, a) => mapScript(a, SUP, '^'))
  // 下标
  s = s.replace(/_\{([^{}]*)\}/g, (_, a) => mapScript(a, SUB, '_'))
  s = s.replace(/_(\w)/g, (_, a) => mapScript(a, SUB, '_'))
  // 符号表（长键先替换，避免 \le 吃掉 \leq）
  for (const key of Object.keys(SYMBOLS).sort((a, b) => b.length - a.length)) {
    s = s.split(key).join(SYMBOLS[key])
  }
  // 剩余的 {} 只是分组，去掉
  s = s.replace(/[{}]/g, '')
  // 空白规整
  s = s.replace(/\s+/g, ' ').trim()

  // 还有反斜杠命令没处理掉 → 判定为转换不干净
  if (/\\[a-zA-Z]+/.test(s)) return null
  return s
}

// ---------------- 行内清洗 ----------------

const FORMULA_TOKEN = '\u0001F'

/** 行内序列的通用清洗（不含块级结构）。 */
function cleanInline(s, formulas) {
  // 公式占位符先还原（放在最前面，避免被粗体/斜体正则破坏）
  s = s.replace(/\u0001F(\d+)\u0001/g, (_, i) => formulas[Number(i)] ?? '')

  // 图片：留 alt（没有 alt 就留 URL）
  // 上限 500/2000 是为了防 O(n²)：模型被诱导输出大量 "![" 时，`[^\]]*` 每次都要扫到串尾。
  s = s.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt, url) => alt || url)
  // 链接：文字 (url)
  s = s.replace(/\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/g, '$1 ($2)')
  // 粗体 / 删除线
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/~~([^~\n]+)~~/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  // 单个 * 的斜体：两个条件缺一不可
  //   ① 不跨行 —— 否则行首 `* ` 列表项和后面的 `*` 会被当成一对标记
  //   ② 开闭标记都不能贴空白 —— 否则 "2 * 3 * 4" 这种乘法式会被整段吃掉
  s = s.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1')
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1')
  return s
}

/** 把文本里所有公式抽出来换成占位符，返回处理后的文本和公式表。 */
function extractFormulas(s) {
  const formulas = []

  const push = (raw, display) => {
    const converted = latexToUnicode(raw)
    const text = converted === null ? `[公式] ${raw.trim()}` : converted
    formulas.push(display && text ? `  ${text}  ` : text)
    return `${FORMULA_TOKEN}${formulas.length - 1}\u0001`
  }

  // 块级公式 $$...$$
  s = s.replace(/\$\$([\s\S]{1,2000}?)\$\$/g, (_, body) => push(body, true))
  // 行内公式 $...$：开闭标记都不能贴空白，避免把 "$5 and $10" 当成公式
  s = s.replace(/\$(?!\s)([^$\n]{1,300}?)(?<!\s)\$/g, (_, body) => {
    // 太像普通文字的就不当公式（至少要有数学痕迹）
    if (!/[\\^_={}<>+\-*/]/.test(body)) return `$${body}$`
    return push(body, false)
  })
  return { text: s, formulas }
}

// ---------------- 主函数 ----------------

/**
 * 把 Markdown 转成适合 QQ 显示的纯文本。
 * @param {string} md
 * @returns {string}
 */
export function mdToPlain(md) {
  let s = String(md ?? '')

  // 0. 先把公式抽走，避免被其它规则破坏
  const { text: withTokens, formulas } = extractFormulas(s)
  s = withTokens

  // 1. 代码块：去掉围栏，保留内容（内容里的 Markdown 标记不再处理）
  s = s.replace(
    /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g,
    (_, body) => '\u0000CODE\u0000' + body.replace(/\n+$/, '') + '\u0000/CODE\u0000',
  )

  // 2. 块级结构逐行处理
  const out = []
  for (const raw of s.split('\n')) {
    const line = raw
    const t = line.trim()

    if (t.startsWith('\u0000CODE\u0000')) {
      out.push(t.replace('\u0000CODE\u0000', '').replace('\u0000/CODE\u0000', ''))
      continue
    }
    if (isSeparatorRow(t)) continue
    if (/^\|.*\|$/.test(t)) {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim())
      out.push(cleanInline(cells.filter((c) => c !== '').join(' · '), formulas))
      continue
    }
    if (/^#{1,6}\s+/.test(t)) {
      out.push(cleanInline(t.replace(/^#{1,6}\s+/, ''), formulas))
      continue
    }
    if (/^>\s?/.test(t)) {
      out.push(cleanInline(t.replace(/^>\s?/, ''), formulas))
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push(cleanInline(line.replace(/^\s*[-*+]\s+/, '• '), formulas))
      continue
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      out.push(cleanInline(line.trim(), formulas))
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(t)) continue
    out.push(cleanInline(line, formulas))
  }
  s = out.join('\n')

  // 3. 折叠多余空行
  s = s.replace(/[ \t]+$/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}
