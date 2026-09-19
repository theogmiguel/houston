// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonStatus } from '../../houston/manage'
import { DaemonSection } from './DaemonSection'

const { daemonStatusMock, daemonShutdownMock } = vi.hoisted(() => ({
  daemonStatusMock: vi.fn(),
  daemonShutdownMock: vi.fn()
}))
vi.mock('../../houston/manage', async () => {
  const actual = await vi.importActual<typeof import('../../houston/manage')>('../../houston/manage')
  return { ...actual, daemonStatus: daemonStatusMock, daemonShutdown: daemonShutdownMock }
})

const { trayStateMock, setKeepInTrayMock } = vi.hoisted(() => ({
  trayStateMock: vi.fn(),
  setKeepInTrayMock: vi.fn()
}))
vi.mock('../../houston/tray', async () => {
  const actual = await vi.importActual<typeof import('../../houston/tray')>('../../houston/tray')
  return { ...actual, trayState: trayStateMock, setKeepInTray: setKeepInTrayMock }
})

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    manage_version: 1,
    protocol_version: 92,
    build: 'abc1234',
    pid: 4321,
    started_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    live_sessions: { count: 3, ids: [1, 2, 3] },
    routines_enabled: 2,
    clients_connected: 1,
    handoff: { supported: true, reason: '' },
    reap: { armed: false, deadline_ms: null },
    ...overrides
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('DaemonSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    daemonStatusMock.mockReset()
    daemonShutdownMock.mockReset()
    trayStateMock.mockReset()
    setKeepInTrayMock.mockReset()
    trayStateMock.mockResolvedValue(null)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('shows a loading state, then the daemon facts, on mount', async () => {
    daemonStatusMock.mockResolvedValue(status())
    act(() => {
      root.render(<DaemonSection />)
    })
    expect(container.querySelector('[data-testid="daemon-section-loading"]')).not.toBeNull()
    await flush()
    expect(container.querySelector('[data-testid="daemon-section-facts"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="daemon-fact-sessions"]')?.textContent).toContain('3')
    expect(container.querySelector('[data-testid="daemon-fact-routines"]')?.textContent).toContain('2')
    expect(container.querySelector('[data-testid="daemon-fact-clients"]')?.textContent).toContain('1')
    expect(daemonStatusMock).toHaveBeenCalledTimes(1)
  })

  it('shows an error with a retry, never an endless spinner, when the first fetch fails', async () => {
    daemonStatusMock.mockRejectedValueOnce(new Error('refused: unknown management contract'))
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    expect(container.querySelector('[data-testid="daemon-section-loading"]')).toBeNull()
    expect(container.querySelector('[data-testid="daemon-section-error"]')?.textContent).toContain(
      'refused: unknown management contract'
    )
    daemonStatusMock.mockResolvedValueOnce(status())
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="daemon-section-retry"]')!
    act(() => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.querySelector('[data-testid="daemon-section-facts"]')).not.toBeNull()
  })

  it('names the five-minute grace and what is currently holding the daemon up when unarmed', async () => {
    daemonStatusMock.mockResolvedValue(
      status({ reap: { armed: false, deadline_ms: null }, live_sessions: { count: 2, ids: [1, 2] }, routines_enabled: 0, clients_connected: 1 })
    )
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    const reap = container.querySelector('[data-testid="daemon-section-reap"]')!
    expect(reap.textContent).toContain('5 minutes')
    expect(reap.textContent).toContain('2 live sessions')
  })

  it('names the countdown when the reap predicate is armed', async () => {
    daemonStatusMock.mockResolvedValue(
      status({ reap: { armed: true, deadline_ms: 4 * 60_000 }, live_sessions: { count: 0, ids: [] }, routines_enabled: 0 })
    )
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    const reap = container.querySelector('[data-testid="daemon-section-reap"]')!
    expect(reap.textContent).toContain('Will exit in 4 min')
  })

  it('polls every 5s while mounted, and stops polling once unmounted', async () => {
    daemonStatusMock.mockResolvedValue(status())
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    expect(daemonStatusMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(daemonStatusMock).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
    await act(async () => {
      vi.advanceTimersByTime(20_000)
      await Promise.resolve()
    })
    expect(daemonStatusMock).toHaveBeenCalledTimes(2)
  })

  it('the confirm dialog names the exact live-session and routine counts, and Stop daemon calls daemon_shutdown', async () => {
    daemonStatusMock.mockResolvedValue(status({ live_sessions: { count: 3, ids: [1, 2, 3] }, routines_enabled: 2 }))
    daemonShutdownMock.mockResolvedValue({ ok: true, stopped_sessions: 3, disarmed_routines: 2 })
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    const stopButton = container.querySelector<HTMLButtonElement>('[data-testid="daemon-section-stop"]')!
    act(() => stopButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const dialog = container.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('This ends 3 live sessions and disarms 2 routines.')

    const confirm = dialog.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    act(() => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(daemonShutdownMock).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="daemon-section-stopped"]')?.textContent).toContain('stopped')
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('cancelling the confirm dialog leaves the daemon untouched', async () => {
    daemonStatusMock.mockResolvedValue(status())
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="daemon-section-stop"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    const dialog = container.querySelector('[role="alertdialog"]')!
    const cancel = dialog.querySelector<HTMLButtonElement>('button.btn')!
    expect(cancel.textContent).toContain('Cancel')
    act(() => cancel.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(daemonShutdownMock).not.toHaveBeenCalled()
  })

  it('surfaces a refused shutdown verbatim without claiming the daemon stopped', async () => {
    daemonStatusMock.mockResolvedValue(status())
    daemonShutdownMock.mockRejectedValue(new Error('refused: 1 live SSH session (id 7)'))
    act(() => {
      root.render(<DaemonSection />)
    })
    await flush()
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="daemon-section-stop"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    const dialog = container.querySelector('[role="alertdialog"]')!
    const confirm = dialog.querySelector<HTMLButtonElement>('button.btn:last-of-type')!
    act(() => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(container.querySelector('[data-testid="daemon-section-stopped"]')).toBeNull()
    expect(container.querySelector('[data-testid="daemon-section-stop-error"]')?.textContent).toContain(
      'refused: 1 live SSH session (id 7)'
    )
  })

  describe('the Background group (hide to tray)', () => {
    const view = (over: Partial<import('../../houston/tray').TrayStateView> = {}) => ({
      available: true,
      reason: null,
      keepInTray: true,
      hidesOnClose: true,
      ...over
    })

    function toggle(): HTMLButtonElement {
      const el = container.querySelector<HTMLButtonElement>(
        '[data-testid="daemon-section-keep-in-tray"]'
      )
      if (!el) throw new Error('the keep-in-tray toggle is not on screen')
      return el
    }

    async function renderWith(
      tray: import('../../houston/tray').TrayStateView | null
    ): Promise<void> {
      daemonStatusMock.mockResolvedValue(status())
      trayStateMock.mockResolvedValue(tray)
      act(() => {
        root.render(<DaemonSection />)
      })
      await flush()
    }

    it('shows the setting with its current value, on by default', async () => {
      await renderWith(view())
      expect(toggle().getAttribute('aria-checked')).toBe('true')
      expect(container.textContent).toContain('Closing the window hides it')
    })

    it('says what closing the window does when the setting is off', async () => {
      await renderWith(view({ keepInTray: false, hidesOnClose: false }))
      expect(toggle().getAttribute('aria-checked')).toBe('false')
      expect(container.textContent).toContain('Closing the window quits Houston')
    })

    it('greys the setting out and names the missing bus name when there is no tray', async () => {
      const reason =
        'No tray on this desktop: nothing owns org.kde.StatusNotifierWatcher; on GNOME that is the AppIndicator extension'
      await renderWith(view({ available: false, hidesOnClose: false, reason }))
      expect(toggle().disabled).toBe(true)
      expect(container.textContent).toContain('org.kde.StatusNotifierWatcher')
      expect(container.textContent).toContain('AppIndicator extension')
    })

    it('persists a change and shows what came back', async () => {
      await renderWith(view())
      setKeepInTrayMock.mockResolvedValue(view({ keepInTray: false, hidesOnClose: false }))
      act(() => toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(setKeepInTrayMock).toHaveBeenCalledWith(false)
      expect(toggle().getAttribute('aria-checked')).toBe('false')
    })

    it('surfaces a failed write instead of silently reverting', async () => {
      await renderWith(view())
      setKeepInTrayMock.mockRejectedValue(new Error('Could not save the tray setting to /x/tray.json'))
      act(() => toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })))
      await flush()
      expect(
        container.querySelector('[data-testid="daemon-section-tray-error"]')?.textContent
      ).toContain('Could not save the tray setting')
    })

    it('is absent entirely when there is no host to ask', async () => {
      await renderWith(null)
      expect(
        container.querySelector('[data-testid="daemon-section-keep-in-tray"]')
      ).toBeNull()
    })
  })
})
