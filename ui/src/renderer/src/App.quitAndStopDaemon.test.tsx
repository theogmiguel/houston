// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const { daemonStatusMock } = vi.hoisted(() => ({ daemonStatusMock: vi.fn() }))
vi.mock('./houston/manage', async () => {
  const actual = await vi.importActual<typeof import('./houston/manage')>('./houston/manage')
  return { ...actual, daemonStatus: daemonStatusMock }
})

const { appStopDaemonsAndQuitMock } = vi.hoisted(() => ({
  appStopDaemonsAndQuitMock: vi.fn(async () => {})
}))
vi.mock('./houston/tray', async () => {
  const actual = await vi.importActual<typeof import('./houston/tray')>('./houston/tray')
  return { ...actual, appStopDaemonsAndQuit: appStopDaemonsAndQuitMock }
})

function pressCtrlK(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))
  })
}

async function openAndRunQuit(h: AppHarness): Promise<void> {
  pressCtrlK()
  await vi.waitFor(() => expect(h.container.querySelector('[data-testid="command-palette"]')).not.toBeNull())
  const search = h.container.querySelector<HTMLInputElement>('[data-testid="command-palette-search"]')!
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(search, 'Quit and stop daemon')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
    appStopDaemonsAndQuitMock.mockReset()
  })

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('shows local status and invokes native all-environment shutdown only after confirmation', async () => {
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
    expect(appStopDaemonsAndQuitMock).not.toHaveBeenCalled()
    expect(windowControl).not.toHaveBeenCalled()

    const dialog = harness.container.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('stops daemons in all environments')
    expect(dialog!.textContent).toContain('Local daemon status: 3 live sessions and 2 enabled routines.')
    expect(dialog!.textContent).toContain('Counts for other environments are not available here.')

    const confirm = dialog!.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(appStopDaemonsAndQuitMock).toHaveBeenCalledTimes(1)
    expect(windowControl).not.toHaveBeenCalledWith('close')
  })

  it('keeps WSL shutdown scope clear when local status reports zero sessions', async () => {
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

    await openAndRunQuit(harness)
    const dialog = harness.container.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('stops daemons in all environments, including WSL')
    expect(dialog.textContent).toContain('Local daemon status: 0 live sessions and 0 enabled routines.')
    expect(dialog.textContent).toContain('Counts for other environments are not available here.')
    expect(appStopDaemonsAndQuitMock).not.toHaveBeenCalled()
  })

  it('shows safe all-environment copy and allows proceeding when the local status fetch fails', async () => {
    daemonStatusMock.mockRejectedValue(new Error('network error'))
    harness = await renderReadyApp()

    await openAndRunQuit(harness)
    const dialog = harness.container.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('stops daemons in all environments')
    expect(dialog!.textContent).toContain('local daemon did not answer a status check')
    expect(dialog!.textContent).toContain('counts are unknown')
    expect(dialog!.textContent).not.toContain('0 live sessions')
    expect(appStopDaemonsAndQuitMock).not.toHaveBeenCalled()

    const confirm = dialog!.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(appStopDaemonsAndQuitMock).toHaveBeenCalledTimes(1)
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
    expect(appStopDaemonsAndQuitMock).not.toHaveBeenCalled()
    expect(windowControl).not.toHaveBeenCalled()
  })
})
