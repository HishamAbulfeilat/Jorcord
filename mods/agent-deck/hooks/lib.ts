import type { AgentRow, BigOutput, Core, RateInfo, Today, Totals, TurnRec } from '../types'

export const BIG_CHARS = 20000
export const COACH_GAP_MS = 5 * 60 * 1000
export const LONG_AGENT_MS = 10 * 60 * 1000
export const MAX_AGENTS = 60
export const MAX_TURNS = 200
export const MAX_BIGS = 20

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  model?: string
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })

export const dayOf = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const emptyToday = (ms: number): Today => ({ date: dayOf(ms), tokens: 0, input: 0, output: 0, agents: 0, turns: 0 })

export const makeCore = (now: number): Core => ({
  startedAt: now,
  toolCalls: 0,
  toolStats: {},
  totals: emptyTotals(),
  models: {},
  agents: [],
  turns: [],
  bigs: [],
  ctxTokens: 0,
  ctxWindow: 0,
  ctxPct: -1,
  rates: [],
  usd: 0,
  hasCost: false,
  lastPrompt: '',
  turnCost0: 0,
  turnCount: 0,
  failStreak: {},
  alerts: { ctx: 0, rates: {}, coachAt: 0, failAt: 0 },
  today: emptyToday(now),
  isWorking: false,
})

/** Tokens that were new work for the model: fresh input, cache writes and output. */
export const weight = (u: Usage): number =>
  num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens)

/** Everything the model was shown, cached or not. */
export const promptTokens = (u: Usage): number =>
  num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)

// ---------- formatting ----------

export const fmtTok = (n: number): string => {
  if (!Number.isFinite(n)) return '0'
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

export const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const fmtUsd = (n: number): string => (n < 0.01 ? '<$0.01' : `$${n.toFixed(n < 10 ? 2 : 1)}`)

export const bar = (pct: number, width: number): string => {
  const w = Math.max(1, width)
  const filled = Math.max(0, Math.min(w, Math.round((Math.max(0, pct) / 100) * w)))
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

const SPARK = '▁▂▃▄▅▆▇█'
export const spark = (values: number[]): string => {
  if (values.length === 0) return ''
  const max = Math.max(...values, 1)
  return values.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))] ?? '▁').join('')
}

