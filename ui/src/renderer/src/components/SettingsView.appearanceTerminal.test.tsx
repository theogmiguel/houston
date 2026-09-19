// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import { KEYMAP } from '../keymap'
import { TERMINAL_FONTS } from '../pane/terminalFonts'
import { pickOption, selectOptionLabels } from '../test/selectHarness'
import type { KeymapOverrides } from '../houston/client'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(): React.ComponentProps<typeof SettingsView> {
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
    keymapOverrides: { bindings: {}, shortcuts_enabled: true } as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

function openSection(_container: HTMLDivElement, label: string): void {
  act(() => setSettingsNavForTests({ section: label.toLowerCase() as 'terminal' | 'shortcuts' }))
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Settings › Appearance — app zoom, 4-stop segmented (settings-07)', () => {
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

  function zoomGroup(): HTMLElement {
    return container.querySelector('[role="radiogroup"][aria-label="App zoom"]')!
  }

  it('offers exactly the mock\'s four stops: 90/100/110/125%', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} uiZoom={1} />)
    })
    const labels = Array.from(zoomGroup().querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['90%', '100%', '110%', '125%'])
  })

  it('shows the stop matching the current zoom as selected', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} uiZoom={1.25} />)
    })
    const checked = Array.from(zoomGroup().querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-checked') === 'true'
    )
    expect(checked?.textContent).toBe('125%')
  })

  it('rounds float drift from the keyboard path before matching a stop', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} uiZoom={1.0999999999999999} />)
    })
    const checked = Array.from(zoomGroup().querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-checked') === 'true'
    )
    expect(checked?.textContent).toBe('110%')
  })

  it('shows no stop selected when the keyboard path landed off the four presets', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} uiZoom={1.3} />)
    })
    const checked = Array.from(zoomGroup().querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-checked') === 'true'
    )
    expect(checked).toBeUndefined()
  })

  it('picking a stop commits immediately — a discrete pick, not a drag to release', () => {
    const sent: number[] = []
    act(() => {
      root.render(<SettingsView {...baseProps()} uiZoom={1} onUiZoom={(z) => sent.push(z)} />)
    })
    const button = Array.from(zoomGroup().querySelectorAll('button')).find((b) => b.textContent === '125%')!
    act(() => (button as HTMLButtonElement).click())
    expect(sent).toEqual([1.25])
  })
})

describe('Settings › Appearance — chrome theme (settings-04, theme-match-system)', () => {
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

  it('offers exactly two options, Graphite and Paper — no Match system', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection(container, 'Appearance')
    const group = container.querySelector('[role="radiogroup"][aria-label="Chrome theme"]')!
    const labels = Array.from(group.querySelectorAll('button')).map(
      (b) => b.querySelector('b')?.textContent
    )
    expect(labels).toEqual(['Graphite', 'Paper'])
  })

  it("each tile carries the mock's caption tag", () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection(container, 'Appearance')
    const tags = Array.from(container.querySelectorAll('[data-testid="chrome-theme-tag"]')).map(
      (n) => n.textContent
    )
    expect(tags).toEqual(['Default', 'Light'])
  })

  it('previews the candidate theme on the swatch only, never on the tile card', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection(container, 'Appearance')
    const tiles = Array.from(container.querySelectorAll('[data-testid="chrome-theme-tile"]'))
    expect(tiles).toHaveLength(2)
    for (const tile of tiles) {
      expect(tile.getAttribute('data-theme')).toBeNull()
      expect(
        tile.querySelector('[data-testid="chrome-theme-swatch"]')?.getAttribute('data-theme')
      ).toBeTruthy()
    }
  })

  it('shows Paper as the checked option when the stored theme is "paper"', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} chromeTheme="paper" />)
    })
    openSection(container, 'Appearance')
    const group = container.querySelector('[role="radiogroup"][aria-label="Chrome theme"]')!
    const checked = Array.from(group.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-checked') === 'true'
    )
    expect(checked?.querySelector('b')?.textContent).toBe('Paper')
  })

  it('reports the exact theme clicked', () => {
    const picked: string[] = []
    act(() => {
      root.render(<SettingsView {...baseProps()} onChromeTheme={(t) => picked.push(t)} />)
    })
    openSection(container, 'Appearance')
    const group = container.querySelector('[role="radiogroup"][aria-label="Chrome theme"]')!
    const paperButton = Array.from(group.querySelectorAll('button')).find(
      (b) => b.querySelector('b')?.textContent === 'Paper'
    ) as HTMLButtonElement
    act(() => paperButton.click())
    expect(picked).toEqual(['paper'])
  })
})

