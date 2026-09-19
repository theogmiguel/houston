// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'
import { LIVE_CHILDREN_MARKER } from './houston/client'

const REFUSAL = `${LIVE_CHILDREN_MARKER} refusing session_close for pane 1: 2 live children (ids 3, 4)`

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function findButton(harness: AppHarness, label: string): HTMLButtonElement {
  const btn = Array.from(harness.container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  )
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn
}

describe('child-guard confirm flow on kill/close (v62 D3)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('opens the dialog on the marker error and re-sends a close with confirm_children', async () => {
    harness = await renderReadyApp()
    const h = harness
    const client = currentClient()
    ;(client.takeRecentDestroyIntent as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce({ session: 1, kind: 'close' })

    deliverControl({ type: 'error', message: REFUSAL, context: null })

    expect(h.container.textContent).toContain('Pane has live children')
    expect(h.container.querySelector('#confirm-modal-msg')?.textContent).toBe(REFUSAL)
    expect(findButton(h, 'Kill anyway')).toBeTruthy()
    expect(findButton(h, 'Cancel')).toBeTruthy()

    act(() => {
      findButton(h, 'Kill anyway').click()
    })

    expect(client.confirmCloseSession).toHaveBeenCalledTimes(1)
    expect(client.confirmCloseSession).toHaveBeenCalledWith(1)
    expect(client.confirmKillSession).not.toHaveBeenCalled()
  })

  it('re-sends a kill when the refused action was a kill', async () => {
    harness = await renderReadyApp()
    const h = harness
    const client = currentClient()
    ;(client.takeRecentDestroyIntent as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce({ session: 2, kind: 'kill' })

    deliverControl({
      type: 'error',
      message: `${LIVE_CHILDREN_MARKER} refusing session_kill for pane 2: 1 live child (id 5)`,
      context: null
    })

    act(() => {
      findButton(h, 'Kill anyway').click()
    })

    expect(client.confirmKillSession).toHaveBeenCalledTimes(1)
    expect(client.confirmKillSession).toHaveBeenCalledWith(2)
    expect(client.confirmCloseSession).not.toHaveBeenCalled()
  })

  it('sends nothing when the operator cancels', async () => {
    harness = await renderReadyApp()
    const h = harness
    const client = currentClient()
    ;(client.takeRecentDestroyIntent as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce({ session: 1, kind: 'close' })

    deliverControl({ type: 'error', message: REFUSAL, context: null })
    expect(h.container.textContent).toContain('Pane has live children')

    act(() => {
      findButton(h, 'Cancel').click()
    })

    expect(client.confirmCloseSession).not.toHaveBeenCalled()
    expect(client.confirmKillSession).not.toHaveBeenCalled()
  })

  it('falls back to the error banner when no fresh intent explains the refusal', async () => {
    harness = await renderReadyApp()
    const client = currentClient()

    deliverControl({ type: 'error', message: REFUSAL, context: null })

    expect(harness.container.textContent).not.toContain('Pane has live children')
    expect(harness.container.textContent).toContain(REFUSAL)
    expect(client.confirmCloseSession).not.toHaveBeenCalled()
    expect(client.confirmKillSession).not.toHaveBeenCalled()
  })
})
