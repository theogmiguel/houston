// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { requestSettingsRowJump, clearSettingsRowJumpForTests } from '../settingsRowJump'
import { baseSettingsViewProps } from './settingsViewTestFixtures'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

describe('SettingsView — command-palette row jump', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    clearSettingsRowJumpForTests()
    setSettingsNavForTests({ section: 'appearance' })
  })

  function paletteRow(title: string): HTMLElement | null {
    return Array.from(host.querySelectorAll<HTMLElement>('[data-settings-row-name]')).find(
      (r) => r.getAttribute('data-settings-row-name') === title
    ) ?? null
  }

  it('scrolls the named row into view and flashes it, then clears the flash', () => {
    vi.useFakeTimers()
    requestSettingsRowJump('appearance', 'Palette')
    act(() => setSettingsNavForTests({ section: 'appearance' }))
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })

    const row = paletteRow('Palette')
    expect(row).not.toBeNull()
    expect(row?.scrollIntoView).toHaveBeenCalled()
    expect(row?.style.backgroundColor).toBe('var(--accent-muted)')

    act(() => vi.advanceTimersByTime(900))
    expect(row?.style.backgroundColor).toBe('')
    vi.useRealTimers()
  })

  it('a pending jump for a different section never fires here', () => {
    requestSettingsRowJump('terminal', 'Font size')
    act(() => setSettingsNavForTests({ section: 'appearance' }))
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    const row = paletteRow('Palette')
    expect(row?.style.backgroundColor).toBe('')
  })

  it('with no pending jump, rows render plainly', () => {
    act(() => setSettingsNavForTests({ section: 'appearance' }))
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    const row = paletteRow('Palette')
    expect(row).not.toBeNull()
    expect(row?.style.backgroundColor).toBe('')
  })
})
