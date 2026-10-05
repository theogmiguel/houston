import React from 'react'
import { SettingsView } from '../src/components/SettingsView'
import { Sidebar } from '../src/components/Sidebar'
import { baseSettingsViewProps, hostInfoFixture } from '../src/components/settingsViewTestFixtures'
import { setSettingsNavForTests } from '../src/settingsNav'
import { setMode } from '../src/backgroundMode'
import type { SessionInfo, Workspace } from '../src/houston/client'
import type { SettingsSectionId } from '../src/settingsSections'

const noop = (): void => {}

export function SettingsScreen({
  section,
  props
}: {
  section: SettingsSectionId
  props?: Partial<React.ComponentProps<typeof SettingsView>>
}): React.JSX.Element {
  setSettingsNavForTests({ open: true, section })
  const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--content-bg)' }}>
      <Sidebar
        workspaces={[ws('/home/dev/code/houston', 'houston')]}
        sessions={[] as SessionInfo[]}
        selected="/home/dev/code/houston"
        customColors={{}}
        colorIndexByPath={{}}
        renaming={null}
        onSelect={noop}
        onAddWorkspace={noop}
        onRemoveWorkspace={noop}
        onRenameStart={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onChangeColor={noop}
        onReorderWorkspace={noop}
        pinnedWorkspaces={new Set()}
        onTogglePinWorkspace={noop}
        onSshConnect={noop}
        chromeTheme="graphite"
        onToggleChromeTheme={noop}
        onOpenSettings={noop}
      />
      <SettingsView {...baseSettingsViewProps()} {...props} />
    </div>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  return <SettingsScreen section="appearance" />
}

export function SettingsAppearanceCustom(): React.JSX.Element {
  React.useEffect(() => setMode('custom'), [])
  return <SettingsScreen section="appearance" />
}

export function SettingsTerminal(): React.JSX.Element {
  return <SettingsScreen section="terminal" />
}

export function SettingsShortcuts(): React.JSX.Element {
  return <SettingsScreen section="shortcuts" />
}

export function SettingsDiagnostics(): React.JSX.Element {
  return <SettingsScreen section="daemon" props={{ hostInfo: hostInfoFixture() }} />
}

export function SettingsAgentSetup(): React.JSX.Element {
  return <SettingsScreen section="agents" props={{ agentHooks: [
    { provider: 'claude', path: '~/.claude/settings.json', scope: 'global', enabled: true, installed: true, error: null, present: true, version: '2.1.263', trust: null },
    { provider: 'codex', path: '~/.codex/config.toml', scope: 'global', enabled: false, installed: false, error: null, present: false, version: null, trust: 'not_confirmed' },
    { provider: 'opencode', path: '~/.config/opencode/plugins/houston.ts', scope: 'global', enabled: true, installed: false, error: 'Managed hook file is missing', present: true, version: '1.18.27', trust: null }
  ] }} />
}

export function SettingsOrchestration(): React.JSX.Element {
  return <SettingsScreen section="orchestration" />
}

export function SettingsDictation(): React.JSX.Element {
  return <SettingsScreen section="dictation" />
}

export function SettingsWorkspaces(): React.JSX.Element {
  return <SettingsScreen section="workspaces" />
}

export function SettingsPrivacy(): React.JSX.Element {
  return <SettingsScreen section="privacy" />
}

export function SettingsAbout(): React.JSX.Element {
  return <SettingsScreen section="about" />
}

export function SettingsSearchStory(): React.JSX.Element {
  React.useEffect(() => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search settings"]')
    if (!input) return
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, 'workspace')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])
  return <SettingsScreen section="workspaces" />
}
