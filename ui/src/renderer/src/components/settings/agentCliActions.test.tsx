// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentStatusSection } from './AgentStatusSection'
import { AgentProfiles } from '../AgentProfiles'

afterEach(cleanup)
it('repairs a CLI inline without selecting a list-detail page', () => {
  const onSet = vi.fn()
  const { container } = render(<AgentStatusSection providers={[{ provider: 'opencode', path: '/hooks', scope: 'global', present: true, enabled: true, installed: false, error: 'managed block edited', version: '1', trust: null }]} onSet={onSet} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Repair hooks' }))
  expect(onSet).toHaveBeenCalledWith('opencode', true)
  expect(container.querySelector('[data-testid="list-detail-item"]')).toBeNull()
  expect(screen.queryByText('Agent CLIs')).toBeNull()
})
it('renames an account with its existing id and directory and switches another account explicitly', () => {
  const onUpsert = vi.fn(), onSetActive = vi.fn()
  render(<AgentProfiles agents={['claude']} profiles={[{ id: 7, agent: 'claude', name: 'work', config_dir: '/claude/work' }]} active={[]} onUpsert={onUpsert} onDelete={vi.fn()} onSetActive={onSetActive} />)
  fireEvent.click(screen.getByRole('button', { name: 'Use for new panes' }))
  expect(onSetActive).toHaveBeenCalledWith('claude', 7)
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'project' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onUpsert).toHaveBeenCalledWith(7, 'claude', 'project', '/claude/work')
})
