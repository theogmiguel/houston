// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMsg } from './houston/generated/ServerMsg'
import type { SessionInfo } from './houston/client'
import {
  type AppHarness,
  currentClient,
  deliverClientMsg,
  deliverControl,
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

describe('hiding a sleeping pane from its grid', () => {
  let harness: AppHarness | null = null
  let send: ReturnType<typeof vi.fn>

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const flush = (): Promise<void> => act(async () => { await Promise.resolve() })
  const shown = (): number[] => [...harness!.container.querySelectorAll('.pane[data-panekey]')].map((el) => Number(el.getAttribute('data-panekey')))
  const railRows = (): HTMLElement[] => [...harness!.container.querySelectorAll<HTMLElement>('[data-testid="rail-hidden-pane"]')]
  const click = (el: Element): Promise<void> => act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  const button = (label: string): HTMLButtonElement => {
    const hit = [...harness!.container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)
    if (!hit) throw new Error(`no button labelled ${label}`)
    return hit
  }
  async function paneMenuRow(id: number, label: string): Promise<HTMLButtonElement> {
    const pane = harness!.container.querySelector(`.pane[data-panekey="${id}"]`)
    if (!pane) throw new Error(`pane ${id} is not in the grid`)
    await act(async () => {
      pane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      await Promise.resolve()
    })
    const hit = [...document.querySelectorAll<HTMLButtonElement>('.ctx-item')].find((b) => b.textContent?.includes(label))
    if (!hit) throw new Error(`no pane menu row labelled ${label}`)
    return hit
  }

  const shell = makeSession({ id: 1, project_dir: WS, cwd: WS, title: 'shell' })
  const sleeper = makeSession({ id: 7, agent: 'claude', project_dir: WS, cwd: WS, title: 'parser-work', state: 'sleeping', session_origin: 7, slept_at_ms: Date.now() - 60_000 })
  const liveAgent = makeSession({ id: 7, agent: 'claude', project_dir: WS, cwd: WS, title: 'parser-work', state: 'running', status: 'idle', session_origin: 7 })

  async function boot(sessions: SessionInfo[]): Promise<void> {
    harness = await renderReadyApp({ sessions, workspaces: [makeWorkspace({ path: WS })] })
    await flush()
    send = vi.fn()
    const client = currentClient() as unknown as { send: typeof send }
    client.send = send
  }

  async function hideFromPlaceholder(): Promise<void> {
    await boot([shell, sleeper])
    expect(shown().sort()).toEqual([1, 7])
    await click(button('Hide pane'))
  }

  it('Hide pane removes the sleeping pane from the grid, keeps it asleep and lists it in the rail', async () => {
    await hideFromPlaceholder()

    expect(shown()).toEqual([1])
    expect(railRows().map((row) => row.textContent)).toEqual(['parser-workSleeping · hidden'])
    expect(send).not.toHaveBeenCalled()
  })

  it('the pane menu of a sleeping pane offers Hide pane', async () => {
    await boot([shell, sleeper])
    await click(await paneMenuRow(7, 'Hide pane'))

    expect(shown()).toEqual([1])
    expect(railRows()).toHaveLength(1)
  })

  it('selecting the hidden pane in the rail brings back its placeholder without waking it', async () => {
    await hideFromPlaceholder()
    await click(railRows()[0])

    expect(shown().sort()).toEqual([1, 7])
    expect(harness!.container.textContent).toContain('Session sleeping')
    expect(railRows()).toHaveLength(0)
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_wake' }))
  })

  it('Sleep and hide hides the pane only once it is sleeping', async () => {
    await boot([shell, liveAgent])
    await click(await paneMenuRow(7, 'Sleep and hide'))

    expect(send).toHaveBeenCalledWith({ type: 'session_sleep', session: 7 })
    expect(shown().sort()).toEqual([1, 7])

    deliverControl({ type: 'session_state', session: 7, state: 'sleeping', exit_code: null })
    deliverControl({ type: 'session_updated', info: { ...liveAgent, state: 'sleeping', status: null, slept_at_ms: Date.now() } })
    await flush()

    expect(shown()).toEqual([1])
    expect(railRows()).toHaveLength(1)
  })

  it('a refused Sleep and hide leaves the pane visible with its error, and a later Sleep does not hide it', async () => {
    await boot([shell, liveAgent])
    await click(await paneMenuRow(7, 'Sleep and hide'))
    const refusal: Extract<ServerMsg, { type: 'error' }> = { type: 'error', message: 'Sleep refused for session 7: agent status is not idle', context: null }
    deliverControl(refusal)
    deliverClientMsg('error', refusal)
    await flush()

    expect(shown().sort()).toEqual([1, 7])
    expect(harness!.container.textContent).toContain('Sleep refused for session 7')

    deliverControl({ type: 'session_state', session: 7, state: 'sleeping', exit_code: null })
    await flush()
    expect(shown().sort()).toEqual([1, 7])
    expect(railRows()).toHaveLength(0)
  })

  it('waking the hidden conversation from elsewhere brings it back into its grid', async () => {
    await hideFromPlaceholder()
    const woken = makeSession({ id: 9, agent: 'claude', project_dir: WS, cwd: WS, title: 'parser-work', state: 'running', session_origin: 7 })
    deliverControl({ type: 'session_created', info: woken })
    deliverControl({ type: 'session_removed', session: 7 })
    await flush()

    expect(shown().sort()).toEqual([1, 9])
    expect(railRows()).toHaveLength(0)
    expect(localStorage.getItem('tr-hidden-panes')).toBe('{}')
  })

  it('a Wake whose replacement and removal arrive together still returns to the grid', async () => {
    await hideFromPlaceholder()
    const woken = makeSession({ id: 9, agent: 'claude', project_dir: WS, cwd: WS, title: 'parser-work', state: 'running', session_origin: 7 })
    act(() => {
      deliverControl({ type: 'session_created', info: woken })
      deliverControl({ type: 'session_removed', session: 7 })
    })
    await flush()

    expect(shown().sort()).toEqual([1, 9])
    expect(railRows()).toHaveLength(0)
  })

  it('stays hidden across an app reload', async () => {
    await hideFromPlaceholder()
    harness!.unmount()
    harness = null
    resetHarness()

    await boot([shell, sleeper])
    expect(shown()).toEqual([1])
    expect(railRows()).toHaveLength(1)
  })

  it('a roster reload does not put the hidden pane back into a grid', async () => {
    await hideFromPlaceholder()
    deliverControl({ type: 'session_list', sessions: [shell, sleeper] })
    deliverControl({ type: 'session_updated', info: { ...sleeper } })
    await flush()

    expect(shown()).toEqual([1])
    expect(railRows()).toHaveLength(1)
  })

  it('closing the hidden session forgets its hidden entry', async () => {
    await hideFromPlaceholder()
    deliverControl({ type: 'session_removed', session: 7 })
    await flush()

    expect(railRows()).toHaveLength(0)
    expect(localStorage.getItem('tr-hidden-panes')).toBe('{}')
  })
})
