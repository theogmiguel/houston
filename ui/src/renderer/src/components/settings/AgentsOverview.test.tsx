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
  fireEvent.click(screen.getByRole('button', { name: 'Open Skills' }))
  expect(settingsSectionLabel()).toBe('Agents / Skills')
})
it('presents unchecked sources without claiming setup is healthy', () => {
  render(<AgentsOverview attention={agentAttentionFor({ agentHooks: null, skills: null, checks: null, reviews: [] })} onRepair={vi.fn()} onCheck={vi.fn()} />)
  expect(screen.getByText('Checking agent setup…')).toBeTruthy()
  expect(screen.getAllByText('Not checked yet')).toHaveLength(3)
})
