// @vitest-environment jsdom
import { act } from 'react'
import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  type AppHarness,
  currentClient,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const SIZE = { cols: 111, rows: 37 }
vi.mock('./pane/newPaneSize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane/newPaneSize')>()),
  newPaneSize: vi.fn(() => SIZE),
  newPaneSizes: vi.fn(({ count }: { count?: number }) =>
    Array.from({ length: count ?? 1 }, () => SIZE)
  )
}))
const sizing = await import('./pane/newPaneSize')

function click(el: Element | null | undefined, what: string): void {
  if (!el) throw new Error(`${what} not found`)
  act(() => {
    ;(el as HTMLElement).click()
  })
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})
afterEach(() => {
  harness?.unmount()
  harness = null
  vi.clearAllMocks()
})

describe('a new pane starts its PTY at the size it will be shown at', () => {
  it('a split sends the size of the half it takes from its anchor', async () => {
    harness = await renderReadyApp()
    const createSession = currentClient().createSession as unknown as Mock
    createSession.mockClear()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    })

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd_from: 1, ...SIZE }))
    expect(sizing.newPaneSize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { anchor: 1, side: 'right' }
    )
  })

  it('a composer launch sends each slot the size it will land in', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const createSession = currentClient().createSession as unknown as Mock
    createSession.mockClear()

    click(container.querySelector('[aria-label^="New session in "]'), 'the "New session" button')
    await waitFor(
      () => expect(container.querySelector('[data-testid="new-session-composer"]')).not.toBeNull(),
      { timeout: 5_000 }
    )
    click(container.querySelector('[data-preset="workbench"]'), 'the Workbench preset')
    click(container.querySelector('[data-testid="new-session-launch"]'), 'Launch')

    expect(createSession).toHaveBeenCalledTimes(2)
    for (const [params] of createSession.mock.calls) expect(params).toMatchObject(SIZE)
    expect(sizing.newPaneSizes).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }))
  })
})
