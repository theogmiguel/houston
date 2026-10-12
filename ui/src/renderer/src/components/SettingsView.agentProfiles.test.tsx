// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import type { KeymapOverrides } from '../houston/client'
import type { AgentHookState } from '../houston/generated/AgentHookState'
import type { AgentProfileState } from './SettingsView'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(): React.ComponentProps<typeof SettingsView> {
  const agentHooks: AgentHookState[] = ['claude', 'codex'].map((provider) => ({
    provider: provider as AgentHookState['provider'],
    path: `~/.${provider}/settings.json`,
    scope: 'workspace' as const,
    enabled: false,
    installed: false,
    error: null,
    present: true,
    version: '1.0.0',
    trust: null
  }))
  return {
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
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
    onRestoreResumeSet: () => {},
    onWorktreeCleanupSet: () => {},
    onWorktreeIdleRemovalDaysSet: () => {},
    sessionPolicy: null,
    onSessionPolicy: () => {},
    orchestrationEnabled: true,
    onOrchestrationEnabled: () => {},
    onOrchestrationCapsSet: () => {},
    onMailboxRetentionSet: () => {},
    hostInfo: null,
    agentHooks,
    onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
    onRevealSessionDb: () => {},
    keymapOverrides: {} as KeymapOverrides,
    onKeymapOverrides: () => {},
  }
}

function openAgentProfiles(container: HTMLDivElement): void {
  act(() => setSettingsNavForTests({ section: 'accounts' }))
  expect(container.querySelector('[data-testid="list-detail-item"]')).toBeNull()
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
    expect(text).toContain('Running panes keep their account.')
  })

  it('shows both CLI-specific variable names, never a generic one', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={{ profiles: [], active: [] }} />)
    })
    openAgentProfiles(container)
    const text = container.textContent ?? ''
    expect(text).toContain('CLAUDE_CONFIG_DIR')
    const codexText = container.textContent ?? ''
    expect(codexText).toContain('CODEX_HOME')
  })

  it('renders a saved profile and marks it active in its select', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} agentProfiles={stateWithOneClaudeProfile()} />)
    })
    openAgentProfiles(container)
    const text = container.textContent ?? ''
    expect(text).toContain('work')
    expect(text).toContain('/home/dev/.claude-work')

    expect(container.textContent).toContain('New panes')
    expect(container.querySelector('[data-testid="agent-profile-use-1"]')).toBeNull()
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
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="agent-profile-default-claude"]')!.click())
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
    const rename = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Rename')!
    act(() => rename.click())
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes('Delete'))
    if (!button) throw new Error('expected a Delete button for the saved profile')
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(deleted).toEqual([1])
  })

  it('account controls use shared button and value-chip chrome', () => {
    act(() => root.render(<SettingsView {...baseProps()} agentProfiles={stateWithOneClaudeProfile()} />))
    openAgentProfiles(container)
    const button = container.querySelector<HTMLButtonElement>('[data-testid="agent-profile-default-claude"]')!
    expect(button.className).toContain('var(--tr-radius-button)')
    expect(button.className).toContain('var(--tr-text-ui-size)')
    expect(button.className).not.toContain('rounded-md')
    expect(button.className).not.toContain('text-[11.5px]')
    const value = container.querySelector<HTMLElement>('[data-testid="chip"]')!
    expect(value.className).toContain('var(--tr-radius-sm)')
  })
})
