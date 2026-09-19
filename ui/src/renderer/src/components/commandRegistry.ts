import { setSettingsOpen, setSettingsSection } from '../settingsNav'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '../settingsSections'
import { SETTINGS_ROW_REGISTRY } from '../settingsRowRegistry'
import { requestSettingsRowJump } from '../settingsRowJump'
import { PANE_TYPES, paneTypeButtonState, type PaneTypeKind } from '../layout/paneTypes'
import type { AgentKind } from '../houston/client'
import type { Workspace } from '../houston/generated/Workspace'
import { gridRecency, gridRecencyKey } from '../gridRecency'
import {
  newTerminal as newTerminalShortcut,
  newBrowserPane as newBrowserPaneShortcut,
  toggleGit as toggleGitShortcut,
  toggleSidebar as toggleSidebarShortcut,
  togglePanel as togglePanelShortcut,
  splitRight as splitRightShortcut,
  tidyGrid as tidyGridShortcut,
  equalizePanes as equalizePanesShortcut,
  shortcutSheetShortcut,
  settingsShortcut,
  type ShortcutEntry
} from '../keymap'

export type CommandGroup =
  | 'Panes'
  | 'Agents'
  | 'Grid'
  | 'Tabs'
  | 'View'
  | 'Go to'
  | 'Appearance'
  | 'Workspaces'
  | 'Window'

export interface Command {
  id: string
  title: string
  group: CommandGroup
  keywords?: string[]
  chord?: ShortcutEntry
  enabled: boolean
  disabledReason?: string
  run: () => void
}

export interface PaletteActions {
  newTerminal: () => void
  insertPane: (kind: 'browser') => void
  splitPane?: () => void
  newGrid: () => void
  closePane?: () => void
  toggleGitPane: () => void
  spawnAgent: (agent: AgentKind) => void

  toggleSidebarRail: () => void
  toggleChromeTheme: () => void
  openAddPanePopover: () => void
  setGridLayout: (cols: 1 | 2 | 3 | 4) => void
  tidyPanes?: () => void
  equalizePanes?: () => void
  openNotifications: () => void
  markAllNotificationsRead: () => void
  openShortcutSheet: () => void

  windowMinimize?: () => void
  windowMaximize?: () => void
  windowClose?: () => void
  quitAndStopDaemon?: () => void

  selectNavRow: (row: 'routines' | 'skills' | 'mcp') => void

  switchWorkspace: (path: string | 'all') => void

  switchGrid: (path: string, gridId: string) => void
}

export const APPEARANCE_PICKER_COMMAND_ID = 'go-to.appearance-picker'

const PANE_DISABLED_REASON: Partial<Record<PaneTypeKind, string>> = {
  editor: 'Editor has no blank state — open a file, a diff, or a terminal link instead',
  skills: 'Skills moved into Settings — open it from Settings › Capabilities › Skills'
}

const PANE_KEYWORDS: Partial<Record<PaneTypeKind, string[]>> = {
  browser: ['url', 'webview', 'preview'],
  git: ['diff', 'status', 'branch', 'stage', 'commit', 'review', 'pr', 'git'],
  editor: ['file', 'code'],
  skills: ['library']
}

const AGENT_KINDS: readonly { kind: AgentKind; label: string }[] = [
  { kind: 'claude', label: 'Claude Code' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'antigravity', label: 'Antigravity' },
  { kind: 'opencode', label: 'opencode' },
  { kind: 'cursor', label: 'Cursor Agent' },
  { kind: 'grok', label: 'Grok' }
]

function buildSettingsSectionCommands(): Command[] {
  return SETTINGS_SECTIONS.map((s) => ({
    id: `go-to.settings.${s.id}`,
    title: `Settings — ${s.label}`,
    group: 'Go to' as const,
    keywords: ['settings', 'preferences', ...s.keywords],
    enabled: !s.pending,
    disabledReason: s.pending ? 'This section is not built yet' : undefined,
    run: () => {
      setSettingsOpen(true)
      setSettingsSection(s.id as SettingsSectionId)
    }
  }))
}

