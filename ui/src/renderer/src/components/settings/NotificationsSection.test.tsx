// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { NotificationsSection } from './NotificationsSection'

afterEach(cleanup)

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
      'Child panes report to the agent that started them, not to you. The taskbar icon counts the panes waiting on you.'
    )
  })
})
