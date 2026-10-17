export type Totals = { input: number; output: number; cacheRead: number; cacheCreate: number }

export type AgentRow = {
  id: string
  type: string
  description: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number
  tools: number
  lastTool: string
  lastDetail: string
  tokens: number
  summary: string
  longAlerted: boolean
}

export type TurnRec = {
  n: number
  prompt: string
  agentId: string
  model: string
  tokens: number
  output: number
  usd: number
}

export type ToolStat = { n: number; fails: number; chars: number; bigs: number }

export type BigOutput = { tool: string; chars: number; detail: string }

export type RateInfo = { kind: string; pct: number }

export type Today = { date: string; tokens: number; input: number; output: number; agents: number; turns: number }

export type Core = {
  startedAt: number
  toolCalls: number
  toolStats: Record<string, ToolStat>
  totals: Totals
  models: Record<string, Totals & { turns: number }>
  agents: AgentRow[]
  turns: TurnRec[]
  bigs: BigOutput[]
  ctxTokens: number
  ctxWindow: number
  ctxPct: number
  rates: RateInfo[]
  usd: number
  hasCost: boolean
  lastPrompt: string
  turnCost0: number
  turnCount: number
  failStreak: Record<string, number>
  alerts: { ctx: number; rates: Record<string, number>; coachAt: number; failAt: number }
  today: Today
  isWorking: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-deck': { core: Core }
  }
}