function buildSettingsRowCommands(): Command[] {
  const commands: Command[] = []
  for (const section of SETTINGS_SECTIONS) {
    const rows = SETTINGS_ROW_REGISTRY[section.id]
    if (!rows) continue
    for (const title of rows) {
      commands.push({
        id: `go-to.settings-row.${section.id}.${title}`,
        title: `${section.label} › ${title}`,
        group: 'Go to' as const,
        keywords: ['settings', 'preferences', ...section.keywords],
        enabled: true,
        run: () => {
          setSettingsOpen(true)
          setSettingsSection(section.id)
          requestSettingsRowJump(section.id, title)
        }
      })
    }
  }
  return commands
}

function buildRailNavCommands(actions: PaletteActions): Command[] {
  const rows: {
    id: 'routines' | 'skills' | 'mcp'
    title: string
    keywords: string[]
  }[] = [
    { id: 'routines', title: 'Go to Routines', keywords: ['schedule', 'cron'] },
    { id: 'skills', title: 'Go to Skills', keywords: ['library', 'commands'] },
    { id: 'mcp', title: 'Go to Connections', keywords: ['mcp', 'servers', 'plugins', 'model context protocol'] }
  ]
  return rows.map((r) => ({
    id: `go-to.nav.${r.id}`,
    title: r.title,
    group: 'Go to' as const,
    keywords: r.keywords,
    enabled: true,
    run: () => actions.selectNavRow(r.id)
  }))
}

function buildPaneCommands(actions: PaletteActions, hasWorkspace: boolean): Command[] {
  const commands: Command[] = [
    {
      id: 'panes.new-terminal',
      title: 'New terminal',
      group: 'Panes',
      keywords: ['shell', 'session', 'spawn'],
      chord: newTerminalShortcut,
      enabled: true,
      run: () => actions.newTerminal()
    },
    {
      id: 'panes.open-add-pane-menu',
      title: 'Open the Add-pane menu',
      group: 'Panes',
      keywords: ['new pane', '+'],
      chord: togglePanelShortcut,
      enabled: true,
      run: () => actions.openAddPanePopover()
    },
    {
      id: 'panes.split',
      title: 'Split pane',
      group: 'Panes',
      keywords: ['split right', 'divide'],
      chord: splitRightShortcut,
      enabled: actions.splitPane !== undefined,
      disabledReason: actions.splitPane === undefined ? 'No focused pane to split' : undefined,
      run: () => actions.splitPane?.()
    },
    {
      id: 'panes.new-grid',
      title: 'New grid',
      group: 'Panes',
      keywords: ['layout', 'tab'],
      enabled: true,
      run: () => actions.newGrid()
    },
    {
      id: 'panes.close',
      title: 'Close pane',
      group: 'Panes',
      keywords: ['exit', 'kill'],
      enabled: actions.closePane !== undefined,
      disabledReason: actions.closePane === undefined ? 'No focused pane to close' : undefined,
      run: () => actions.closePane?.()
    }
  ]

  // Source control is a panel, not a grid leaf: 'g' toggles it, and a
  // "New Changes pane" row would only compete with that. The id and the chord
  // stay `panes.toggle-git` so the habit and the palette both keep working.
  commands.push({
    id: 'panes.toggle-git',
    title: 'Toggle source control panel',
    group: 'Panes',
    keywords: [...(PANE_KEYWORDS.git ?? []), 'git', 'changes'],
    chord: toggleGitShortcut,
    enabled: true,
    run: () => actions.toggleGitPane()
  })

  for (const t of PANE_TYPES) {
    const forcedReason = PANE_DISABLED_REASON[t.kind]
    const state = paneTypeButtonState(t, hasWorkspace)
    const disabled = forcedReason !== undefined || !t.insertable || state.disabled || !hasWorkspace
    commands.push({
      id: `panes.new-${t.kind}`,
      title: `New ${t.label} pane`,
      group: 'Panes',
      keywords: PANE_KEYWORDS[t.kind] ?? [],
      chord: t.kind === 'browser' ? newBrowserPaneShortcut : undefined,
      enabled: !disabled,
      disabledReason: disabled ? (forcedReason ?? (!hasWorkspace ? `Open a workspace to use ${t.label}` : state.title)) : undefined,
      run: () => {
        if (t.kind === 'browser') actions.insertPane('browser')
      }
    })
  }
  return commands
}

