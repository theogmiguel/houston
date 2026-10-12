// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SkillToolState } from '../../houston/generated/SkillToolState'
import { SkillsView } from '../SkillsView'

vi.mock('../../houston/bridge', () => ({
  listSkills: vi.fn(async () => [{ agent: 'claude', source: 'project', name: 'tokens', invoke: '/tokens', path: '/claude/tokens', description: 'Shared theme instructions.' }]),
  readFile: vi.fn(async (path: string) => `Instructions from ${path}`),
  addAllowedRoot: vi.fn(async () => undefined)
}))
afterEach(cleanup)
function tool(tool: SkillToolState['tool'], digest: string | null, inherits = false): SkillToolState {
  return { tool, detected: true, inherits_claude: inherits, error: null, path: `/${tool}`, skills: digest ? [{ name: 'tokens', path: `/${tool}/tokens`, digest }] : [] }
}
it('uses one actionable table with per-copy statuses and display names, without repeating the heading', async () => {
  const onPush = vi.fn()
  render(<SkillsView embedded settingsPage dir="/workspace" scopeLabel="This workspace" tools={[tool('claude', 'a'), tool('codex', 'b'), tool('antigravity', 'a'), tool('opencode', null, true), tool('cursor', 'a'), tool('grok', 'a'), tool('zcode', null)]} pushes={[]} onPush={onPush} onPushUndo={vi.fn()} />)
  fireEvent.click(await screen.findByText('/tokens'))
  expect(screen.getAllByRole('table')).toHaveLength(2)
  const table = screen.getByRole('table', { name: 'Agent copies of tokens' })
  for (const [agent, status] of [['Claude Code', 'Synced'], ['Codex', 'Differs'], ['Antigravity', 'Synced'], ['OpenCode', "Reads Claude's folder"], ['Cursor', 'Synced'], ['Grok', 'Synced'], ['ZCode', 'Missing']]) {
    const row = within(table).getByText(agent).closest('tr')!
    expect(within(row).getByText(status)).toBeTruthy()
  }
  expect(screen.queryByText(/Distribution —/)).toBeNull()
  expect(within(table).getAllByRole('row')).toHaveLength(8)
  expect(within(table).getByText('OpenCode').closest('tr')!.querySelector('button')).toBeNull()
  expect(within(table).getByText('Antigravity').closest('tr')!.querySelector('button')).toBeNull()
  expect(screen.queryByText('tokens', { selector: 'h2' })).toBeNull()
  expect(screen.getAllByText('Shared theme instructions.')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Edit tokens' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Delete tokens' })).toBeTruthy()
  fireEvent.click(within(table).getByRole('button', { name: 'View difference' }))
  expect(await screen.findByText('Instructions from /codex/tokens')).toBeTruthy()
  fireEvent.click(within(table).getByRole('button', { name: "Copy Claude's version to Codex" }))
  fireEvent.click(within(table).getByRole('button', { name: 'Add copy to ZCode' }))
  expect(onPush.mock.calls).toEqual([['codex', 'tokens'], ['zcode', 'tokens']])
})
it('joins missing agent names as a natural list', async () => {
  render(<SkillsView embedded settingsPage dir="/workspace" tools={[tool('claude', 'a'), tool('antigravity', null), tool('cursor', null), tool('grok', null)]} onPush={vi.fn()} />)
  await screen.findByText('/tokens')
  expect(screen.getByRole('note').textContent).toContain('In Antigravity, Cursor or Grok.')
})
