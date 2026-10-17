import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Core, RateInfo, Today } from '../types'
import {
  BIG_CHARS,
  COACH_GAP_MS,
  LONG_AGENT_MS,
  addTurnRec,
  addUsage,
  applyMeasure,
  bar,
  cacheRate,
  clip,
  coachTip,
  ctxAlertLevel,
  dayOf,
  emptyToday,
  fmtDur,
  fmtTok,
  fmtUsd,
  isSpike,
  makeCore,
  onAgentTurnEnd,
  onSpawn,
  onToolResult,
  onToolStart,
  pad,
  padL,
  pctColor,
  spark,
  spinner,
  textSummary,
  toolDetail,
  topSpenders,
  weight,
} from './lib'
import type { Usage } from './lib'

// Observe-only: this mod never denies, rewrites or delays anything. Every hook is wrapped so a
// failure in the mod's own bookkeeping can not reach the turn.

const PANE = 'deck'
const core = atom({ plugin: 'agent-deck', key: 'core' } as const, makeCore(0))

const safe = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
  try {
    await fn()
  } catch {
    // the mod must never break a turn
  }
}

const rateName = (kind: string): string =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'weekly' : kind === 'spend_limit' ? 'spend' : kind

let booted: Promise<void> | undefined
let live = false
let ticks = 0

async function loadDaily($: EngineInterface, date: string): Promise<Today | undefined> {
  const daily = (await $.store.get('daily')) as Record<string, Today> | undefined
  const t = daily?.[date]
  return t && typeof t.tokens === 'number' ? t : undefined
}

async function saveDaily($: EngineInterface, t: Today): Promise<void> {
  const daily = ((await $.store.get('daily')) as Record<string, Today> | undefined) ?? {}
  daily[t.date] = t
  const keys = Object.keys(daily).sort()
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete daily[k]
  await $.store.set('daily', daily)
}

async function watchAgents($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const c = await read($, core)
  live = c.isWorking || c.agents.some(a => a.status === 'running')
  const late = c.agents.filter(a => a.status === 'running' && !a.longAlerted && now - a.startedAt > LONG_AGENT_MS)
  if (late.length === 0) return
  await update($, core, cur => ({
    ...cur,
    agents: cur.agents.map(a => (late.some(l => l.id === a.id) ? { ...a, longAlerted: true } : a)),
  }))
  for (const a of late) {
    $.ui.toast(`Subagent "${clip(a.description || a.type, 40)}" has run ${fmtDur(now - a.startedAt)}. Check the Agent Deck (/deck) or interrupt it.`, { timeoutMs: 10000 })
  }
}

function boot($: EngineInterface): Promise<void> {
  if (booted) return booted
  booted = (async () => {
    const now = await $.clock.now()
    const cur = await read($, core)
    if (cur.startedAt === 0) {
      const today = (await loadDaily($, dayOf(now))) ?? emptyToday(now)
      await update($, core, c => (c.startedAt === 0 ? { ...makeCore(now), today } : c))
    }
    $.clock.every(1000, () => {
      void safe(async () => {
        ticks += 1
        if (live || ticks % 30 === 0) $.ui.invalidate('ui.render')
        if (ticks % 15 === 0) await watchAgents($)
      })
    })
  })().catch(() => {
    booted = undefined
  })
  return booted
}

