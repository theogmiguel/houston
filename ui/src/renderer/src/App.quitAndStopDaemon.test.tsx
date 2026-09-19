// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const { daemonStatusMock, daemonShutdownMock } = vi.hoisted(() => ({
  daemonStatusMock: vi.fn(),
  daemonShutdownMock: vi.fn()
}))
vi.mock('./houston/manage', async () => {
  const actual = await vi.importActual<typeof import('./houston/manage')>('./houston/manage')
  return { ...actual, daemonStatus: daemonStatusMock, daemonShutdown: daemonShutdownMock }
})

const { appQuitMock } = vi.hoisted(() => ({ appQuitMock: vi.fn(async () => {}) }))
vi.mock('./houston/tray', async () => {
  const actual = await vi.importActual<typeof import('./houston/tray')>('./houston/tray')
  return { ...actual, appQuit: appQuitMock }
})

function pressCtrlK(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))
  })
}

async function openAndRunQuit(h: AppHarness): Promise<void> {
  pressCtrlK()
  const row = Array.from(h.container.querySelectorAll('[data-testid="command-palette-row"]')).find((r) =>
    r.textContent?.includes('Quit and stop daemon')
  )
  if (!row) throw new Error('"Quit and stop daemon" row not found in the palette')
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Quit and stop daemon (D6, from the command palette)', () => {
  let harness: AppHarness | null = null

  beforeEach(() => {
    resetHarness()
    localStorage.clear()
    daemonStatusMock.mockReset()
    daemonShutdownMock.mockReset()
    appQuitMock.mockClear()
  })

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('fetches daemon_status and confirms with the exact live-session and routine counts before doing anything', async () => {
    daemonStatusMock.mockResolvedValue({
      manage_version: 1,
      protocol_version: 92,
      build: 'abc1234',
      pid: 1,
      started_at: new Date().toISOString(),
      live_sessions: { count: 3, ids: [1, 2, 3] },
      routines_enabled: 2,
      clients_connected: 1,
      handoff: { supported: true, reason: '' },
      reap: { armed: false, deadline_ms: null }
    })
    harness = await renderReadyApp()
    const windowControl = (window as unknown as { houston: { windowControl: import('vitest').Mock } }).houston
      .windowControl

    await openAndRunQuit(harness)
    expect(daemonStatusMock).toHaveBeenCalledTimes(1)
    expect(daemonShutdownMock).not.toHaveBeenCalled()
    expect(windowControl).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()

    const dialog = harness.container.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('This ends 3 live sessions and disarms 2 routines.')

    const confirm = dialog!.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    daemonShutdownMock.mockResolvedValue({ ok: true, stopped_sessions: 3, disarmed_routines: 2 })
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(daemonShutdownMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(windowControl).not.toHaveBeenCalledWith('close')
  })

  it('still opens the confirm — with unknown counts — and still lets the user proceed when the status fetch fails', async () => {
    daemonStatusMock.mockRejectedValue(new Error('network error'))
    daemonShutdownMock.mockResolvedValue({ ok: true, stopped_sessions: 0, disarmed_routines: 0 })
    harness = await renderReadyApp()

    await openAndRunQuit(harness)
    const dialog = harness.container.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('unknown number of live sessions')

    const confirm = dialog!.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(daemonShutdownMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
  })

  it('cancelling the confirm quits nothing and stops nothing', async () => {
    daemonStatusMock.mockResolvedValue({
      manage_version: 1,
      protocol_version: 92,
      build: 'abc1234',
      pid: 1,
      started_at: new Date().toISOString(),
      live_sessions: { count: 0, ids: [] },
      routines_enabled: 0,
      clients_connected: 1,
      handoff: { supported: true, reason: '' },
      reap: { armed: false, deadline_ms: null }
    })
    harness = await renderReadyApp()
    const windowControl = (window as unknown as { houston: { windowControl: import('vitest').Mock } }).houston
      .windowControl

    await openAndRunQuit(harness)
    const dialog = harness.container.querySelector('[role="alertdialog"]')!
    const cancel = dialog.querySelector<HTMLButtonElement>('button.btn')!
    expect(cancel.textContent).toContain('Cancel')
    vi.useFakeTimers()
    try {
      act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      act(() => vi.advanceTimersByTime(200))
      expect(harness.container.querySelector('[role="alertdialog"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    expect(daemonShutdownMock).not.toHaveBeenCalled()
    expect(windowControl).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
  })
})
