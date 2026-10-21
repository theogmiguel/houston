// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { NotificationsSection } from './NotificationsSection'

const { isTauriMock, supportMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  supportMock: vi.fn()
}))
vi.mock('../../houston/host', () => ({ isTauri: () => isTauriMock() }))
vi.mock('../../houston/bridge', () => ({ nativeNotificationSupport: () => supportMock() }))

const userAgent = navigator.userAgent

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  isTauriMock.mockImplementation(() => false)
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
})

function desktopApp(platform: string): void {
  isTauriMock.mockImplementation(() => true)
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: platform })
}

const renderSection = (delivery: { allowed: boolean; error?: string } | null) =>
  render(
    <NotificationsSection
      desktopMode="notifications-sound"
      onDesktopMode={() => {}}
      inApp
      onInApp={() => {}}
      delivery={delivery}
    />
  )

describe('NotificationsSection', () => {
  it('marks desktop permission as allowed with a leading check in the ok colour', () => {
    renderSection({ allowed: true })
    const status = screen.getByTestId('desktop-notification-status')
    expect(status.textContent).toBe('Allowed by the desktop')
    expect(status.className).toContain('text-[var(--ok)]')
    expect(status.querySelector('svg')).toBeTruthy()
  })

  it('keeps refused delivery wording and warning colour without the granted icon', () => {
    renderSection({ allowed: false })
    const status = screen.getByTestId('desktop-notification-status')
    expect(status.textContent).toContain('The desktop refused this notification.')
    expect(status.className).toContain('text-[var(--warn)]')
    expect(status.querySelector('svg')).toBeNull()
  })

  it('uses the board control width and lets the in-app description wrap fully', () => {
    renderSection(null)
    const desktopSelect = screen.getByTestId('desktop-notification-mode')
    expect(desktopSelect.closest('div[style]')?.getAttribute('style')).toContain('width: 210px')
    const description = screen.getByText(/While Houston is focused/)
    const descriptionLayout = description.closest('[data-testid="settings-row-desc"]')
    expect(descriptionLayout?.className).toContain('whitespace-normal')
    expect(descriptionLayout?.className).not.toContain('truncate')
    expect(screen.getByTestId('notification-children-note').textContent).toBe(
      'Child panes ask their orchestrator first. Only requests addressed to you trigger notifications and taskbar attention; requests escalated to you show their reason.'
    )
  })

  it('asks the Windows desktop app for support instead of refusing the platform', async () => {
    desktopApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0')
    supportMock.mockResolvedValue({ supported: true, reason: null })
    renderSection(null)
    await waitFor(() =>
      expect(screen.getByTestId('desktop-notification-status').textContent).toBe('Desktop notification service available')
    )
    expect(supportMock).toHaveBeenCalledTimes(1)
  })

  it('shows the reason the desktop app gives when notifications are unavailable', async () => {
    desktopApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0')
    supportMock.mockResolvedValue({
      supported: false,
      reason: "Windows reports notifications for 'dev.houston.desktop' as disabled for this user"
    })
    renderSection(null)
    await waitFor(() =>
      expect(screen.getByTestId('desktop-notification-status').textContent).toBe(
        "Desktop notifications are unavailable: Windows reports notifications for 'dev.houston.desktop' as disabled for this user"
      )
    )
  })

  it('still refuses macOS by name without asking the desktop app', () => {
    desktopApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15')
    renderSection(null)
    expect(screen.getByTestId('desktop-notification-status').textContent).toBe('Not available on macOS yet')
    expect(supportMock).not.toHaveBeenCalled()
  })
})
