// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { ANNOUNCE_SETTLE_MS } from './components/PaneStatusAnnouncer'

const WS = '/tmp/project-a'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('the pane status announcer', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const region = (): HTMLElement => harness!.container.querySelector<HTMLElement>('[data-testid="pane-status-announcer"]')!

  async function focusFirstPane(sessions: Parameters<typeof makeSession>[0][]): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({ sessions: sessions.map(makeSession), workspaces: [makeWorkspace({ path: WS, name: 'a' })] })
    const focus = await vi.waitFor(() => {
      const button = harness!.container.querySelector<HTMLElement>('button[aria-label="Focus session-1"]')
      if (!button) throw new Error('rail focus button not rendered yet')
      return button
    })
    act(() => focus.click())
    expect(region().textContent).toBe('')
  }

  async function pushStatus(session: number, status: 'idle' | 'working'): Promise<void> {
    await act(async () => {
      deliverControl({ type: 'agent_status', session, status })
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_SETTLE_MS + 100))
    })
  }

  it('announces a reported status change of the focused pane', async () => {
    await focusFirstPane([{ id: 1, agent: 'claude', project_dir: WS, cwd: WS, status: 'working' }])
    await pushStatus(1, 'idle')
    expect(region().textContent).toBe('session-1 finished.')
  }, 15_000)

  it('stays silent when a pane that is not focused changes status', async () => {
    await focusFirstPane([
      { id: 1, agent: 'claude', project_dir: WS, cwd: WS, status: 'idle' },
      { id: 2, agent: 'claude', project_dir: WS, cwd: WS, status: 'working', title: 'other' }
    ])
    await pushStatus(2, 'idle')
    expect(region().textContent).toBe('')
  }, 15_000)
})
