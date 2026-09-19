// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import type { KeymapOverrides } from '../houston/client'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(overrides: {
  keymapOverrides: KeymapOverrides
  onKeymapOverrides: (o: KeymapOverrides) => void
}): React.ComponentProps<typeof SettingsView> {
  return {
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
    usage: null,
    usageLoading: false,
    usageError: null,
    onUsageRequest: () => {},
    voiceSettings: null,
    voiceCloudKeyPresent: false,
    voiceKeyringError: null,
    voiceModels: [],
    voiceDevices: [],
    onVoiceSettingsSet: () => {},
    onVoiceKeySet: () => {},
    onVoiceKeyClear: () => {},
    onVoiceDevicesRefresh: () => {},
    onVoiceModelDownload: () => {},
    onVoiceModelDelete: () => {},
    onVoiceLevelMonitor: () => {},
    agentProfiles: null,
    onAgentProfileUpsert: () => {},
    onAgentProfileDelete: () => {},
    onAgentProfileSetActive: () => {},
    chromeTheme: 'graphite',
    onChromeTheme: () => {},
    theme: 'warm-espresso',
    fontSize: 14,
    onFontSize: () => {},
    fontMin: 8,
    fontMax: 24,
    fontDefault: 14,
    fontFamilyId: 'nerd',
    shiftEnterNewline: true,
    openLinksInPane: false,
    notifyKinds: NOTIFY_KINDS_DEFAULT,
    onNotifyKinds: () => {},
    onOpenLinksInPane: () => {},
    onShiftEnterNewline: () => {},
    onFontFamilyId: () => {},
    uiZoom: 1,
    onUiZoom: () => {},
    zoomMin: 0.5,
    zoomMax: 2,
    zoomStep: 0.1,
    onTheme: () => {},
    shellIntegration: true,
    onShellIntegration: () => {},
    osc52: true,
    onOsc52: () => {},
    copyOnSelect: false,
    onCopyOnSelect: () => {},
    stripBoxGlyphs: true,
    onStripBoxGlyphs: () => {},
    orchestrationState: null,
    onOpenAcpPane: () => {},
    historyWorkspace: null,
    historyWorkspaceName: null,
    historyCount: null,
    onClearHistory: () => {},
    historyIgnoreGlobs: null,
    headlessWriter: null,
    onHeadlessRoleSet: () => {},
    onHistoryIgnoreGlobsSet: () => {},
    onOpenLogsFolder: () => {},
    onContact: () => {},
    onOpenLicense: () => {},
    onRestoreBudgetSet: () => {},
    sessionPolicy: null,
    onSessionPolicy: () => {},
    orchestrationEnabled: true,
    onOrchestrationEnabled: () => {},
    onOrchestrationCapsSet: () => {},
    onMailboxRetentionSet: () => {},
    hostInfo: null,
    agentHooks: null,
    onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
    onRevealSessionDb: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {},
    ...overrides
  }
}

function pressKey(init: Partial<KeyboardEventInit>): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