export const register: Register = on => {
  // ---------- session ----------

  on('session.start', async ($, e, next) => {
    await safe(async () => {
      await $.command.register({ name: 'deck', description: 'Agent Deck pane: /deck, /deck off, /deck reset', argumentHint: '[off|reset]' })
      await $.command.register({ name: 'tokens', description: 'Token, tool and waste summary for this session' })
      await boot($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await safe(async () => {
      if (e.reason === 'clear') {
        const now = await $.clock.now()
        await update($, core, c => ({ ...makeCore(now), today: c.today }))
      }
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await safe(async () => {
      await boot($)
      const rates: RateInfo[] = (e.rateLimits ?? []).map(r => ({ kind: String(r.kind), pct: Number(r.percentUsed) || 0 }))
      let fire = 0 as number
      let cleared = false as boolean
      const fireRates: { kind: string; level: number; pct: number }[] = []
      let ctxPct = -1
      await update($, core, c => {
        fire = 0
        cleared = false
        fireRates.length = 0
        const m = applyMeasure(c, {
          tokens: e.context?.tokens,
          window: e.context?.window,
          percent: e.context?.percent,
          rates,
          usd: e.cost?.usd,
        })
        ctxPct = m.ctxPct
        const a = ctxAlertLevel(m.ctxPct, c.alerts.ctx)
        fire = a.fire
        cleared = c.alerts.ctx > 0 && a.level === 0
        const ratesState = { ...c.alerts.rates }
        for (const r of rates) {
          const prev = ratesState[r.kind] ?? 0
          const level = r.pct >= 95 ? 95 : r.pct >= 80 ? 80 : r.pct < 70 ? 0 : prev
          if (level > prev) fireRates.push({ kind: r.kind, level, pct: r.pct })
          ratesState[r.kind] = level
        }
        return { ...m, alerts: { ...c.alerts, ctx: a.level, rates: ratesState } }
      })
      if (fire === 75) {
        $.ui.toast(`Context ${Math.round(ctxPct)}% full. Consider /compact, or delegate bulky reads to a subagent.`, { timeoutMs: 8000 })
      } else if (fire === 90) {
        $.ui.toast(`Context ${Math.round(ctxPct)}% full! /compact now, or hand the next big task to a subagent.`, { timeoutMs: 12000 })
        $.ui.status(`agent-deck: context ${Math.round(ctxPct)}% - /compact soon`)
      }
      if (fire !== 90) $.ui.status(`agent-deck: context ${Math.round(ctxPct)}%`)
      for (const r of fireRates) {
        const resets = (e.rateLimits ?? []).find(x => x.kind === r.kind)?.resetsAt
        $.ui.toast(`${rateName(r.kind)} usage window at ${Math.round(r.pct)}%${resets ? `, resets ${resets}` : ''}.`, { timeoutMs: 10000 })
      }
    })
    return next(e)
  })

  // ---------- prompts and turns ----------

  on('prompt.submit', async ($, e, next) => {
    await safe(async () => {
      await boot($)
      const text = clip(typeof e.text === 'string' ? e.text : '', 80)
      await update($, core, c => ({ ...c, lastPrompt: text }))
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await safe(async () => {
      live = true
      await update($, core, c => ({ ...c, isWorking: true, turnCost0: c.usd }))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await safe(async () => {
      await boot($)
      const now = await $.clock.now()
      const u = e.usage as Usage | undefined
      const agentId = e.agentId
      let spike = 0
      let saved: Today | undefined
      await update($, core, c0 => {
        spike = 0
        let c = c0
        if (c.today.date !== dayOf(now)) c = { ...c, today: emptyToday(now) }
        if (u) c = addUsage(c, u)
        if (agentId) {
          c = onAgentTurnEnd(c, agentId, u, e.reason, e.answer, now)
        } else {
          const tokens = u ? weight(u) : 0
          if (u && isSpike(c.turns, tokens)) spike = tokens
          c = addTurnRec(c, {
            prompt: c.lastPrompt,
            agentId: '',
            model: u?.model ?? '',
            tokens,
            output: u?.output_tokens ?? 0,
            usd: c.hasCost ? Math.max(0, c.usd - c.turnCost0) : 0,
          })
          c = { ...c, isWorking: false }
        }
        saved = c.today
        return c
      })
      live = false
      void watchAgents($).catch(() => {})
      if (spike > 0) {
        $.ui.toast(`Token spike: that turn used ${fmtTok(spike)} tokens, well above your usual. Check what it read.`, { timeoutMs: 8000 })
      }
      if (saved) await saveDaily($, saved)
    })
    return next(e)
  })

  // ---------- subagents ----------

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await safe(async () => {
      await boot($)
      const agentId = (r as { agentId?: string }).agentId
      if (!agentId) return
      const now = await $.clock.now()
      live = true
      const c = await update($, core, cur => onSpawn(cur, { id: agentId, type: e.subagentType, description: e.description }, now))
      await saveDaily($, c.today)
    })
    return r
  })

  // ---------- tool calls ----------

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const detail = toolDetail(tool, e)
    const agentId = e.agentId
    await safe(() => update($, core, c => onToolStart(c, tool, detail, agentId)))
    const ran = await next(e)
    await safe(async () => {
      const now = await $.clock.now()
      const chars = typeof ran.text === 'string' ? ran.text.length : 0
      const failed = ran.deny !== undefined || ran.isError === true
      let streak = 0
      let coach: string | undefined
      await update($, core, c0 => {
        streak = 0
        coach = undefined
        let c = onToolResult(c0, tool, chars, failed, detail)
        streak = c.failStreak[tool] ?? 0
        const isDelegation = tool === 'Agent' || tool === 'Task'
        if (chars >= BIG_CHARS && !isDelegation && now - c.alerts.coachAt >= COACH_GAP_MS) {
          coach = coachTip(tool, chars)
          c = { ...c, alerts: { ...c.alerts, coachAt: now } }
        }
        return c
      })
      if (coach) $.ui.toast(coach, { timeoutMs: 9000 })
      if (failed && streak >= 3 && streak % 3 === 0) {
        $.ui.toast(`${tool} has failed ${streak} times in a row. Re-check its inputs before retrying.`, { timeoutMs: 8000 })
      }
    })
    return ran
  })

  // ---------- commands ----------

  on('command.run', { command: 'deck' }, async ($, e) => {
    try {
      await boot($)
      const arg = (e.args ?? '').trim().toLowerCase()
      if (arg === 'off' || arg === 'close' || arg === 'hide') {
        await $.ui.close({ id: PANE })
        return { text: 'Agent Deck closed. /deck opens it again.' }
      }
      if (arg === 'text' || arg === 'status') {
        const now = await $.clock.now()
        return { text: textSummary(await read($, core), now) }
      }
      if (arg === 'reset') {
        const now = await $.clock.now()
        await update($, core, c => ({ ...makeCore(now), today: c.today }))
        return { text: 'Agent Deck session stats reset (today totals kept).' }
      }
      if (arg === 'reset all') {
        const now = await $.clock.now()
        await update($, core, () => makeCore(now))
        await $.store.delete('daily')
        return { text: 'Agent Deck stats and daily totals cleared.' }
      }
      const opened = await $.ui.open({ id: PANE, title: 'Agent Deck', rows: 22 })
      if (!opened.isPlaced) {
        // This surface has no room for a pane (or it is too small): show the deck as text instead of an empty promise.
        const now = await $.clock.now()
        const why = (opened as { reason?: string }).reason
        return { text: `Agent Deck cannot draw a pane on this surface${why ? ` (${why})` : ''}. Here it is as text; /tokens gives the same, and the status line shows context use.\n\n${textSummary(await read($, core), now)}` }
      }
      return { text: 'Agent Deck opened. /deck off closes it.' }
    } catch {
      return { text: 'Agent Deck could not complete that command.' }
    }
  })

  on('command.run', { command: 'tokens' }, async $ => {
    try {
      await boot($)
      const now = await $.clock.now()
      return { text: textSummary(await read($, core), now) }
    } catch {
      return { text: 'Agent Deck has no data yet.' }
    }
  })

  // ---------- band above the prompt ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)
      const c = await read($, core)
      if (c.startedAt === 0) return next(e)
      const now = await $.clock.now()
      const { Box, Text } = $.ui.resolve(e)
      const cols = e.props.bodyColumns ?? 100
      const compact = e.surface === 'mobile' || cols < 80
      const running = c.agents.filter(a => a.status === 'running').length
      const t = c.totals
      const tin = t.input + t.cacheCreate + t.cacheRead
      const hit = cacheRate(t)
      const pct = c.ctxPct
      const color = pct >= 0 ? pctColor(pct) : undefined

      const parts: JSX.Element[] = []
      if (pct >= 0) {
        parts.push(
          compact ? (
            <Text color={color}>
              ctx {Math.round(pct)}% {bar(pct, 6)}
            </Text>
          ) : (
            <Text>
              ctx {fmtTok(c.ctxTokens)}/{fmtTok(c.ctxWindow)} <Text color={color}>{bar(pct, 12)}</Text> <Text color={color}>{Math.round(pct)}%</Text>
            </Text>
          ),
        )
      } else {
        parts.push(<Text dimColor>ctx n/a</Text>)
      }
      parts.push(
        <Text>
          {fmtTok(tin)}↓ {fmtTok(t.output)}↑
          {!compact && hit !== undefined ? ` cache ${Math.round(hit)}%` : ''}
        </Text>,
      )
      if (!compact && c.hasCost) parts.push(<Text>~{fmtUsd(c.usd)}</Text>)
      if (running > 0) {
        parts.push(
          <Text color="warning">
            {spinner(now)} {running} agent{running === 1 ? '' : 's'}
          </Text>,
        )
      } else if (!compact) {
        parts.push(<Text dimColor>0 agents</Text>)
      }
      parts.push(<Text dimColor>{fmtDur(now - c.startedAt)}</Text>)
      parts.push(<Text dimColor>{c.toolCalls} tool{c.toolCalls === 1 ? '' : 's'}</Text>)

      return (
        <Box flexDirection="row" columnGap={compact ? 1 : 2}>
          {parts}
        </Box>
      )
    } catch {
      return next(e)
    }
  })

  // ---------- the Agent Deck pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    try {
      const c = await read($, core)
      const now = await $.clock.now()
      const { Box, Text } = $.ui.resolve(e)
      const cols = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
      const wide = cols >= 100
      const L = (text: string, props: { color?: string; dimColor?: boolean; bold?: boolean } = {}) => (
        <Text wrap="truncate" {...props}>
          {text}
        </Text>
      )
      const rows: JSX.Element[] = []
      const gap = () => rows.push(L(' '))

      const t = c.totals
      rows.push(L(`Today: ${fmtTok(c.today.tokens)} tokens, ${c.today.turns} turns, ${c.today.agents} agents launched   Session: ${fmtDur(now - c.startedAt)}, ${c.toolCalls} tool calls${c.hasCost ? `, ~${fmtUsd(c.usd)}` : ''}`, { bold: true }))
      if (c.ctxPct >= 0) {
        rows.push(L(`Context ${bar(c.ctxPct, 20)} ${Math.round(c.ctxPct)}% (${fmtTok(c.ctxTokens)}/${fmtTok(c.ctxWindow)})`, { color: pctColor(c.ctxPct) }))
      }
      for (const r of c.rates) rows.push(L(`${rateName(r.kind)} window ${bar(r.pct, 12)} ${Math.round(r.pct)}%`, { color: pctColor(r.pct) }))

      // live agents
      const live = c.agents.filter(a => a.status === 'running')
      gap()
      rows.push(L(`Agents running (${live.length})`, { bold: true }))
      if (live.length === 0) rows.push(L('  none', { dimColor: true }))
      else {
        const descW = Math.max(8, cols - (wide ? 62 : 44))
        rows.push(L(`  ${pad('', 2)}${pad('TYPE', 14)}${pad('TASK', descW)} ${padL('TIME', 7)} ${padL('TOOLS', 5)} ${padL('TOK', 6)}`, { dimColor: true }))
        for (const a of live) {
          rows.push(L(`  ${spinner(now)} ${pad(a.type, 14)}${pad(a.description, descW)} ${padL(fmtDur(now - a.startedAt), 7)} ${padL(String(a.tools), 5)} ${padL(a.tokens ? fmtTok(a.tokens) : '-', 6)}`, { color: 'warning' }))
          rows.push(L(`    └ ${a.lastTool ? `${a.lastTool}${a.lastDetail ? `: ${a.lastDetail}` : ''}` : 'starting...'}`, { dimColor: true }))
        }
      }

      // history
      const done = c.agents.filter(a => a.status !== 'running').slice(-8).reverse()
      gap()
      rows.push(L(`Finished this session (${c.agents.length - live.length})`, { bold: true }))
      if (done.length === 0) rows.push(L('  none yet', { dimColor: true }))
      for (const a of done) {
        const ok = a.status === 'done'
        rows.push(L(`  ${ok ? '✓' : '✗'} ${pad(a.type, 12)} ${pad(clip(a.description, 28), 28)} ${padL(fmtDur(a.endedAt - a.startedAt), 7)} ${padL(fmtTok(a.tokens), 6)} ${a.tools}t  ${a.summary}`, { color: ok ? undefined : 'error', dimColor: ok }))
      }

      // models
      gap()
      rows.push(L('Tokens by model', { bold: true }))
      const models = Object.entries(c.models)
      if (models.length === 0) rows.push(L('  no usage reported yet', { dimColor: true }))
      for (const [m, v] of models) {
        rows.push(L(`  ${pad(clip(m, 28), 28)} in ${padL(fmtTok(v.input + v.cacheCreate + v.cacheRead), 6)}  out ${padL(fmtTok(v.output), 6)}  cached ${padL(fmtTok(v.cacheRead), 6)}  ${v.turns} turns`))
      }
      void t

      // spenders
      gap()
      rows.push(L('Most expensive prompts and agents (fresh input + output tokens)', { bold: true }))
      const top = topSpenders(c, 5)
      if (top.length === 0) rows.push(L('  nothing yet', { dimColor: true }))
      for (const s of top) rows.push(L(`  ${padL(fmtTok(s.tokens), 6)}  ${s.label}`))

      // sparkline
      gap()
      const mine = c.turns.filter(x => !x.agentId).slice(-Math.max(10, Math.min(60, cols - 24)))
      rows.push(L(`Tokens per prompt  ${spark(mine.map(x => x.tokens))}  (last ${mine.length}, max ${fmtTok(Math.max(0, ...mine.map(x => x.tokens)))})`))

      gap()
      rows.push(L('/deck off closes this pane  /tokens prints a summary  /deck reset clears session stats', { dimColor: true }))

      return <Box flexDirection="column">{rows}</Box>
    } catch {
      return next(e)
    }
  })
}
