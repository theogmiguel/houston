// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsSection } from './DiagnosticsSection'
import { hostInfoFixture } from '../settingsViewTestFixtures'
import { createSessionsStore, SessionsStoreContext } from '../../sessionsStore'
import type { SessionInfo } from '../../houston/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = (overrides: Partial<SessionInfo>): SessionInfo => ({
  id: 1,
  agent: 'claude',
  state: 'running',
  title_source: 'prompt' as const,
  codename: 'heron',
  title: 'orchestrator',
  project_dir: '/home/dev/code/houston',
  cwd: '/home/dev/code/houston',
  hidden: false,
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
  resumable: false,
  ...overrides
})

describe('Diagnostics sessions table', () => {
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

  it('words session states through the status vocabulary and names the table once', () => {
    const sessions = [
      session({ id: 1, status: 'needs-input' }),
      session({ id: 2, status: 'working', codename: 'otter', title: 'inbox-api' }),
      session({ id: 3, status: 'idle', codename: 'tern', title: 'pr-watch' }),
      session({ id: 4, status: null, state: 'exited', codename: 'owl', title: 'nightly' })
    ]
    act(() => root.render(
      <SessionsStoreContext.Provider value={createSessionsStore(new Map(sessions.map((item) => [item.id, item])))}>
        <DiagnosticsSection hostInfo={hostInfoFixture()} agentHooks={null} onOpenHooks={vi.fn()} onOpenLogsFolder={vi.fn()} />
      </SessionsStoreContext.Provider>
    ))
    const table = container.querySelector('[data-testid="daemon-live-sessions"]')!
    const text = table.textContent ?? ''
    expect(text).toContain('Needs input')
    expect(text).toContain('Working')
    expect(text).toContain('Idle')
    expect(text).toContain('Done')
    expect(text).not.toContain('needs-input')
    const headings = [...container.querySelectorAll('[data-testid="settings-subhead"]')].map((node) => node.textContent)
    expect(headings.filter((heading) => heading === 'Sessions')).toHaveLength(1)
    expect(headings).toContain('Live sessions 4')
  })
})