function buildAgentCommands(actions: PaletteActions, hasWorkspace: boolean): Command[] {
  return AGENT_KINDS.map(({ kind, label }) => ({
    id: `agents.spawn.${kind}`,
    title: `New ${label} session`,
    group: 'Agents' as const,
    keywords: ['spawn', 'agent', kind],
    enabled: hasWorkspace,
    disabledReason: hasWorkspace ? undefined : `Open a workspace to spawn ${label}`,
    run: () => actions.spawnAgent(kind)
  }))
}

function buildGridCommands(actions: PaletteActions): Command[] {
  const cols: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4]
  const commands: Command[] = [
    {
      id: 'grid.tidy',
      title: 'Tidy panes',
      group: 'Grid',
      keywords: ['balance', 'arrange', 'even', 'grid'],
      chord: tidyGridShortcut,
      enabled: actions.tidyPanes !== undefined,
      disabledReason:
        actions.tidyPanes === undefined ? 'Open a second pane to tidy the grid' : undefined,
      run: () => actions.tidyPanes?.()
    },
    {
      id: 'grid.equalize',
      title: 'Equalize splits',
      group: 'Grid',
      keywords: ['even', 'reset', 'ratios', 'splitter'],
      chord: equalizePanesShortcut,
      enabled: actions.equalizePanes !== undefined,
      disabledReason:
        actions.equalizePanes === undefined ? 'Open a second pane to even out splits' : undefined,
      run: () => actions.equalizePanes?.()
    }
  ]
  for (const n of cols)
    commands.push({
      id: `grid.layout.${n}`,
      title: `Set grid layout: ${n}×`,
      group: 'Grid',
      keywords: ['columns', 'density', 'resize'],
      enabled: true,
      run: () => actions.setGridLayout(n)
    })
  return commands
}

function buildViewCommands(actions: PaletteActions): Command[] {
  const commands: Command[] = [
    {
      id: 'view.toggle-sidebar',
      title: 'Toggle sidebar',
      group: 'View',
      keywords: ['rail', 'collapse'],
      chord: toggleSidebarShortcut,
      enabled: true,
      run: () => actions.toggleSidebarRail()
    },
    {
      id: 'view.notifications.open',
      title: 'Open notifications',
      group: 'View',
      keywords: ['bell', 'alerts'],
      enabled: true,
      run: () => actions.openNotifications()
    },
    {
      id: 'view.notifications.mark-all-read',
      title: 'Mark all notifications read',
      group: 'View',
      keywords: ['bell', 'clear', 'unread'],
      enabled: true,
      run: () => actions.markAllNotificationsRead()
    },
    {
      id: 'view.shortcuts',
      title: 'Show keyboard shortcuts',
      group: 'View',
      keywords: ['help', 'keymap', 'cheatsheet'],
      chord: shortcutSheetShortcut,
      enabled: true,
      run: () => actions.openShortcutSheet()
    }
  ]
  if (actions.windowMinimize) {
    commands.push({
      id: 'window.minimize',
      title: 'Minimize window',
      group: 'Window',
      enabled: true,
      run: () => actions.windowMinimize?.()
    })
  }
  if (actions.windowMaximize) {
    commands.push({
      id: 'window.maximize',
      title: 'Maximize window',
      group: 'Window',
      enabled: true,
      run: () => actions.windowMaximize?.()
    })
  }
  if (actions.windowClose) {
    commands.push({
      id: 'window.close',
      title: 'Close window',
      group: 'Window',
      enabled: true,
      run: () => actions.windowClose?.()
    })
  }
  if (actions.quitAndStopDaemon) {
    commands.push({
      id: 'window.quit-and-stop-daemon',
      title: 'Quit and stop daemon',
      group: 'Window',
      keywords: ['exit', 'shutdown', 'stop daemon', 'background process'],
      enabled: true,
      run: () => actions.quitAndStopDaemon?.()
    })
  }
  return commands
}

