import { CommandPalette, type CommandPaletteProps } from '../src/components/ui/CommandPalette'
import type { PaletteActions } from '../src/components/commandRegistry'
import type { SessionInfo } from '../src/houston/generated/SessionInfo'
import { KeymapOverridesContext } from '../src/layout/keymapOverridesContext'
import { THEMES } from '../src/theme'
import { PALETTE_RECENTS_KEY } from '../src/components/ui/paletteHelpers'

const noop = (): void => {}
localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(['panes.toggle-git']))
const actions: PaletteActions = {
  newTerminal: noop, insertPane: noop, newGrid: noop, toggleGitPane: noop, spawnAgent: noop,
  openTasks: noop, toggleSidebarRail: noop, toggleChromeTheme: noop, openAddPanePopover: noop,
  setGridLayout: noop, openShortcutSheet: noop, selectNavRow: noop, switchWorkspace: noop,
  switchGrid: noop, focusPane: noop, restartPane: noop
}

const sessions = [
  { id: 1, agent: 'claude', project_dir: '/home/theo/ProjetosPessoais/Houston', cwd: '/home/theo/ProjetosPessoais/Houston', state: 'running', title: 'auth-refactor', codename: 'auth-refactor', hidden: false, status: 'needs-input', resumable: true },
  { id: 2, agent: 'codex', project_dir: '/home/theo/ProjetosPessoais/Houston', cwd: '/home/theo/ProjetosPessoais/Houston', state: 'running', title: 'migrate-db', codename: 'migrate-db', hidden: false, status: 'working', resumable: true }
] as SessionInfo[]

function PaletteStory(): React.JSX.Element {
  const props: CommandPaletteProps = {
    onClose: noop,
    actions,
    hasWorkspace: true,
    workspaces: [{ path: '/home/theo/ProjetosPessoais/Houston', name: 'houston' }],
    sessions,
    activeSessionId: null,
    appearance: { currentTheme: THEMES[0], onPreview: noop, onCommit: noop }
  }
  return (
    <KeymapOverridesContext.Provider value={{ shortcuts_enabled: true, bindings: {} }}>
      <CommandPalette {...props} />
    </KeymapOverridesContext.Provider>
  )
}

export function PaletteGraphiteStory(): React.JSX.Element {
  return <div data-theme="graphite" className="h-full"><PaletteStory /></div>
}

export function PalettePaperStory(): React.JSX.Element {
  return <div data-theme="paper" className="h-full"><PaletteStory /></div>
}