describe('Settings › Terminal — font size and family (rows 9, 8)', () => {
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

  it('previews the actual size and family, not a fixed sample', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} fontSize={20} fontFamilyId="system" />)
    })
    openSection(container, 'Terminal')
    const preview = container.querySelector<HTMLElement>('[data-testid="settings-font-preview"]')!
    expect(preview.style.fontSize).toBe('20px')
    expect(preview.style.fontFamily).toContain('ui-monospace')
  })

  it('clamps the size to the documented range instead of sending anything typed', () => {
    const sent: number[] = []
    act(() => {
      root.render(<SettingsView {...baseProps()} onFontSize={(n) => sent.push(n)} />)
    })
    openSection(container, 'Terminal')
    const input = container.querySelector<HTMLInputElement>('[data-testid="settings-font-size"]')!
    setInputValue(input, '999')
    setInputValue(input, '1')
    expect(sent).toEqual([24, 8])
  })

  it('offers every font choice and reports the picked id, not the stack', () => {
    const sent: string[] = []
    act(() => {
      root.render(<SettingsView {...baseProps()} onFontFamilyId={(id) => sent.push(id)} />)
    })
    openSection(container, 'Terminal')
    expect(selectOptionLabels(container, 'settings-font-family')).toHaveLength(
      TERMINAL_FONTS.length
    )
    pickOption(container, 'settings-font-family', 'jetbrains')
    expect(sent).toEqual(['jetbrains'])
  })

  it('warns, in the row itself, that a plain mono loses powerline glyphs', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} fontFamilyId="jetbrains" />)
    })
    openSection(container, 'Terminal')
    expect(container.textContent?.toLowerCase()).toContain('powerline')
  })
})

describe('Settings › Workspaces — "Open links in a browser pane" disables outside a single workspace (settings-51)', () => {
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

  function openWorkspaces(): void {
    act(() => setSettingsNavForTests({ section: 'workspace-defaults' }))
  }

  function linksToggle(): HTMLButtonElement {
    const row = Array.from(container.querySelectorAll('[data-testid="settings-row"]')).find((r) =>
      r.textContent?.includes('Open links in a browser pane')
    )!
    return row.querySelector('[role="switch"]') as HTMLButtonElement
  }

  it('is disabled in the All-workspaces view, where the description already said it would be', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} historyWorkspace={null} />)
    })
    openWorkspaces()
    expect(linksToggle().disabled).toBe(true)
  })

  it('stays enabled once a single workspace is selected', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} historyWorkspace="/home/dev/proj" />)
    })
    openWorkspaces()
    expect(linksToggle().disabled).toBe(false)
  })

  it('does not fire onOpenLinksInPane while disabled', () => {
    const sent: boolean[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          historyWorkspace={null}
          onOpenLinksInPane={(v) => sent.push(v)}
        />
      )
    })
    openWorkspaces()
    act(() => linksToggle().click())
    expect(sent).toEqual([])
  })
})

describe('Settings › Shortcuts — grouped reference list (row 19)', () => {
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

  it('renders a header per category and loses no rows to the grouping', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection(container, 'Shortcuts')

    const groups = container.querySelectorAll('[data-testid="settings-shortcut-group"]')
    expect(groups.length).toBeGreaterThan(1)

    const rows = container.querySelectorAll('[data-testid="settings-shortcut-row"]')
    expect(rows.length).toBe(KEYMAP.length)
  })

  it('puts every group under a labelled header', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection(container, 'Shortcuts')

    const labels = Array.from(
      container.querySelectorAll('[data-testid="settings-shortcut-group-label"]')
    ).map((el) => el.textContent)
    expect(labels).toContain('Global')
    expect(labels.every((l) => (l ?? '').length > 0)).toBe(true)
    expect(labels.length).toBe(
      container.querySelectorAll('[data-testid="settings-shortcut-group"]').length
    )
  })
})
