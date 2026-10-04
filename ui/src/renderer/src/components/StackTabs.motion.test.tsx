// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '../houston/client'
import { leaf, stackPane } from '../layout/tree'
import { createSessionsStore, SessionsStoreContext } from '../sessionsStore'
import { StackTabs } from './StackTabs'

function makeSession(id: number, status: SessionInfo['status']): SessionInfo {
  return {
    id,
    agent: 'shell',
    cwd: '/tmp',
    title: `session-${id}`,
    state: 'running',
    status,
    createdAt: Date.now()
  } as unknown as SessionInfo
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('StackTabs needs-input badge (motion-k11)', () => {
  it('never carries the infinite pulse animation class', () => {
    const tree = stackPane([leaf(1), leaf(2)])
    const sessions = new Map([
      [1, makeSession(1, 'idle')],
      [2, makeSession(2, 'needs-input')]
    ])
    act(() => {
      root.render(
        <StackTabs
          stack={tree}
          displayedIndex={0}
          sessions={sessions}
          onSelect={() => {}}
          onUnstack={() => {}}
        />
      )
    })
    const badge = container.querySelector('[data-testid="stack-tab-badge"]')
    expect(badge).not.toBeNull()
    expect(badge?.className).not.toMatch(/animate-\[dot-pulse/)
    expect(badge?.className).toMatch(/bg-\[var\(--warn\)\]/)
    expect(badge?.className).not.toMatch(/--warning/)
  })
})

it('updates the dot and background attention badge from the store with a stale map prop', () => {
  const sessions = new Map([[1, makeSession(1, 'idle')], [2, makeSession(2, 'working')]])
  const store = createSessionsStore(sessions)
  act(() => root.render(<SessionsStoreContext.Provider value={store}><StackTabs stack={stackPane([leaf(1), leaf(2)])} displayedIndex={0} sessions={sessions} onSelect={() => {}} onUnstack={() => {}} /></SessionsStoreContext.Provider>))
  expect(container.querySelector('[data-testid="stack-tab-badge"]')).toBeNull()
  act(() => store.set((previous) => new Map(previous).set(2, { ...sessions.get(2)!, status: 'needs-input' })))
  expect(container.querySelector('[data-testid="stack-tab-badge"]')).not.toBeNull()
  const background = container.querySelector('[data-testid="stack-tab"][data-active="false"]')!
  expect(background.querySelector('.agent-dot')?.className).toContain('--warn')
})
