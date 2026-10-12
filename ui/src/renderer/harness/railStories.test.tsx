// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RAIL_STORIES } from './railStories'
import { rememberRailGitFacts } from '../src/components/git/railGitCache'

it('keeps the sidebar story git facts visible after a late subscription clears the cache', async () => {
  localStorage.clear()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const Story = RAIL_STORIES['rail/card-modes']
  act(() => root.render(<Story />))
  const card = (id: string): string => host.querySelector(`[data-grid-id="${id}"]`)?.textContent ?? ''
  try {
    await vi.waitFor(() => expect(card('inspector-polish')).toContain('+91'))
    act(() => rememberRailGitFacts(new Map()))
    await vi.waitFor(() => expect(card('inspector-polish')).toContain('+91'))
    expect(card('inspector-polish')).toContain('↑2')
    expect(card('inspector-polish')).toContain('-12')
    expect(card('inspector-polish')).toContain('inspector-polish')
    expect(card('mensageria')).toContain('↑3')
    expect(card('mensageria')).toContain('+932')
    expect(card('mensageria')).toContain('-120')
    expect(card('mensageria')).toContain('feature/tiers')
    expect(card('pr-screen')).toContain('+1204')
    expect(card('pr-screen')).toContain('-88')
    expect(card('pr-screen')).toContain('houston/pr-list')
    expect(host.textContent).not.toContain('Toggle compact')
  } finally {
    act(() => root.unmount())
    host.remove()
    localStorage.clear()
  }
})
