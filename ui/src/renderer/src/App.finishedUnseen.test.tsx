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

const WS_A = '/tmp/project-a'
const WS_B = '/tmp/project-b'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('the finished-unread rail marker', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const pip = (): HTMLElement | null =>
    harness!.container.querySelector<HTMLElement>('[data-testid="grid-unread-pip"]')

  async function waitRailRow(): Promise<void> {
    await vi.waitFor(() => {
      const state = harness!.container.querySelector<HTMLElement>(
        '[data-testid="grid-row"] [data-testid="grid-state-dot"]'
      )?.dataset.state
      if (state === undefined || state === 'loading') throw new Error(`grid row still loading: ${state}`)
    })
  }

  it('marks a top-level pane that finished while another workspace was on screen', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, agent: 'claude', project_dir: WS_B, cwd: WS_B, status: 'working' })],
      workspaces: [makeWorkspace({ path: WS_A, name: 'a' }), makeWorkspace({ path: WS_B, name: 'b' })]
    })
    await waitRailRow()
    expect(pip()).toBeNull()

    deliverControl({ type: 'agent_status', session: 1, status: 'idle' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pip()).not.toBeNull()
  })

  it('does not mark a pane that was on screen when it finished', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, agent: 'claude', project_dir: WS_A, cwd: WS_A, status: 'working' })],
      workspaces: [makeWorkspace({ path: WS_A, name: 'a' })]
    })
    await waitRailRow()

    deliverControl({ type: 'agent_status', session: 1, status: 'idle' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pip()).toBeNull()
  })

  it('clears the mark when the finished pane is focused', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, agent: 'claude', project_dir: WS_B, cwd: WS_B, status: 'working' })],
      workspaces: [makeWorkspace({ path: WS_A, name: 'a' }), makeWorkspace({ path: WS_B, name: 'b' })]
    })
    await waitRailRow()
    deliverControl({ type: 'agent_status', session: 1, status: 'idle' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pip()).not.toBeNull()

    const focus = harness.container.querySelector<HTMLElement>('button[aria-label="Focus session-1"]')
    expect(focus).not.toBeNull()
    act(() => {
      focus!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(pip()).toBeNull()
  })
})