export const clip = (s: string, n: number): string => {
  const one = (s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, Math.max(0, n - 1))}…` : one
}

export const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
export const padL = (s: string, n: number): string => (s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s)

export const pctColor = (pct: number): 'success' | 'warning' | 'error' =>
  pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success'

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const spinner = (now: number): string => SPIN[Math.floor(now / 100) % SPIN.length] ?? '*'

export const cacheRate = (t: Totals): number | undefined => {
  const all = t.input + t.cacheRead + t.cacheCreate
  return all > 0 ? (t.cacheRead / all) * 100 : undefined
}

// ---------- tool helpers ----------

/** A short, harmless description of what a tool call is working on. Never throws. */
export const toolDetail = (tool: string, e: unknown): string => {
  try {
    const r = (e ?? {}) as Record<string, unknown>
    const pick = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '')
    const v =
      pick('command') || pick('file_path') || pick('pattern') || pick('url') || pick('query') || pick('path') || pick('description')
    return clip(v, 60)
  } catch {
    return ''
  }
}

/** The tip for an unusually large output, or undefined when the tool is not one we advise on. */
export const coachTip = (tool: string, chars: number): string | undefined => {
  const k = `${Math.round(chars / 1000)}k chars`
  switch (tool) {
    case 'Read':
      return `Deck tip: that Read returned ${k}. Use offset/limit, or grep first for the part you need.`
    case 'Bash':
      return `Deck tip: that command printed ${k}. Pipe through head/tail/grep, or delegate noisy work to a subagent.`
    case 'Grep':
      return `Deck tip: that search returned ${k}. Narrow the pattern or glob, or use files_with_matches mode.`
    case 'Glob':
      return `Deck tip: that glob returned ${k}. Use a tighter pattern.`
    case 'WebFetch':
      return `Deck tip: that fetch returned ${k}. Ask for a specific section, or delegate to a subagent.`
    default:
      return `Deck tip: ${tool} returned ${k}. Consider delegating this to a subagent to keep the main context small.`
  }
}

// ---------- reducers (pure, return new objects) ----------

export const onSpawn = (c: Core, a: { id: string; type: string; description: string }, now: number): Core => {
  if (c.agents.some(x => x.id === a.id)) return c
  const row: AgentRow = {
    id: a.id,
    type: clip(a.type || 'agent', 32),
    description: clip(a.description || '', 80),
    status: 'running',
    startedAt: now,
    endedAt: 0,
    tools: 0,
    lastTool: '',
    lastDetail: '',
    tokens: 0,
    summary: '',
    longAlerted: false,
  }
  return {
    ...c,
    agents: [...c.agents, row].slice(-MAX_AGENTS),
    today: { ...c.today, agents: c.today.agents + 1 },
  }
}

export const onToolStart = (c: Core, tool: string, detail: string, agentId: string | undefined): Core => {
  const st = c.toolStats[tool] ?? { n: 0, fails: 0, chars: 0, bigs: 0 }
  const next: Core = {
    ...c,
    toolCalls: c.toolCalls + 1,
    toolStats: { ...c.toolStats, [tool]: { ...st, n: st.n + 1 } },
  }
  if (agentId) {
    next.agents = c.agents.map(a =>
      a.id === agentId ? { ...a, tools: a.tools + 1, lastTool: tool, lastDetail: detail } : a,
    )
  }
  return next
}

export const onToolResult = (
  c: Core,
  tool: string,
  chars: number,
  failed: boolean,
  detail: string,
): Core => {
  const st = c.toolStats[tool] ?? { n: 0, fails: 0, chars: 0, bigs: 0 }
  const isBig = chars >= BIG_CHARS
  const bigs: BigOutput[] = isBig ? [...c.bigs, { tool, chars, detail }].slice(-MAX_BIGS) : c.bigs
  const streak = failed ? (c.failStreak[tool] ?? 0) + 1 : 0
  return {
    ...c,
    bigs,
    toolStats: {
      ...c.toolStats,
      [tool]: { ...st, fails: st.fails + (failed ? 1 : 0), chars: st.chars + chars, bigs: st.bigs + (isBig ? 1 : 0) },
    },
    failStreak: { ...c.failStreak, [tool]: streak },
  }
}

export const addUsage = (c: Core, u: Usage): Core => {
  const model = u.model || 'unknown'
  const prev = c.models[model] ?? { ...emptyTotals(), turns: 0 }
  const add = (t: Totals): Totals => ({
    input: t.input + num(u.input_tokens),
    output: t.output + num(u.output_tokens),
    cacheRead: t.cacheRead + num(u.cache_read_input_tokens),
    cacheCreate: t.cacheCreate + num(u.cache_creation_input_tokens),
  })
  const w = weight(u)
  return {
    ...c,
    totals: add(c.totals),
    models: { ...c.models, [model]: { ...add(prev), turns: prev.turns + 1 } },
    today: {
      ...c.today,
      tokens: c.today.tokens + w,
      input: c.today.input + num(u.input_tokens) + num(u.cache_creation_input_tokens),
      output: c.today.output + num(u.output_tokens),
      turns: c.today.turns + 1,
    },
  }
}

export const onAgentTurnEnd = (
  c: Core,
  agentId: string,
  u: Usage | undefined,
  reason: string,
  answer: string,
  now: number,
): Core => {
  const failed = reason === 'error' || reason === 'aborted' || reason === 'refusal'
  return {
    ...c,
    agents: c.agents.map(a =>
      a.id === agentId
        ? {
            ...a,
            status: failed ? 'failed' : 'done',
            endedAt: now,
            tokens: a.tokens + (u ? weight(u) : 0),
            summary: clip(answer || (failed ? `ended: ${reason}` : ''), 90),
          }
        : a,
    ),
  }
}

export const addTurnRec = (c: Core, rec: Omit<TurnRec, 'n'>): Core => {
  const n = c.turnCount + 1
  return { ...c, turnCount: n, turns: [...c.turns, { ...rec, n }].slice(-MAX_TURNS) }
}

export const applyMeasure = (
  c: Core,
  m: { tokens?: number; window?: number; percent?: number; rates?: RateInfo[]; usd?: number },
): Core => {
  const pct =
    typeof m.percent === 'number'
      ? m.percent
      : m.tokens !== undefined && m.window ? (m.tokens / m.window) * 100 : c.ctxPct
  return {
    ...c,
    ctxTokens: m.tokens ?? c.ctxTokens,
    ctxWindow: m.window ?? c.ctxWindow,
    ctxPct: pct,
    rates: m.rates ?? c.rates,
    usd: typeof m.usd === 'number' ? m.usd : c.usd,
    hasCost: c.hasCost || typeof m.usd === 'number',
  }
}

/** Which context alert level (0, 75, 90) is newly crossed, given the level already raised. */
export const ctxAlertLevel = (pct: number, raised: number): { level: number; fire: 0 | 75 | 90 } => {
  if (pct < 0) return { level: raised, fire: 0 }
  if (pct < 60) return { level: 0, fire: 0 }
  if (pct >= 90 && raised < 90) return { level: 90, fire: 90 }
  if (pct >= 75 && raised < 75) return { level: 75, fire: 75 }
  return { level: raised, fire: 0 }
}

/** Is this turn's token weight a spike relative to the earlier turns? */
export const isSpike = (turns: TurnRec[], tokens: number): boolean => {
  const prior = turns.filter(t => !t.agentId).map(t => t.tokens)
  if (tokens < 60000) return false
  if (prior.length < 3) return tokens >= 200000
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length
  return tokens > avg * 3
}

export const topSpenders = (c: Core, n: number): { label: string; tokens: number }[] => {
  const rows: { label: string; tokens: number }[] = []
  for (const t of c.turns) {
    if (!t.agentId) rows.push({ label: `#${t.n} ${clip(t.prompt || '(no prompt)', 40)}`, tokens: t.tokens })
  }
  for (const a of c.agents) rows.push({ label: `agent ${a.type}: ${clip(a.description, 32)}`, tokens: a.tokens })
  return rows.sort((a, b) => b.tokens - a.tokens).slice(0, n)
}

