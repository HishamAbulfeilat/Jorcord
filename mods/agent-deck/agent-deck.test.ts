import { describe, expect, mock, test } from 'claude-code/testing'

import {
  addTurnRec,
  addUsage,
  applyMeasure,
  bar,
  coachTip,
  ctxAlertLevel,
  fmtDur,
  fmtTok,
  isSpike,
  makeCore,
  onAgentTurnEnd,
  onSpawn,
  onToolResult,
  onToolStart,
  spark,
  textSummary,
  topSpenders,
} from './hooks/lib'

describe('formatting', () => {
  test('tokens, durations and bars', () => {
    expect(fmtTok(999)).toBe('999')
    expect(fmtTok(12_400)).toBe('12k')
    expect(fmtTok(1_500_000)).toBe('1.5M')
    expect(fmtDur(75_000)).toBe('1m15s')
    expect(bar(50, 10)).toBe('█████░░░░░')
    expect(spark([0, 5, 10]).length).toBe(3)
  })
})

describe('reducers', () => {
  test('agents, tools and usage accumulate without mutating', () => {
    const c0 = makeCore(1000)
    const c1 = onSpawn(c0, { id: 'a1', type: 'Explore', description: 'find it' }, 2000)
    expect(c0.agents.length).toBe(0)
    expect(c1.agents[0]?.status).toBe('running')
    expect(c1.today.agents).toBe(1)
    const c2 = onToolStart(c1, 'Grep', 'foo', 'a1')
    expect(c2.agents[0]?.tools).toBe(1)
    expect(c2.agents[0]?.lastTool).toBe('Grep')
    const c3 = addUsage(c2, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10, model: 'm' })
    expect(c3.totals.cacheRead).toBe(900)
    expect(c3.today.tokens).toBe(160)
    const c4 = onAgentTurnEnd(c3, 'a1', { input_tokens: 100, output_tokens: 50 }, 'answer', 'found it\nmore', 9000)
    expect(c4.agents[0]?.status).toBe('done')
    expect(c4.agents[0]?.summary).toBe('found it more')
    const c5 = onAgentTurnEnd(c3, 'a1', undefined, 'error', '', 9000)
    expect(c5.agents[0]?.status).toBe('failed')
    expect(topSpenders(c4, 5)[0]?.tokens).toBe(150)
  })

  test('failure streaks reset on success and big outputs are tallied', () => {
    let c = makeCore(0)
    c = onToolResult(c, 'Bash', 10, true, 'x')
    c = onToolResult(c, 'Bash', 10, true, 'x')
    expect(c.failStreak['Bash']).toBe(2)
    c = onToolResult(c, 'Bash', 25_000, false, 'cat big')
    expect(c.failStreak['Bash']).toBe(0)
    expect(c.toolStats['Bash']?.bigs).toBe(1)
    expect(c.bigs.length).toBe(1)
    expect(coachTip('Read', 30_000)).toContain('offset/limit')
  })

  test('missing usage fields never produce NaN', () => {
    const c = addUsage(makeCore(0), {})
    expect(c.today.tokens).toBe(0)
    expect(Number.isNaN(c.totals.input)).toBe(false)
    const m = applyMeasure(c, {})
    expect(m.ctxPct).toBe(-1)
  })
})

describe('alerts', () => {
  test('context thresholds fire once per level and re-arm after compaction', () => {
    expect(ctxAlertLevel(50, 0)).toEqual({ level: 0, fire: 0 })
    expect(ctxAlertLevel(76, 0)).toEqual({ level: 75, fire: 75 })
    expect(ctxAlertLevel(78, 75)).toEqual({ level: 75, fire: 0 })
    expect(ctxAlertLevel(91, 75)).toEqual({ level: 90, fire: 90 })
    expect(ctxAlertLevel(30, 90)).toEqual({ level: 0, fire: 0 })
  })

  test('spikes compare with earlier main-loop turns', () => {
    let c = makeCore(0)
    for (let i = 0; i < 4; i++) c = addTurnRec(c, { prompt: 'p', agentId: '', model: 'm', tokens: 10_000, output: 1, usd: 0 })
    expect(isSpike(c.turns, 20_000)).toBe(false)
    expect(isSpike(c.turns, 90_000)).toBe(true)
  })

  test('the text summary reports waste hints', () => {
    let c = onToolResult(makeCore(0), 'Read', 30_000, false, 'big.log')
    c = addUsage(c, { input_tokens: 10, output_tokens: 5, model: 'm' })
    const text = textSummary(c, 60_000)
    expect(text).toContain('Waste hints')
    expect(text).toContain('Read')
  })
})

test('band renders totals after a measurement', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on, {})
  on('session.measure', () => ({ changed: [] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.measure({
      context: { tokens: 80_000, window: 100_000, percent: 80 },
      rateLimits: [],
      changed: ['context'],
    })
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
    })
    const found = await ui.find({ type: 'Text', text: /ctx/ })
    expect(found).toBeDefined()
    await ui.unmount()
  }
})

test('the pane draws on every surface and lists a spawned agent', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on, {})
  on('session.measure', () => ({ changed: [] }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'ag1' }))
  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'look around',
    description: 'scout the repo',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'm',
    background: false,
    fork: false,
  } as Parameters<typeof $.agent.spawn>[0])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-deck',
      surface,
      component: 'Pane',
      requestId: 'deck',
      props: { title: 'Agent Deck', isFocused: false, placement: 'inline', bodyColumns: 60, scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /scout the repo/ })).toBeDefined()
    await ui.unmount()
  }
})