describe('SettingsView Shortcuts section (P4 #16)', () => {
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
  })

  function openShortcuts(props: React.ComponentProps<typeof SettingsView>): void {
    act(() => setSettingsNavForTests({ section: 'shortcuts' }))
    act(() => {
      root.render(<SettingsView {...props} />)
    })
  }

  it('renders terminal/gesture/swarm rows as fixed, with no capture affordance', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const fixedRow = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('find in the terminal')
    )
    expect(fixedRow).toBeTruthy()
    const chip = fixedRow!.querySelector('.key-chip') as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(chip.className).toContain('key-chip--fixed')
  })

  it('captures a new chord for a global shortcut and persists it', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('toggle the sidebar')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })
    expect(container.querySelector('.armed')).not.toBeNull()

    pressKey({ code: 'KeyJ', ctrlKey: true })

    expect(onKeymapOverrides).toHaveBeenCalledWith({
      bindings: { 'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false } },
      shortcuts_enabled: true
    })
  })

  it('a bare-modifier keydown does not complete the capture — waits for the real chord', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('toggle the sidebar')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ key: 'Control', code: 'ControlLeft', ctrlKey: true })
    expect(onKeymapOverrides).not.toHaveBeenCalled()
    expect(container.querySelector('.armed')).not.toBeNull()

    pressKey({ key: 'j', code: 'KeyJ', ctrlKey: true })

    expect(onKeymapOverrides).toHaveBeenCalledWith({
      bindings: { 'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false } },
      shortcuts_enabled: true
    })
  })

  it('Escape cancels an armed capture without binding Escape', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('toggle the sidebar')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ key: 'Escape', code: 'Escape' })

    expect(onKeymapOverrides).not.toHaveBeenCalled()
    expect(container.querySelector('.armed')).toBeNull()
  })

  it('refuses a capture that conflicts with another global shortcut, naming it, and persists nothing', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('zoom in (whole app)')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ code: 'KeyB', ctrlKey: true, key: 'b' })

    expect(onKeymapOverrides).not.toHaveBeenCalled()
    expect(row.textContent).toContain('Already bound to')
    expect(row.textContent).toContain('toggle the sidebar')
  })

  it('refuses a capture reserved by a fixed terminal chord, with a distinct message', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('zoom in (whole app)')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ code: 'KeyF', ctrlKey: true, key: 'f' })

    expect(onKeymapOverrides).not.toHaveBeenCalled()
    expect(row.textContent).toContain('owned by the terminal')
  })

  it('shows a Reset button only for an overridden row, and it clears just that id', () => {
    const onKeymapOverrides = vi.fn()
    const overrides: KeymapOverrides = {
      bindings: {
        'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false },
        'zoom-in': { code: 'KeyK', ctrl: true, alt: false, shift: false, meta: false }
      },
      shortcuts_enabled: true
    }
    openShortcuts(baseProps({ keymapOverrides: overrides, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('toggle the sidebar')
    )!
    const resetBtn = row.querySelector('[data-testid="settings-row-reset"]') as HTMLButtonElement
    expect(resetBtn).toBeTruthy()
    act(() => {
      resetBtn.click()
    })

    expect(onKeymapOverrides).toHaveBeenCalledWith({
      bindings: { 'zoom-in': { code: 'KeyK', ctrl: true, alt: false, shift: false, meta: false } },
      shortcuts_enabled: true
    })
  })

  it('"Reset all" clears every override', () => {
    const onKeymapOverrides = vi.fn()
    const overrides: KeymapOverrides = {
      bindings: {
        'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false }
      },
      shortcuts_enabled: true
    }
    openShortcuts(baseProps({ keymapOverrides: overrides, onKeymapOverrides }))

    const resetAll = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset all')
    ) as HTMLButtonElement
    expect(resetAll.disabled).toBe(false)
    act(() => {
      resetAll.click()
    })

    expect(onKeymapOverrides).toHaveBeenCalledWith({ bindings: {}, shortcuts_enabled: true })
  })

  it('captures modifiers for select-pane on a digit keydown, discarding nothing silently', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('select pane (visual order)')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ key: '3', code: 'Digit3', ctrlKey: true, altKey: true })

    expect(onKeymapOverrides).toHaveBeenCalledWith({
      bindings: { 'select-pane': { code: 'Digit3', ctrl: true, alt: true, shift: false, meta: false } },
      shortcuts_enabled: true
    })
  })

  it('refuses a non-digit capture for select-pane instead of silently discarding the keypress', () => {
    const onKeymapOverrides = vi.fn()
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides }))

    const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
      r.textContent?.includes('select pane (visual order)')
    )!
    const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
    act(() => {
      captureBtn.click()
    })

    pressKey({ key: 'b', code: 'KeyB', ctrlKey: true })

    expect(onKeymapOverrides).not.toHaveBeenCalled()
    expect(container.querySelector('.armed')).toBeNull()
    expect(row.textContent).toContain('1-9')
  })

  it('"Reset all" is disabled when there are no overrides', () => {
    openShortcuts(baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides: vi.fn() }))
    const resetAll = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset all')
    ) as HTMLButtonElement
    expect(resetAll.disabled).toBe(true)
  })

  describe('master kill-switch', () => {
    it('toggling it off preserves bindings, and vice versa', () => {
      const bindings = {
        'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false }
      }
      const onKeymapOverridesOff = vi.fn()
      openShortcuts(
        baseProps({
          keymapOverrides: { bindings, shortcuts_enabled: true },
          onKeymapOverrides: onKeymapOverridesOff
        })
      )

      const toggleOff = container.querySelector('[data-testid="settings-row"] .sw') as HTMLButtonElement
      expect(toggleOff).toBeTruthy()
      act(() => {
        toggleOff.click()
      })

      expect(onKeymapOverridesOff).toHaveBeenCalledWith({
        bindings,
        shortcuts_enabled: false
      })

      const onKeymapOverridesOn = vi.fn()
      openShortcuts(
        baseProps({
          keymapOverrides: { bindings, shortcuts_enabled: false },
          onKeymapOverrides: onKeymapOverridesOn
        })
      )

      const toggleOn = container.querySelector('[data-testid="settings-row"] .sw') as HTMLButtonElement
      expect(toggleOn).toBeTruthy()
      act(() => {
        toggleOn.click()
      })

      expect(onKeymapOverridesOn).toHaveBeenCalledWith({
        bindings,
        shortcuts_enabled: true
      })
    })

    it('per-binding capture still works while the master switch is off', () => {
      const onKeymapOverrides = vi.fn()
      openShortcuts(
        baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: false }, onKeymapOverrides })
      )

      const row = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
        r.textContent?.includes('toggle the sidebar')
      )!
      const captureBtn = row.querySelector('.key-chip--capture') as HTMLButtonElement
      act(() => {
        captureBtn.click()
      })
      pressKey({ code: 'KeyJ', ctrlKey: true })

      expect(onKeymapOverrides).toHaveBeenCalledWith({
        bindings: { 'toggle-sidebar': { code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false } },
        shortcuts_enabled: false
      })
    })

    it('marks global rows as inert (visually) while off, leaving fixed terminal rows alone', () => {
      openShortcuts(
        baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: false }, onKeymapOverrides: vi.fn() })
      )

      const globalRow = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
        r.textContent?.includes('toggle the sidebar')
      )!
      expect(globalRow.getAttribute('data-inert')).toBe('true')

      const terminalRow = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
        r.textContent?.includes('find in the terminal')
      )!
      expect(terminalRow.getAttribute('data-inert')).toBeNull()
    })

    it('marks the editor row as inert (visually) while off, same as a global row, though it is not remappable', () => {
      openShortcuts(
        baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: false }, onKeymapOverrides: vi.fn() })
      )

      const editorRow = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
        r.textContent?.includes('split the editor pane down')
      )!
      expect(editorRow.getAttribute('data-inert')).toBe('true')
      expect(editorRow.textContent).toContain('off (shortcuts disabled)')
      expect(editorRow.querySelector('.key-chip--capture')).toBeNull()
      expect(editorRow.querySelector('.key-chip--fixed')).not.toBeNull()
    })

    it('leaves the editor row alone (not inert) while shortcuts are on', () => {
      openShortcuts(
        baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides: vi.fn() })
      )

      const editorRow = Array.from(container.querySelectorAll('[data-testid="settings-shortcut-row"]')).find((r) =>
        r.textContent?.includes('split the editor pane down')
      )!
      expect(editorRow.getAttribute('data-inert')).toBeNull()
      expect(editorRow.textContent).not.toContain('off (shortcuts disabled)')
    })

    it("the master switch's own copy describes what it covers without enumerating chords", () => {
      openShortcuts(
        baseProps({ keymapOverrides: { bindings: {}, shortcuts_enabled: true }, onKeymapOverrides: vi.fn() })
      )
      const desc = Array.from(container.querySelectorAll('div')).find((d) =>
        d.textContent?.startsWith('Turns off the shortcuts below')
      )
      expect(desc, 'the master switch has no description').toBeTruthy()
      expect(desc?.textContent).toContain("the editor pane's own keys")
      expect(desc?.textContent).not.toContain('Ctrl+Shift+D')
      expect(desc?.textContent).not.toContain('Ctrl+Backspace')
    })
  })
})
