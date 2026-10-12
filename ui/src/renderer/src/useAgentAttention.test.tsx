// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { agentAttentionFor, useAgentAttention, type AgentAttentionInput } from './useAgentAttention'
import type { AgentHookState } from './houston/generated/AgentHookState'

const empty: AgentAttentionInput = { agentHooks: null, skills: null, checks: null, reviews: [] }
const hook: AgentHookState = { provider: 'opencode', path: '/hooks', scope: 'global', enabled: true, installed: false, error: null, present: true, version: '1', trust: null }
describe('agent setup attention', () => {
  it('keeps unknown sources distinct from checked healthy sources', () => {
    expect(agentAttentionFor(empty)).toMatchObject({ total: 0, known: { clis: false, skills: false, mcp: false } })
    expect(agentAttentionFor({ ...empty, agentHooks: [], skills: [], checks: [] }).known).toEqual({ clis: true, skills: true, mcp: true })
  })
  it('counts reported problems, deduplicates provider scopes and ignores absent or deliberately disabled hooks', () => {
    const result = agentAttentionFor({ ...empty, agentHooks: [hook, { ...hook, path: '/profile' }, { ...hook, provider: 'cursor', present: false }, { ...hook, provider: 'codex', enabled: false }], checks: [['github', { state: 'failed', message: 'npx is not on PATH' }], ['github', { state: 'failed', message: 'again' }], ['ok', { state: 'verified', tool_count: 2 }]], skills: [
      { tool: 'claude', path: '/claude', detected: true, inherits_claude: false, error: null, skills: [{ name: 'tdd', path: '/a', digest: 'a' }] },
      { tool: 'codex', path: '/codex', detected: true, inherits_claude: false, error: null, skills: [{ name: 'tdd', path: '/b', digest: 'b' }] }
    ], reviews: [{ workspace: '/ws', attention: 2, open: 2, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 0 }] })
    expect(result.counts).toEqual({ 'agents-clis': 1, 'agents-skills': 1, 'agents-mcp': 1, 'agents-review': 2 })
    expect(result.total).toBe(5)
    expect(result.issues.find((issue) => issue.server === 'github')?.title).toBe("Houston can't start github")
  })
  it('updates the same model when daemon snapshots change', () => {
    const { result, rerender } = renderHook((input: AgentAttentionInput) => useAgentAttention(input), { initialProps: empty })
    expect(result.current.total).toBe(0)
    rerender({ ...empty, agentHooks: [hook] })
    expect(result.current.total).toBe(1)
    rerender({ ...empty, agentHooks: [{ ...hook, installed: true }] })
    expect(result.current.total).toBe(0)
  })
})
