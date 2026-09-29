// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { isSettingsOpen, setSettingsNavForTests } from '../settingsNav'
import { closeUpdateModal, isUpdateModalOpen } from '../updateModal'
import { resetUpdateInstall, setUpdateInstallForTests } from '../updateInstall'
import type { SessionInfo, Workspace } from '../houston/client'

function noop(): void {}

function baseProps(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    workspaces: [] as Workspace[],
    sessions: [] as SessionInfo[],
    selected: '',
    customColors: {},
    colorIndexByPath: {},
    unreadByWs: {},
    renaming: null,
    onSelect: noop,
    onAddWorkspace: noop,
    onRemoveWorkspace: noop,
    onRenameStart: noop,
    onRenameSubmit: noop,
    onRenameCancel: noop,
    onChangeColor: noop,
    onReorderWorkspace: noop,
    pinnedWorkspaces: new Set(),
    onTogglePinWorkspace: noop,
    onSshConnect: noop,
    onOpenSettings: noop,
    chromeTheme: 'graphite',
    onToggleChromeTheme: noop,
    ...overrides
  }
}

describe('Sidebar railfoot — Settings and theme icon buttons', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    setSettingsNavForTests({ open: false })
    resetUpdateInstall()
    closeUpdateModal()
  })

  function render(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}): void {
    act(() => {
      root.render(<Sidebar {...baseProps(overrides)} />)
    })
  }

  function foot(): HTMLElement {
    return container.querySelector('.railfoot') as HTMLElement
  }

  it('renders exactly two buttons in the railfoot, no "Settings" text and no hide control', () => {
    render()
    const buttons = foot().querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    expect(foot().textContent).not.toContain('Settings')
    expect(foot().querySelector('button[aria-label="Hide sidebar"]')).toBeNull()
  })

  it('both buttons are 28px squares over the topbar-sized ui glyph, not label-sized tiles or oversized ones', () => {
    render()
    for (const button of Array.from(foot().querySelectorAll('button'))) {
      const cls = button.className
      expect(cls).toContain('h-[var(--h-ctl)]')
      expect(cls).toContain('w-[var(--h-ctl)]')
      expect(cls).not.toContain('w-[18px]')
      expect(cls).not.toContain('after:absolute')
      expect(cls).toContain('hover:bg-[var(--card-hover)]')
      const glyph = button.querySelector('svg')!
      expect(glyph.getAttribute('class')).toContain('var(--tr-icon-ui-size)')
    }
  })

  it('the foot draws no rule above itself', () => {
    render()
    expect(foot().className).not.toContain('border-t')
  })

  it('clicking the gear button calls onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    render({ onOpenSettings })
    const gear = foot().querySelector('button[aria-label="Settings"]') as HTMLButtonElement
    expect(gear).not.toBeNull()
    act(() => gear.click())
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('the theme button names and performs the switch to light while graphite is current', () => {
    const onToggleChromeTheme = vi.fn()
    render({ chromeTheme: 'graphite', onToggleChromeTheme })
    const theme = foot().querySelector('button[aria-label="Switch to light theme"]') as HTMLButtonElement
    expect(theme).not.toBeNull()
    act(() => theme.click())
    expect(onToggleChromeTheme).toHaveBeenCalledTimes(1)
  })

  it('the theme button names and performs the switch to dark while paper is current', () => {
    const onToggleChromeTheme = vi.fn()
    render({ chromeTheme: 'paper', onToggleChromeTheme })
    const theme = foot().querySelector('button[aria-label="Switch to dark theme"]') as HTMLButtonElement
    expect(theme).not.toBeNull()
    act(() => theme.click())
    expect(onToggleChromeTheme).toHaveBeenCalledTimes(1)
  })

  it('renders nothing for an update nobody offered -- no third button, no reserved space', () => {
    render()
    expect(foot().querySelector('[data-testid="rail-update-available"]')).toBeNull()
    expect(foot().querySelectorAll('button')).toHaveLength(2)
  })

  it('offers one worded chip carrying the glyph and the version, pushed to the far end', () => {
    render({ updateVersion: '1.2.3' })
    const buttons = Array.from(foot().querySelectorAll('button'))
    expect(buttons).toHaveLength(3)
    const indicator = buttons[2]
    expect(indicator.getAttribute('data-testid')).toBe('rail-update-available')
    expect(indicator.getAttribute('aria-label')).toBe('Houston v1.2.3 is available. Open to install')
    expect(indicator.textContent).toBe('1.2.3 available')
    expect(indicator.querySelector('svg')).not.toBeNull()
    // One hit target for the pair: the words are inside the button, and the
    // button is the only thing in the foot that owns the right edge.
    expect(indicator.querySelectorAll('button')).toHaveLength(0)
    expect(indicator.className).toContain('ml-auto')
  })

  it('opens the install modal, not Settings, when the chip is clicked', () => {
    setSettingsNavForTests({ open: false, section: 'appearance' })
    closeUpdateModal()
    render({ updateVersion: '1.2.3' })
    const indicator = foot().querySelector('[data-testid="rail-update-available"]') as HTMLButtonElement
    act(() => indicator.click())
    expect(isUpdateModalOpen()).toBe(true)
    expect(isSettingsOpen()).toBe(false)
    closeUpdateModal()
  })

  it('shows the running install as a percentage, even for a release waved off', () => {
    render({ updateVersion: null })
    act(() => setUpdateInstallForTests({ kind: 'downloading', downloaded: 42, total: 100 }))
    const chip = foot().querySelector('[data-testid="rail-update-available"]') as HTMLButtonElement
    expect(chip.textContent).toBe('Updating 42%')
    act(() => setUpdateInstallForTests({ kind: 'installing' }))
    expect(chip.textContent).toBe('Updating…')
  })

  it('shows a failed install in the warn colour with its own words', () => {
    render({ updateVersion: '1.2.3' })
    act(() => setUpdateInstallForTests({ kind: 'failed', version: '1.2.3', error: 'boom' }))
    const chip = foot().querySelector('[data-testid="rail-update-available"]') as HTMLButtonElement
    expect(chip.textContent).toBe('Update failed')
    expect(chip.className).toContain('--warn')
  })

  it('the Settings button reflects settingsOpen with aria-pressed', () => {
    setSettingsNavForTests({ open: false })
    render()
    const gear = foot().querySelector('button[aria-label="Settings"]') as HTMLButtonElement
    expect(gear.getAttribute('aria-pressed')).toBe('false')

    act(() => setSettingsNavForTests({ open: true }))
    expect(gear.getAttribute('aria-pressed')).toBe('true')
  })
})