export const textSummary = (c: Core, now: number): string => {
  const t = c.totals
  const hit = cacheRate(t)
  const lines: string[] = []
  lines.push(`Session ${fmtDur(now - c.startedAt)}: in ${fmtTok(t.input + t.cacheCreate + t.cacheRead)} (cached ${fmtTok(t.cacheRead)}${hit === undefined ? '' : `, ${Math.round(hit)}% hit`}), out ${fmtTok(t.output)}, ${c.toolCalls} tool calls${c.hasCost ? `, ~${fmtUsd(c.usd)}` : ''}.`)
  if (c.ctxPct >= 0) lines.push(`Context ${fmtTok(c.ctxTokens)}/${fmtTok(c.ctxWindow)} (${Math.round(c.ctxPct)}%).`)
  const today = c.today
  lines.push(`Today: ${fmtTok(today.tokens)} tokens over ${today.turns} turns, ${today.agents} agents launched.`)
  const models = Object.entries(c.models)
  if (models.length) {
    lines.push('Per model:')
    for (const [m, v] of models) lines.push(`  ${m}: in ${fmtTok(v.input + v.cacheCreate + v.cacheRead)}, out ${fmtTok(v.output)}, ${v.turns} turns`)
  }
  if (c.agents.length) {
    lines.push('Per agent:')
    for (const a of c.agents.slice(-12)) {
      lines.push(`  ${a.status.padEnd(7)} ${a.type} - ${clip(a.description, 40)}: ${fmtTok(a.tokens)} tokens, ${a.tools} tools, ${fmtDur((a.endedAt || now) - a.startedAt)}`)
    }
  }
  const tools = Object.entries(c.toolStats).sort((a, b) => b[1].n - a[1].n)
  if (tools.length) {
    lines.push('Tool calls:')
    for (const [name, s] of tools.slice(0, 12)) {
      lines.push(`  ${name}: ${s.n}${s.fails ? `, ${s.fails} failed` : ''}${s.chars ? `, ${fmtTok(s.chars)} chars out` : ''}`)
    }
  }
  const hints: string[] = []
  for (const [name, s] of tools) {
    if (s.bigs > 0) hints.push(`${s.bigs} ${name} output(s) over ${fmtTok(BIG_CHARS)} chars: limit/head/grep first, or delegate to a subagent.`)
    if (s.fails >= 3) hints.push(`${name} failed ${s.fails} times: check its inputs before retrying.`)
  }
  if (hit !== undefined && hit < 40 && t.input + t.cacheRead + t.cacheCreate > 50000) {
    hints.push(`Cache hit rate is ${Math.round(hit)}%: long idle gaps or edits early in the prompt can invalidate the cache.`)
  }
  if (c.ctxPct >= 75) hints.push('Context is getting full: /compact, or hand bulky work to a subagent.')
  if (hints.length) {
    lines.push('Waste hints:')
    for (const h of hints) lines.push(`  - ${h}`)
  } else {
    lines.push('No waste hints so far.')
  }
  return lines.join('\n')
}
