import React from 'react'
import { NewSessionComposer } from '../src/components/NewSessionComposer'

function NewSession(): React.JSX.Element {
  return (
    <NewSessionComposer
      workspaceName="acme"
      workspacePath="~/Desktop/acme"
      onLaunch={() => {}}
      onCancel={() => {}}
    />
  )
}

function NewSessionClicked({ selector }: { selector: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(selector)?.click()
  }, [selector])
  return (
    <div ref={ref} style={{ display: 'flex', height: '100%' }}>
      <NewSession />
    </div>
  )
}
import { Sidebar } from '../src/components/Sidebar'
import type { SessionInfo, Workspace } from '../src/houston/client'
import { SettingsAgentSetup, SettingsAppearance, SettingsDiagnostics, SettingsTerminal } from './settingsStories'
import {
  NoticesError,
  NoticesExiting,
  NoticesPaneCorner,
  NoticesResting,
  NoticesStacked
} from './noticeStories'

import {
  NavHooks,
  NavMcp,
  NavMcpDetail,
  NavRoutineEditor,
  NavRoutines,
  NavRoutinesEmpty,
  NavSkills
} from './navStories'

const noop = (): void => {}

function RailWorkspacesMulti(): React.JSX.Element {
  const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar
        workspaces={[
          ws('/home/dev/code/acme-core', 'acme-core'),
          ws('/home/dev/code/acme-api', 'acme-api'),
          ws('/home/dev/code/bridgespace-tauri', 'bridgespace-tauri'),
          ws('/home/dev/code/acme-ui', 'acme-ui'),
          ws('/home/dev/code/acme-one-swift', 'acme-one-swift'),
          ws('/home/dev/code/houston', 'houston')
        ]}
        sessions={[] as SessionInfo[]}
        selected="/home/dev/code/acme-one-swift"
        selectedGridId="grok-build"
        gridsByWorkspace={{
          '/home/dev/code/acme-core': [
            { id: 'work-in', name: 'Work in', count: 5, state: 'working' },
            { id: 'disc', name: 'Disc utilization space check', count: 3, state: 'working' },
            { id: 'bomb', name: 'Bomb calorimeter design', count: 4, state: 'working' }
          ],
          '/home/dev/code/acme-one-swift': [
            { id: 'grok-build', name: 'Grok Build', count: 3, state: 'working' },
            { id: 'swift-ui', name: 'SwiftUI pass', count: 1, state: 'idle' },
            { id: 'notarize', name: 'Notarize', state: 'needs-input' }
          ]
        }}
        customColors={{}}
        colorIndexByPath={{}}
        unreadByWs={{}}
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
        onSelectGrid={noop}
        onAddGrid={noop}
        onRenameGrid={noop}
        onRemoveGrid={noop}
        onOpenSettings={noop}
      />
    </div>
  )
}

export const STORIES: Record<string, () => React.JSX.Element> = {
  'new-session/default': () => <NewSession />,
  'new-session/swarm': () => <NewSessionClicked selector='[data-preset="swarm"]' />,
  'new-session/terminal': () => <NewSessionClicked selector='[data-agent="shell"]' />,
  'harness/smoke': () => (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        color: 'var(--text-primary)',
        font: '500 13px var(--font-sans, sans-serif)'
      }}
    >
      harness ok — theme tokens, fonts and Tailwind layers loaded
    </div>
  ),
  'rail/workspaces-multi': () => <RailWorkspacesMulti />,
  'settings/agent-setup': () => <SettingsAgentSetup />,
  'settings/appearance': () => <SettingsAppearance />,
  'settings/terminal': () => <SettingsTerminal />,
  'settings/diagnostics': () => <SettingsDiagnostics />,
  'notices/resting': () => <NoticesResting />,
  'notices/stacked': () => <NoticesStacked />,
  'notices/error': () => <NoticesError />,
  'notices/exiting': () => <NoticesExiting />,
  'notices/pane-corner': () => <NoticesPaneCorner />,
  'nav/routines': () => <NavRoutines />,
  'nav/routines-empty': () => <NavRoutinesEmpty />,
  'nav/routine-editor': () => <NavRoutineEditor />,
  'nav/skills': () => <NavSkills />,
  'nav/mcp': () => <NavMcp />,
  'nav/mcp-detail': () => <NavMcpDetail />,
  'nav/hooks': () => <NavHooks />
}