function buildOpenTabCommands(
  actions: PaletteActions,
  grids: readonly GridTarget[]
): Command[] {
  const seen = gridRecency()
  const ranked = [...grids].sort(
    (a, b) =>
      (seen.get(gridRecencyKey(b.path, b.gridId)) ?? 0) -
      (seen.get(gridRecencyKey(a.path, a.gridId)) ?? 0)
  )
  return ranked.map((g) => ({
    id: `tabs.open.${g.path}.${g.gridId}`,
    title: g.name,
    group: 'Tabs' as const,
    keywords: [g.workspaceName, g.path, 'tab', 'grid'],
    enabled: true,
    run: () => actions.switchGrid(g.path, g.gridId)
  }))
}

function buildWorkspaceCommands(actions: PaletteActions, workspaces: readonly Workspace[]): Command[] {
  const commands: Command[] = [
    {
      id: 'workspaces.all',
      title: 'All workspaces',
      group: 'Workspaces',
      keywords: ['everything', 'combined'],
      enabled: true,
      run: () => actions.switchWorkspace('all')
    }
  ]
  for (const w of workspaces) {
    commands.push({
      id: `workspaces.switch.${w.path}`,
      title: w.name,
      group: 'Workspaces',
      keywords: [w.path],
      enabled: true,
      run: () => actions.switchWorkspace(w.path)
    })
  }
  return commands
}

function buildAppearanceCommand(): Command {
  return {
    id: APPEARANCE_PICKER_COMMAND_ID,
    title: 'Change terminal palette…',
    group: 'Appearance',
    keywords: ['theme', 'colors', 'colours', 'appearance', 'terminal colors'],
    enabled: true,
    run: () => {
      setSettingsOpen(true)
      setSettingsSection('appearance')
    }
  }
}

export interface BuildCommandsInput {
  actions: PaletteActions
  hasWorkspace: boolean
  workspaces: readonly Workspace[]
  grids?: readonly GridTarget[]
}

export interface GridTarget {
  path: string
  workspaceName: string
  gridId: string
  name: string
}

export function buildCommands(input: BuildCommandsInput): Command[] {
  const { actions, hasWorkspace, workspaces, grids } = input
  return [
    ...buildOpenTabCommands(actions, grids ?? []),
    ...buildPaneCommands(actions, hasWorkspace),
    ...buildAgentCommands(actions, hasWorkspace),
    ...buildGridCommands(actions),
    ...buildViewCommands(actions),
    ...buildRailNavCommands(actions),
    {
      id: 'go-to.settings',
      title: 'Settings',
      group: 'Go to',
      keywords: ['preferences', 'options'],
      chord: settingsShortcut,
      enabled: true,
      run: () => setSettingsOpen(true)
    },
    ...buildSettingsSectionCommands(),
    ...buildSettingsRowCommands(),
    buildAppearanceCommand(),
    {
      id: 'appearance.toggle-theme',
      title: 'Toggle theme',
      group: 'Appearance',
      keywords: ['dark', 'light', 'graphite', 'paper', 'chrome theme'],
      enabled: true,
      run: () => actions.toggleChromeTheme()
    },
    ...buildWorkspaceCommands(actions, workspaces)
  ]
}

export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands]
  const scored: { cmd: Command; score: number }[] = []
  for (const cmd of commands) {
    const titleScore = fuzzyScore(cmd.title.toLowerCase(), q)
    const keywordScores = (cmd.keywords ?? []).map((k) => fuzzyScore(k.toLowerCase(), q))
    const keywordScore = keywordScores.length > 0 ? Math.max(...keywordScores) : -1
    const score = titleScore >= 0 ? titleScore + 1000 : keywordScore >= 0 ? keywordScore : -1
    if (score >= 0) scored.push({ cmd, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cmd)
}

function fuzzyScore(text: string, q: string): number {
  let ti = 0
  let qi = 0
  let firstIdx = -1
  let lastIdx = -1
  let gaps = 0
  while (ti < text.length && qi < q.length) {
    if (text[ti] === q[qi]) {
      if (firstIdx === -1) firstIdx = ti
      if (lastIdx !== -1) gaps += ti - lastIdx - 1
      lastIdx = ti
      qi += 1
    }
    ti += 1
  }
  if (qi < q.length) return -1
  const prefixBonus = text.startsWith(q) ? 500 : 0
  return prefixBonus + 200 - firstIdx - gaps
}
