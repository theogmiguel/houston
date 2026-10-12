// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { agentAttentionFor } from '../../useAgentAttention'
import { AgentsOverview } from './AgentsOverview'
import { settingsSectionLabel, setSettingsNavForTests } from '../../settingsNav'

afterEach(cleanup)
it('routes fixes to their owner and calls existing MCP and hook actions inline', () => {
  const onRepair = vi.fn(), onCheck = vi.fn()
  const attention = agentAttentionFor({ agentHooks: [{ provider: 'opencode', path: '/hooks', scope: 'global', present: true, enabled: true, installed: false, error: 'edited hooks', trust: null, version: '1' }], skills: null, checks: [['github', { state: 'failed', message: 'npx not on PATH' }]], reviews: [] })
  render(<AgentsOverview attention={attention} onRepair={onRepair} onCheck={onCheck} />)
  fireEvent.click(screen.getByRole('button', { name: 'Repair hooks' }))
  expect(onRepair).toHaveBeenCalledWith('opencode', true)
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
  expect(onCheck).toHaveBeenCalledWith('github')
  setSettingsNavForTests({ section: 'appearance' })
  fireEvent.click(screen.getByRole('button', { name: /^Skills/ }))
  expect(settingsSectionLabel()).toBe('Agents / Skills')
})
it('presents unchecked sources without claiming setup is healthy', () => {
  render(<AgentsOverview attention={agentAttentionFor({ agentHooks: null, skills: null, checks: null, reviews: [] })} onRepair={vi.fn()} onCheck={vi.fn()} />)
  expect(screen.getByText('Checking agent setup…')).toBeTruthy()
  expect(screen.getAllByRole('button').filter((row) => row.textContent?.includes('Not checked yet'))).toHaveLength(3)
})

it('shows each open review finding with severity and session evidence, and makes status rows clickable', () => {
  const attention = agentAttentionFor({ agentHooks: [], skills: [], checks: [['github', { state: 'failed', message: 'npx is not on PATH' }]], reviews: [{ workspace: '/ws', attention: 1, open: 1, fixing: 0, awaiting_verification: 0, not_seen: 0, resolved: 0, dismissed: 0, seen_review_id: 0 }] })
  const state: import('../../houston/useHarness').HarnessState = { workspace: '/ws', routine: null, reviews: [{ id: 1, workspace: '/ws', routine_id: 1, run_id: 1, status: 'published', started_at_ms: 1, run_dir: '/ws/.houston/harness/r1', sessions: 38, finding_count: 1 }], findings: [{ review_id: 1, key: 'style', title: 'Agents re-read the styleguide on every UI change', category: 'workflow', confidence: 'high', sessions: ['a'], count: 9, quotes: [], recommendation_kind: 'workflow', target: 'AGENTS.md', recommendation: 'Read once', apply_prompt: 'Read once', state: 'open', recurred: false, phase: 'open', last_seen_review_id: 1 }], models: [], providerCoverage: [], engineRefusals: [] }
  const { container } = render(<AgentsOverview attention={attention} reviewStates={[state]} onRepair={vi.fn()} onCheck={vi.fn()} />)
  expect(screen.getByText('Agents re-read the styleguide on every UI change')).toBeTruthy()
  expect(screen.getByText('9 of 38 sessions · Review')).toBeTruthy()
  expect(screen.getByText('npx is not on PATH · MCP servers')).toBeTruthy()
  expect(container.querySelectorAll('[data-tone="danger"]').length).toBeGreaterThan(0)
  setSettingsNavForTests({ section: 'appearance' })
  fireEvent.click(screen.getByRole('button', { name: /MCP servers.*1 server.*1 failing/ }))
  expect(settingsSectionLabel()).toBe('Agents / MCP servers')
  expect(screen.queryByText('1 review finding needs you')).toBeNull()
})

it('lists the failing MCP server before warning-level issues', () => {
  const attention = agentAttentionFor({ agentHooks: [{ provider: 'opencode', path: '/hooks', scope: 'global', present: true, enabled: true, installed: false, error: 'edited hooks', trust: null, version: '1' }], skills: null, checks: [['github', { state: 'failed', message: 'npx not on PATH' }]], reviews: [] })
  render(<AgentsOverview attention={attention} onRepair={vi.fn()} onCheck={vi.fn()} />)
  const buttons = screen.getAllByRole('button').map((button) => button.textContent)
  expect(buttons.indexOf('Check again')).toBeGreaterThanOrEqual(0)
  expect(buttons.indexOf('Check again')).toBeLessThan(buttons.indexOf('Repair hooks'))
})
