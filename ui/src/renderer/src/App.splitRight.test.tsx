// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function pressD(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })
    )
  })
}

function createSessionMock(): Mock {
  return currentClient().createSession as unknown as Mock
}

describe('split-right keyboard shortcut', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('splits the target pane, anchoring the new session on its cwd', async () => {
    harness = await renderReadyApp()
    const createSession = createSessionMock()
    createSession.mockClear()

    pressD()

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'shell', cwd_from: 1, project_dir: '/tmp/project' })
    )
  })

  it('anchors on the first LIVE pane, not the first pane in layout order', async () => {
    harness = await renderReadyApp()

    deliverHelloOk({
      sessions: [
        makeSession({ id: 1, state: 'exited' }),
        makeSession({ id: 2, state: 'running', title: 'session-2' })
      ],
      workspaces: [makeWorkspace()]
    })

    const createSession = createSessionMock()
    createSession.mockClear()
    pressD()

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd_from: 2 }))
  })

  it('un-expands the pane it splits, so the new pane is not created off-screen', async () => {
    harness = await renderReadyApp()
    const createSession = createSessionMock()

    const expandBtn = (): HTMLButtonElement => {
      const b = Array.from(harness!.container.querySelectorAll('button')).find((b) => {
        const label = b.getAttribute('aria-label')
        return label === 'Expand' || label === 'Collapse'
      })
      if (!b) throw new Error('no expand/collapse button rendered')
      return b
    }

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
    })
    expect(expandBtn().getAttribute('aria-pressed')).toBe('true')

    createSession.mockClear()
    pressD()

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(expandBtn().getAttribute('aria-pressed')).toBe('false')
  })

  it('stays inert on step 1’s screen, which can sit over a live workspace', async () => {
    harness = await renderReadyApp()
    const createSession = createSessionMock()

    act(() => {
      deliverControl({ type: 'workspace_list', workspaces: [] })
    })
    expect(harness.container.querySelector('[data-testid="workspaces-empty"]')).not.toBeNull()

    createSession.mockClear()
    pressD()

    expect(createSession).not.toHaveBeenCalled()
  })

  it('stays inert while a pane is selected, so the key belongs to the agent', async () => {
    harness = await renderReadyApp()
    const createSession = createSessionMock()

    const pane = harness.container.querySelector('.pane')
    if (!(pane instanceof HTMLElement)) throw new Error('no .pane rendered')
    act(() => {
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    createSession.mockClear()
    pressD()

    expect(createSession).not.toHaveBeenCalled()
  })
})
