import type { AgentHookState } from '../houston/generated/AgentHookState'
import type { AgentKind } from '../houston/generated/AgentKind'

export const FIRST_RUN_HOOK_PROVIDERS = [
  { provider: 'claude', name: 'Claude Code' },
  { provider: 'codex', name: 'Codex' },
  { provider: 'opencode', name: 'OpenCode' },
  { provider: 'grok', name: 'Grok' },
  { provider: 'cursor', name: 'Cursor' },
  { provider: 'antigravity', name: 'Antigravity' },
  { provider: 'zcode', name: 'ZCode' }
] as const satisfies ReadonlyArray<{ provider: AgentKind; name: string }>

export type FirstRunHookStatus = 'reporting' | 'silent' | 'not-found'

export interface FirstRunHookRow {
  provider: AgentKind
  name: string
  version: string | null
  status: FirstRunHookStatus
  error: string | null
}

export function firstRunHookRows(states: AgentHookState[]): FirstRunHookRow[] {
  return FIRST_RUN_HOOK_PROVIDERS.map(({ provider, name }) => {
    const state = states.find((candidate) => candidate.provider === provider)
    return {
      provider,
      name,
      version: state?.version ?? null,
      status: !state?.present ? 'not-found' : state.installed ? 'reporting' : 'silent',
      error: state?.error ?? null
    }
  })
}

export function firstRunHookInstallCount(rows: FirstRunHookRow[]): number {
  return rows.filter((row) => row.status === 'silent').length
}
