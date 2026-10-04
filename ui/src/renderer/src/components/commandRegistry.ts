import { setSettingsOpen, setSettingsSection } from '../settingsNav'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '../settingsSections'
import { SETTINGS_ROW_REGISTRY } from '../settingsRowRegistry'
import { requestSettingsRowJump } from '../settingsRowJump'
import { PANE_TYPES, paneTypeButtonState, type PaneTypeKind } from '../layout/paneTypes'
import type { AgentKind } from '../houston/client'
import type { Workspace } from '../houston/generated/Workspace'
import type { SessionInfo } from '../houston/generated/SessionInfo'
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
  wsPrev,
  wsNext,
  wsLast,
  gridPrev,
  gridNext,
  type ShortcutEntry
} from '../keymap'

export type CommandGroup =
  | 'Sessions'
  | 'Recent'
  | 'Panes'
  | 'Agents'
  | 'Grid'
  | 'Tabs'
  | 'View'
  | 'Go to'
  | 'Appearance'
  | 'Workspaces'
  | 'Tasks'
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
  session?: SessionInfo
  subtitle?: string
}

export interface PaletteActions {
  newTerminal: () => void
  insertPane: (kind: 'browser') => void
  splitPane?: () => void
  newGrid: () => void
  closePane?: () => void
  toggleGitPane: () => void
  spawnAgent: (agent: AgentKind) => void
  openTasks: (compose?: boolean) => void
  /// The focused terminal's current selection, read when the palette builds
  /// its commands; empty when no terminal holds one.
  focusedSelection?: () => string
  newTaskFromSelection?: (selection: string) => void

  toggleSidebarRail: () => void
  toggleChromeTheme: () => void
  openAddPanePopover: () => void
  setGridLayout: (cols: 1 | 2 | 3 | 4) => void
  tidyPanes?: () => void
  equalizePanes?: () => void
  openShortcutSheet: () => void

  windowMinimize?: () => void
  windowMaximize?: () => void
  windowClose?: () => void
  quitAndStopDaemon?: () => void

  selectNavRow: (row: 'routines' | 'skills' | 'harness' | 'mcp' | 'usage') => void

  switchWorkspace: (path: string | 'all') => void

  switchGrid: (path: string, gridId: string) => void
  focusPane?: (id: number) => void
  restartPane?: (id: number) => void

  stepWorkspace?: (offset: 1 | -1) => void
  selectLastWorkspace?: () => void
  stepGrid?: (offset: 1 | -1) => void
}

type PaletteNav = Pick<PaletteActions, 'stepWorkspace' | 'selectLastWorkspace' | 'stepGrid'>

