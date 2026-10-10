import { describe, expect, it } from 'vitest'
import type { AgentHookState } from '../houston/generated/AgentHookState'
import { firstRunHookInstallCount, firstRunHookRows } from './firstRunHooks'

function state(overrides: Partial<AgentHookState> = {}): AgentHookState {
  return {
    provider: 'claude',
    path: '~/.claude/settings.json',
    scope: 'global',
    enabled: false,
    installed: false,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null,
    ...overrides
  }
}

describe('firstRunHookRows', () => {
  it('shows the supported providers in board order with their live hook state', () => {
    const rows = firstRunHookRows([
      state({ provider: 'claude', installed: true, version: '2.3.1' }),
      state({ provider: 'codex', version: '0.98.0' }),
      state({ provider: 'cursor', present: false, version: null })
    ])

    expect(rows.map(({ provider, status }) => [provider, status])).toEqual([
      ['claude', 'reporting'],
      ['codex', 'silent'],
      ['opencode', 'not-found'],
      ['grok', 'not-found'],
      ['cursor', 'not-found'],
      ['antigravity', 'not-found']
    ])
    expect(rows[0]).toMatchObject({ name: 'Claude Code', version: '2.3.1' })
    expect(rows[1]).toMatchObject({ name: 'Codex', version: '0.98.0' })
  })

  it('counts only present CLIs that are not reporting', () => {
    const rows = firstRunHookRows([
      state({ provider: 'claude', installed: true }),
      state({ provider: 'codex' }),
      state({ provider: 'opencode', present: false })
    ])

    expect(firstRunHookInstallCount(rows)).toBe(1)
  })

  it('keeps provider errors on their row', () => {
    expect(firstRunHookRows([state({ error: 'Invalid settings shape' })])[0].error).toBe(
      'Invalid settings shape'
    )
  })
})
