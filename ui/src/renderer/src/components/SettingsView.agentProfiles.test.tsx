// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import { pickOption, selectTrigger, selectValue } from '../test/selectHarness'
import type { KeymapOverrides } from '../houston/client'
import type { AgentProfileState } from './SettingsView'

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
    keymapOverrides: {} as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

function openAgentProfiles(_container: HTMLDivElement): void {
  act(() => setSettingsNavForTests({ section: 'accounts' }))
}

function stateWithOneClaudeProfile(): AgentProfileState {
  return {
    profiles: [{ id: 1, agent: 'claude', name: 'work', config_dir: '/home/dev/.claude-work' }],
    active: [{ agent: 'claude', id: 1 }]
  }
}

describe('Settings › Accounts — CLAUDE_CONFIG_DIR/CODEX_HOME isolation (row 35)', () => {
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

  it('warns that switching only affects new terminals, before any control is touched', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={{ profiles: [], active: [] }} />)
    })
    openAgentProfiles(container)
    const text = container.textContent ?? ''
    expect(text).toContain('next')
    expect(text.toLowerCase()).toContain('already running')
  })

  it('shows both CLI-specific variable names, never a generic one', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={{ profiles: [], active: [] }} />)
    })
    openAgentProfiles(container)
    const text = container.textContent ?? ''
    expect(text).toContain('CLAUDE_CONFIG_DIR')
    expect(text).toContain('CODEX_HOME')
  })

  it('renders a saved profile and marks it active in its select', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={stateWithOneClaudeProfile()} />)
    })
    openAgentProfiles(container)
    const text = container.textContent ?? ''
    expect(text).toContain('work')
    expect(text).toContain('/home/dev/.claude-work')

    expect(selectValue(container, 'agent-profile-active-claude')).toBe(
      'work — /home/dev/.claude-work'
    )
  })

  it('setting active sends the profile id for the right agent, not the other one', () => {
    const calls: Array<[string, number | null]> = []
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          agentProfiles={stateWithOneClaudeProfile()}
          onAgentProfileSetActive={(agent, id) => calls.push([agent, id])}
        />
      )
    })
    openAgentProfiles(container)
    pickOption(container, 'agent-profile-active-claude', '')
    expect(calls).toEqual([['claude', null]])
  })

  it('deleting a profile sends its id, not a name or index', () => {
    const deleted: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          agentProfiles={stateWithOneClaudeProfile()}
          onAgentProfileDelete={(id) => deleted.push(id)}
        />
      )
    })
    openAgentProfiles(container)
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Delete')
    )
    if (!button) throw new Error('expected a Delete button for the saved profile')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(deleted).toEqual([1])
  })

  it('the active-profile picker is on the shared SELECT_CLS (dropdown-01), not the old rounded-md/11.5px chrome', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={stateWithOneClaudeProfile()} />)
    })
    openAgentProfiles(container)
    const trigger = selectTrigger(container, 'agent-profile-active-claude')
    expect(trigger.className).toContain('var(--tr-radius-input)')
    expect(trigger.className).toContain('var(--tr-text-ui-size)')
    expect(trigger.className).not.toContain('rounded-md')
    expect(trigger.className).not.toContain('text-[11.5px]')
  })
})