// A navigation command with nowhere to go is disabled with its reason, so each move
// is offered only when it can act.
export function paletteNavActions(
  nav: Required<PaletteNav> & {
    workspaceCount: number
    lastWorkspace: string | null
    selectedWs: string
    gridsFor: (path: string) => readonly unknown[]
  }
): PaletteNav {
  const gridsToStep = nav.selectedWs !== 'all' && nav.gridsFor(nav.selectedWs).length > 1
  return {
    stepWorkspace: nav.workspaceCount > 0 ? nav.stepWorkspace : undefined,
    selectLastWorkspace: nav.lastWorkspace !== null ? nav.selectLastWorkspace : undefined,
    stepGrid: gridsToStep ? nav.stepGrid : undefined
  }
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
    id: 'routines' | 'skills' | 'harness' | 'mcp' | 'usage'
    title: string
    keywords: string[]
  }[] = [
    { id: 'routines', title: 'Go to Routines', keywords: ['schedule', 'cron'] },
    { id: 'skills', title: 'Go to Skills', keywords: ['library', 'commands'] },
    { id: 'harness', title: 'Go to Harness', keywords: ['review', 'findings', 'mistakes'] },
    { id: 'mcp', title: 'Go to Connections', keywords: ['mcp', 'servers', 'plugins', 'model context protocol'] },
    { id: 'usage', title: 'Go to Usage', keywords: ['tokens', 'cost', 'spend', 'limits', 'analytics'] }
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

  // The side panel is separate from the grid: 'g' toggles it, and a
  // "New Changes pane" row would only compete with that. The id and the chord
  // stay `panes.toggle-git` so the habit and the palette both keep working.
  commands.push({
    id: 'panes.toggle-git',
    title: 'Toggle side panel',
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

function buildTaskCommands(actions: PaletteActions, hasWorkspace: boolean): Command[] {
  const disabledReason = hasWorkspace ? undefined : 'Open a workspace to use its task backlog'
  const selection = actions.focusedSelection?.() ?? ''
  return [
    {
      id: 'tasks.new-from-selection',
      title: 'New task from terminal selection',
      group: 'Tasks',
      keywords: ['task', 'backlog', 'create', 'selection', 'terminal', 'clipboard'],
      enabled: hasWorkspace && selection.trim() !== '',
      disabledReason:
        disabledReason ?? (selection.trim() === '' ? 'Select text in a terminal first' : undefined),
      run: () => actions.newTaskFromSelection?.(selection)
    },
    {
      id: 'tasks.new',
      title: 'New task',
      group: 'Tasks',
      keywords: ['task', 'backlog', 'create', 'todo'],
      enabled: hasWorkspace,
      disabledReason,
      run: () => actions.openTasks(true)
    },
    {
      id: 'tasks.open',
      title: 'Open Tasks',
      group: 'Tasks',
      keywords: ['backlog', 'list', 'todo', 'task'],
      enabled: hasWorkspace,
      disabledReason,
      run: () => actions.openTasks()
    }
  ]
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
  const gridSteps = [
    { id: 'grid.prev', title: 'Previous grid', chord: gridPrev, offset: -1 },
    { id: 'grid.next', title: 'Next grid', chord: gridNext, offset: 1 }
  ] as const
  for (const g of gridSteps)
    commands.push({
      id: g.id,
      title: g.title,
      group: 'Grid',
      keywords: ['tab', 'switch', 'cycle'],
      chord: g.chord,
      enabled: actions.stepGrid !== undefined,
      disabledReason: actions.stepGrid === undefined ? 'Open a second grid to switch grids' : undefined,
      run: () => actions.stepGrid?.(g.offset)
    })
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
  const wsSteps = [
    { id: 'workspaces.prev', title: 'Previous workspace', chord: wsPrev, offset: -1 },
    { id: 'workspaces.next', title: 'Next workspace', chord: wsNext, offset: 1 }
  ] as const
  for (const w of wsSteps)
    commands.push({
      id: w.id,
      title: w.title,
      group: 'Workspaces',
      keywords: ['project', 'switch', 'cycle'],
      chord: w.chord,
      enabled: actions.stepWorkspace !== undefined,
      disabledReason:
        actions.stepWorkspace === undefined ? 'Add a workspace to switch workspaces' : undefined,
      run: () => actions.stepWorkspace?.(w.offset)
    })
  commands.push({
    id: 'workspaces.last',
    title: 'Last workspace',
    group: 'Workspaces',
    keywords: ['project', 'switch', 'back', 'previous'],
    chord: wsLast,
    enabled: actions.selectLastWorkspace !== undefined,
    disabledReason: actions.selectLastWorkspace === undefined ? 'No previous workspace yet' : undefined,
    run: () => actions.selectLastWorkspace?.()
  })
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
  sessions?: readonly SessionInfo[]
  activeSessionId?: number | null
}

export interface GridTarget {
  path: string
  workspaceName: string
  gridId: string
  name: string
}

export function buildCommands(input: BuildCommandsInput): Command[] {
  const { actions, hasWorkspace, workspaces, grids, sessions = [], activeSessionId } = input
  return [
    ...sessions.filter((session) => session.state === 'running' && !session.hidden).map((session) => ({
      id: `session.focus.${session.id}`,
      title: session.title || session.codename || `Pane ${session.id}`,
      group: 'Sessions' as const,
      keywords: [session.codename, session.cwd, session.project_dir, session.agent].filter((value): value is string => typeof value === 'string'),
      enabled: Boolean(actions.focusPane),
      session,
      subtitle: workspaces.find((workspace) => workspace.path === session.project_dir)?.name ?? session.project_dir,
      run: () => actions.focusPane?.(session.id)
    })),
    {
      id: 'pane.restart-focused',
      title: 'Restart pane',
      group: 'Recent',
      keywords: ['restart', 'pane', 'session'],
      enabled: activeSessionId !== null && activeSessionId !== undefined && Boolean(actions.restartPane) && Boolean(sessions.find((session) => session.id === activeSessionId)?.resumable),
      disabledReason: activeSessionId == null ? 'No pane is focused' : sessions.find((session) => session.id === activeSessionId)?.resumable ? undefined : 'This pane cannot be restarted',
      run: () => { if (activeSessionId != null) actions.restartPane?.(activeSessionId) }
    },
    ...buildOpenTabCommands(actions, grids ?? []),
    ...buildPaneCommands(actions, hasWorkspace),
    ...buildAgentCommands(actions, hasWorkspace),
    ...buildTaskCommands(actions, hasWorkspace),
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
