// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Skill } from '../../env'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { SkillsSettingsLibrary } from './SkillsSettingsLibrary'

afterEach(cleanup)
const skills: Skill[] = ['review', 'debug', 'conflict', 'synced'].map(name => ({ agent: 'claude', source: 'user', name, invoke: `/${name}`, path: `/skills/${name}`, description: `Instructions for ${name}` }))
const tools: SkillToolState[] = ['claude', 'codex', 'cursor'].map(tool => ({ tool: tool as SkillToolState['tool'], detected: true, inherits_claude: false, path: `/skills/${tool}`, error: null, skills: skills.filter(s => tool === 'claude' || s.name === 'synced' || (tool === 'codex' && s.name === 'conflict')).map(s => ({ name: s.name, path: `/skills/${tool}/${s.name}`, digest: tool === 'codex' && s.name === 'conflict' ? 'different' : 'same' })) }))
function mount() {
  const onPush = vi.fn()
  render(<SkillsSettingsLibrary skills={skills} search="" onSearch={vi.fn()} tools={tools} actions={<button>New skill</button>} onOpen={vi.fn()} detail={<button>Edit instructions</button>} onClose={vi.fn()} modalOpen={false} onPush={onPush} />)
  return onPush
}
it('shows one page notice and count cells without row warnings', () => {
  mount()
  expect(screen.getAllByRole('note')).toHaveLength(1)
  expect(screen.getByText('3 skills are missing copies')).toBeTruthy()
  expect(screen.getByRole('note').textContent).toContain('Codex or Cursor')
  expect(screen.getByRole('note').textContent).toContain('excluded from Sync all and needs review')
  expect(screen.queryByText('Some copies are missing')).toBeNull()
  expect(screen.getAllByText('1/3')).toHaveLength(2)
  expect(screen.getByText('3/3')).toBeTruthy()
  expect(screen.getByText('Review')).toBeTruthy()
})
it('expands copies inline with per-agent statuses and existing actions', () => {
  mount()
  fireEvent.click(screen.getAllByText('1/3')[0])
  const table = screen.getByRole('table', { name: 'Agent copies of review' })
  expect(within(table).getByText('Claude Code')).toBeTruthy()
  expect(within(table).getByText('Synced')).toBeTruthy()
  expect(within(table).getAllByText('Missing')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Sync this skill' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Edit instructions' })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('Sync all uses the per-agent sync path for every missing skill and skips conflicts', () => {
  const onPush = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))
  expect(onPush.mock.calls).toEqual([['codex', 'review'], ['cursor', 'review'], ['codex', 'debug'], ['cursor', 'debug']])
})
it('allows keyboard expansion and collapse', () => {
  mount()
  const row = screen.getByText('/review').closest('tr')!
  expect(row.tabIndex).toBe(0)
  fireEvent.keyDown(row, { key: 'Enter' })
  expect(screen.getByRole('table', { name: 'Agent copies of review' })).toBeTruthy()
  fireEvent.keyDown(row, { key: ' ' })
  expect(screen.queryByRole('table', { name: 'Agent copies of review' })).toBeNull()
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByText('/debug').closest('tr'))
})
it('keeps the page notice and bulk sync across a filtered library', () => {
  const onPush = vi.fn()
  render(<SkillsSettingsLibrary allSkills={skills} skills={skills.slice(0, 1)} search="review" onSearch={vi.fn()} tools={tools} actions={null} onOpen={vi.fn()} detail={null} onClose={vi.fn()} modalOpen={false} onPush={onPush} />)
  expect(screen.queryByText('/debug')).toBeNull()
  expect(screen.getByText('3 skills are missing copies')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Sync all' }))
  expect(onPush.mock.calls).toEqual([['codex', 'review'], ['cursor', 'review'], ['codex', 'debug'], ['cursor', 'debug']])
})
it('hides owner labels outside All and syncs only the expanded skill', () => {
  const onPush = mount()
  expect(screen.getAllByText('You')).toHaveLength(4)
  fireEvent.click(screen.getByRole('radio', { name: 'Yours' }))
  expect(screen.queryByText('You')).toBeNull()
  fireEvent.click(screen.getByText('/review'))
  fireEvent.click(screen.getByRole('button', { name: 'Sync this skill' }))
  expect(onPush.mock.calls).toEqual([['codex', 'review'], ['cursor', 'review']])
})
