// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const WS = '/tmp/project'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('a session the user asked to close is not placed, mounted or attached', () => {
  let harness: AppHarness | null = null
  let attachSession: ReturnType<typeof vi.fn>
  let sessionVisibility: ReturnType<typeof vi.fn>

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const pane = (id: number): Element | null => harness!.container.querySelector(`.pane[data-panekey="${id}"]`)
  const flush = (): Promise<void> => act(async () => { await Promise.resolve() })
  const shown = (): number[] => [...harness!.container.querySelectorAll('.pane[data-panekey]')].map((el) => Number(el.getAttribute('data-panekey')))

  async function boot(ids: number[]): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: ids.map((id) => makeSession({ id, project_dir: WS, cwd: WS })),
      workspaces: [makeWorkspace({ path: WS })]
    })
    await flush()
    const client = currentClient()
    attachSession = vi.fn()
    sessionVisibility = vi.fn()
    client.attachSession = attachSession as unknown as typeof client.attachSession
    client.sessionVisibility = sessionVisibility as unknown as typeof client.sessionVisibility
  }

  const click = (el: Element): Promise<void> => act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })

  const shownTo = (ids: number[]): number[][] => [
    ...attachSession.mock.calls.filter(([id]) => ids.includes(id as number)).map(([id]) => [id as number]),
    ...sessionVisibility.mock.calls.filter(([id, visible]) => ids.includes(id as number) && visible === true).map(([id]) => [id as number])
  ]

  async function closeGridHoldingSessions(): Promise<void> {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true, bubbles: true }))
      await Promise.resolve()
    })
    await click(harness!.container.querySelector('[data-testid="add-pane-new-tab"]')!)
    const rows = [...harness!.container.querySelectorAll('[data-testid="grid-row"]')]
    await act(async () => {
      rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }))
      await Promise.resolve()
    })
    await click([...document.querySelectorAll('.ctxmenu .ctx-item')].find((b) => b.textContent?.includes('Close grid'))!)
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Close grid')!)
  }

  it('removing a grid never mounts, attaches or shows its live sessions in the next grid before they are removed', async () => {
    await boot([1, 2])
    expect(shown().sort()).toEqual([1, 2])
    await closeGridHoldingSessions()
    expect(currentClient().paneOps.closingIds()).toEqual(new Set([1, 2]))
    expect(shown()).toEqual([])
    expect(shownTo([1, 2])).toEqual([])
    deliverControl({ type: 'session_removed', session: 1 })
    deliverControl({ type: 'session_removed', session: 2 })
    await flush()
    expect(shown()).toEqual([])
    expect(shownTo([1, 2])).toEqual([])
    expect(currentClient().paneOps.closingIds().size).toBe(0)
  })

  it('closing a pane unmounts it at once and never attaches it again', async () => {
    await boot([1, 2])
    await click(pane(1)!.querySelector('header button[aria-label="Close"]')!)
    expect(currentClient().closeSession).toHaveBeenCalledWith(1)
    expect(pane(1)).toBeNull()
    expect(pane(2)).not.toBeNull()
    expect(shownTo([1])).toEqual([])
    deliverControl({ type: 'session_removed', session: 1 })
    await flush()
    expect(pane(1)).toBeNull()
    expect(shownTo([1])).toEqual([])
  })

  it('closing a workspace never re-places its sessions while the daemon is still removing them', async () => {
    await boot([1, 2])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true }))
      await Promise.resolve()
    })
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Close workspace')!)
    expect(currentClient().paneOps.closingIds()).toEqual(new Set([1, 2]))
    expect(shown()).toEqual([])
    expect(shownTo([1, 2])).toEqual([])
  })

  it('a refused close puts the pane back with the refusal inside it, not as a global notice', async () => {
    await boot([1, 2])
    await click(pane(1)!.querySelector('header button[aria-label="Close"]')!)
    expect(pane(1)).toBeNull()
    const refusal = 'close refused: session 1 is closing'
    deliverControl({ type: 'error', message: refusal, context: 'session:1' })
    await flush()
    expect(shown().sort()).toEqual([1, 2])
    expect(pane(1)!.textContent).toContain(refusal)
    expect(harness!.container.querySelector('[data-notice]')).toBeNull()
  })

  it('a refusal that only names the session in its text is attributed too', async () => {
    await boot([1])
    await click(pane(1)!.querySelector('header button[aria-label="Close"]')!)
    deliverControl({ type: 'error', message: 'unknown session id 1 (expected an active or restored session)', context: null })
    await flush()
    expect(pane(1)!.textContent).toContain('unknown session id 1')
    expect(harness!.container.querySelector('[data-notice]')).toBeNull()
  })

  it('an error about a session with no close in flight is still a global notice', async () => {
    await boot([1])
    deliverControl({ type: 'error', message: 'session 1: something else failed', context: 'session:1' })
    await flush()
    expect(harness!.container.querySelector('[data-notice]')?.textContent).toContain('something else failed')
  })

  it('a refused Try again is shown in the recovery footer and not as a global notice', async () => {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [makeSession({ id: 1, agent: 'claude', state: 'interrupted', restore_deferred: 'invalid-cwd', project_dir: WS, cwd: WS })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await flush()
    const footer = (): Element | null => harness!.container.querySelector('[data-testid="recovery-footer"]')
    const tryAgain = [...footer()!.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!
    await click(tryAgain)
    expect(vi.mocked(currentClient().respawnSession).mock.calls.map(([id]) => id)).toEqual([1])
    expect([...footer()!.querySelectorAll('button')].every((b) => b.disabled)).toBe(true)
    deliverControl({ type: 'error', message: 'respawn refused: the folder is gone', context: 'session:1' })
    await flush()
    expect(footer()!.textContent).toContain('respawn refused: the folder is gone')
    expect([...footer()!.querySelectorAll('button')].some((b) => b.disabled)).toBe(false)
    expect(harness!.container.querySelector('[data-notice]')).toBeNull()
  })
})
