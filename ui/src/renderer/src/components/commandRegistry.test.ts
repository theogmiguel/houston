// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  APPEARANCE_PICKER_COMMAND_ID,
  buildCommands,
  filterCommands,
  type PaletteActions
} from './commandRegistry'
import type { Workspace } from '../houston/generated/Workspace'
import { SETTINGS_SECTIONS } from '../settingsSections'
import { isSettingsOpen, setSettingsNavForTests } from '../settingsNav'
import { consumeSettingsRowJump } from '../settingsRowJump'

function makeActions(overrides: Partial<PaletteActions> = {}): PaletteActions {
  return {
    newTerminal: vi.fn(),
    insertPane: vi.fn(),
    splitPane: vi.fn(),
    newGrid: vi.fn(),
    closePane: vi.fn(),
    toggleGitPane: vi.fn(),
    spawnAgent: vi.fn(),
    toggleSidebarRail: vi.fn(),
    toggleChromeTheme: vi.fn(),
    openAddPanePopover: vi.fn(),
    setGridLayout: vi.fn(),
    openNotifications: vi.fn(),
    markAllNotificationsRead: vi.fn(),
    openShortcutSheet: vi.fn(),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    quitAndStopDaemon: vi.fn(),
    selectNavRow: vi.fn(),
    switchWorkspace: vi.fn(),
    switchGrid: vi.fn(),
    ...overrides
  }
}

const WORKSPACES: Workspace[] = [
  { path: '/home/dev/proj-a', name: 'proj-a' },
  { path: '/home/dev/proj-b', name: 'proj-b' }
]

describe('commandRegistry — buildCommands', () => {
  it('produces a non-empty registry with globally unique ids', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    expect(commands.length).toBeGreaterThan(20)
    const ids = commands.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every command is callable — run() never throws for a fully-stubbed action set', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    for (const c of commands) {
      expect(() => c.run()).not.toThrow()
    }
  })

  it('a disabled command always carries a disabledReason (placement rule 6)', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    for (const c of commands) {
      if (!c.enabled) expect(c.disabledReason).toBeTruthy()
    }
  })

  it('pane kinds that are not insertable (editor, skills) render disabled with a named reason, never hidden', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    const editor = commands.find((c) => c.id === 'panes.new-editor')
    const skills = commands.find((c) => c.id === 'panes.new-skills')
    expect(editor?.enabled).toBe(false)
    expect(editor?.disabledReason).toMatch(/no blank state/i)
    expect(skills?.enabled).toBe(false)
    expect(skills?.disabledReason).toMatch(/settings/i)
    expect(commands.find((c) => c.id === 'panes.new-review')).toBeUndefined()
  })

  it('the source control panel toggles, and the row keeps its old id and name', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    expect(commands.find((c) => c.id === 'panes.new-git')).toBeUndefined()
    const git = commands.find((c) => c.id === 'panes.toggle-git')
    expect(git?.enabled).toBe(true)
    expect(git?.title).toContain('source control')
    expect(git?.keywords).toContain('git')
    expect(git?.keywords).toContain('review')
  })

  it('without a workspace, workspace-gated commands are disabled but the panel toggle is not', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: false, workspaces: [] })
    const browser = commands.find((c) => c.id === 'panes.new-browser')
    const git = commands.find((c) => c.id === 'panes.toggle-git')
    const claude = commands.find((c) => c.id === 'agents.spawn.claude')
    expect(browser?.enabled).toBe(false)
    expect(browser?.disabledReason).toMatch(/workspace/i)
    // The panel opens in All view too, scoped to the focused pane's repo.
    expect(git?.enabled).toBe(true)
    expect(claude?.enabled).toBe(false)
    expect(claude?.disabledReason).toMatch(/workspace/i)
  })

  it('with a workspace, the same commands are enabled', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })
    expect(commands.find((c) => c.id === 'panes.new-browser')?.enabled).toBe(true)
    expect(commands.find((c) => c.id === 'panes.toggle-git')?.enabled).toBe(true)
    expect(commands.find((c) => c.id === 'agents.spawn.claude')?.enabled).toBe(true)
  })

  it('New browser pane calls insertPane, never toggleGitPane, and vice versa for the git row', () => {
    const insertPane = vi.fn()
    const toggleGitPane = vi.fn()
    const commands = buildCommands({
      actions: makeActions({ insertPane, toggleGitPane }),
      hasWorkspace: true,
      workspaces: []
    })
    commands.find((c) => c.id === 'panes.new-browser')?.run()
    expect(insertPane).toHaveBeenCalledWith('browser')
    expect(toggleGitPane).not.toHaveBeenCalled()
    insertPane.mockClear()
    commands.find((c) => c.id === 'panes.toggle-git')?.run()
    expect(toggleGitPane).toHaveBeenCalledOnce()
    expect(insertPane).not.toHaveBeenCalled()
  })

  it('splitPane/closePane are disabled with a named reason when the mount has no focused pane to act on', () => {
    const commands = buildCommands({
      actions: makeActions({ splitPane: undefined, closePane: undefined }),
      hasWorkspace: true,
      workspaces: []
    })
    const split = commands.find((c) => c.id === 'panes.split')
    const close = commands.find((c) => c.id === 'panes.close')
    expect(split?.enabled).toBe(false)
    expect(split?.disabledReason).toMatch(/no focused pane/i)
    expect(close?.enabled).toBe(false)
    expect(close?.disabledReason).toMatch(/no focused pane/i)
  })

  it('window control commands are omitted entirely when the mount supplies none — hidden, not disabled, since a host with no window chrome has nothing to name', () => {
    const commands = buildCommands({
      actions: makeActions({
        windowMinimize: undefined,
        windowMaximize: undefined,
        windowClose: undefined,
        quitAndStopDaemon: undefined
      }),
      hasWorkspace: true,
      workspaces: []
    })
    expect(commands.some((c) => c.group === 'Window')).toBe(false)
  })

  it('window control commands appear, enabled, when the mount supplies them', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    const windowCommands = commands.filter((c) => c.group === 'Window')
    expect(windowCommands.length).toBe(4)
    expect(windowCommands.every((c) => c.enabled)).toBe(true)
  })

  it('"Quit and stop daemon" sits beside "Close window" and dispatches through its own action, leaving windowClose untouched', () => {
    const windowClose = vi.fn()
    const quitAndStopDaemon = vi.fn()
    const commands = buildCommands({
      actions: makeActions({ windowClose, quitAndStopDaemon }),
      hasWorkspace: true,
      workspaces: []
    })
    const quit = commands.find((c) => c.id === 'window.quit-and-stop-daemon')!
    expect(quit.title).toBe('Quit and stop daemon')
    expect(quit.group).toBe('Window')
    quit.run()
    expect(quitAndStopDaemon).toHaveBeenCalledTimes(1)
    expect(windowClose).not.toHaveBeenCalled()

    const close = commands.find((c) => c.id === 'window.close')!
    close.run()
    expect(windowClose).toHaveBeenCalledTimes(1)
  })

  it('omits "Quit and stop daemon" alone when only that action is missing (e.g. a non-Tauri host)', () => {
    const commands = buildCommands({
      actions: makeActions({ quitAndStopDaemon: undefined }),
      hasWorkspace: true,
      workspaces: []
    })
    expect(commands.some((c) => c.id === 'window.quit-and-stop-daemon')).toBe(false)
    expect(commands.some((c) => c.id === 'window.close')).toBe(true)
  })

  it('one rail-nav command per NavRowId, all enabled, dispatching through selectNavRow', () => {
    const selectNavRow = vi.fn()
    const commands = buildCommands({ actions: makeActions({ selectNavRow }), hasWorkspace: true, workspaces: [] })
    const rows = commands.filter((c) => c.id.startsWith('go-to.nav.'))
    expect(rows.map((r) => r.id).sort()).toEqual(
      ['go-to.nav.routines', 'go-to.nav.skills', 'go-to.nav.mcp'].sort()
    )
    rows.find((r) => r.id === 'go-to.nav.mcp')?.run()
    expect(selectNavRow).toHaveBeenCalledWith('mcp')
  })

  it('any pending Settings section is offered but disabled, with a reason', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    for (const section of SETTINGS_SECTIONS.filter((x) => x.pending)) {
      const cmd = commands.find((c) => c.id === `go-to.settings.${section.id}`)
      expect(cmd, `no command for pending section ${section.id}`).toBeDefined()
      expect(cmd?.enabled).toBe(false)
      expect(cmd?.disabledReason).toMatch(/not built yet/i)
    }
  })

  it('a built Settings section (Appearance) is enabled', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    const appearance = commands.find((c) => c.id === 'go-to.settings.appearance')
    expect(appearance?.enabled).toBe(true)
  })

  it('D2: a "Section › Row" entry opens Settings on that section and stages a row jump', () => {
    setSettingsNavForTests({ open: false })
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    const cmd = commands.find((c) => c.id === 'go-to.settings-row.appearance.Palette')
    expect(cmd).toBeDefined()
    expect(cmd?.title).toBe('Appearance › Palette')
    cmd?.run()
    expect(isSettingsOpen()).toBe(true)
    expect(consumeSettingsRowJump('appearance')).toBe('Palette')
    expect(consumeSettingsRowJump('appearance')).toBeNull()
  })

  it('D2: "Toggle theme" sits in the Appearance group and dispatches toggleChromeTheme', () => {
    const toggleChromeTheme = vi.fn()
    const commands = buildCommands({
      actions: makeActions({ toggleChromeTheme }),
      hasWorkspace: true,
      workspaces: []
    })
    const cmd = commands.find((c) => c.id === 'appearance.toggle-theme')
    expect(cmd?.group).toBe('Appearance')
    cmd?.run()
    expect(toggleChromeTheme).toHaveBeenCalledTimes(1)
  })

  it('grid layout produces exactly the four column counts, each dispatching setGridLayout', () => {
    const setGridLayout = vi.fn()
    const commands = buildCommands({ actions: makeActions({ setGridLayout }), hasWorkspace: true, workspaces: [] })
    const gridCommands = commands.filter((c) => c.group === 'Grid')
    expect(gridCommands.map((c) => c.id)).toEqual([
      'grid.tidy',
      'grid.equalize',
      'grid.layout.1',
      'grid.layout.2',
      'grid.layout.3',
      'grid.layout.4'
    ])
    gridCommands.find((c) => c.id === 'grid.layout.3')?.run()
    expect(setGridLayout).toHaveBeenCalledWith(3)
  })

  it('Tidy and Equalize name the reason they are dead when the grid holds one pane', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    for (const id of ['grid.tidy', 'grid.equalize']) {
      const cmd = commands.find((c) => c.id === id)
      expect(cmd?.enabled).toBe(false)
      expect(cmd?.disabledReason).toMatch(/second pane/i)
    }
  })

  it('Tidy and Equalize dispatch their actions when the grid has panes to balance', () => {
    const tidyPanes = vi.fn()
    const equalizePanes = vi.fn()
    const commands = buildCommands({
      actions: makeActions({ tidyPanes, equalizePanes }),
      hasWorkspace: true,
      workspaces: []
    })
    commands.find((c) => c.id === 'grid.tidy')?.run()
    commands.find((c) => c.id === 'grid.equalize')?.run()
    expect(tidyPanes).toHaveBeenCalled()
    expect(equalizePanes).toHaveBeenCalled()
  })

  it('one workspace-switch command per supplied workspace, plus the all-workspaces entry', () => {
    const switchWorkspace = vi.fn()
    const commands = buildCommands({
      actions: makeActions({ switchWorkspace }),
      hasWorkspace: true,
      workspaces: WORKSPACES
    })
    const wsCommands = commands.filter((c) => c.group === 'Workspaces')
    expect(wsCommands.length).toBe(WORKSPACES.length + 1)
    wsCommands.find((c) => c.title === 'proj-b')?.run()
    expect(switchWorkspace).toHaveBeenCalledWith('/home/dev/proj-b')
    wsCommands.find((c) => c.id === 'workspaces.all')?.run()
    expect(switchWorkspace).toHaveBeenCalledWith('all')
  })

  it('the Appearance-picker embed command exists and is enabled', () => {
    const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: [] })
    const embed = commands.find((c) => c.id === APPEARANCE_PICKER_COMMAND_ID)
    expect(embed).toBeDefined()
    expect(embed?.enabled).toBe(true)
  })

  it('six known agent CLIs get a spawn command, each dispatching its own kind', () => {
    const spawnAgent = vi.fn()
    const commands = buildCommands({ actions: makeActions({ spawnAgent }), hasWorkspace: true, workspaces: [] })
    const agentCommands = commands.filter((c) => c.group === 'Agents')
    expect(agentCommands.length).toBe(6)
    agentCommands.find((c) => c.id === 'agents.spawn.codex')?.run()
    expect(spawnAgent).toHaveBeenCalledWith('codex')
  })
})

describe('commandRegistry — filterCommands (fuzzy ranking)', () => {
  const commands = buildCommands({ actions: makeActions(), hasWorkspace: true, workspaces: WORKSPACES })

  it('an empty query returns every command, unfiltered, in registry order', () => {
    expect(filterCommands(commands, '')).toEqual(commands)
    expect(filterCommands(commands, '   ')).toEqual(commands)
  })

  it('every registry entry is reachable by typing its own title in full', () => {
    for (const c of commands) {
      const results = filterCommands(commands, c.title)
      expect(results.some((r) => r.id === c.id)).toBe(true)
    }
  })

  it('typing a command’s exact title ranks it first among the results', () => {
    const target = commands.find((c) => c.id === 'view.shortcuts')
    expect(target).toBeDefined()
    const results = filterCommands(commands, target!.title)
    expect(results[0]?.id).toBe('view.shortcuts')
  })

  it('a subsequence (non-contiguous) query still matches — "cmdp" style typing', () => {
    const results = filterCommands(commands, 'ncs')
    expect(results.some((r) => r.id === 'agents.spawn.codex')).toBe(true)
  })

  it('a query with no possible match returns an empty list', () => {
    expect(filterCommands(commands, 'zzzzznosuchcommandzzzzz')).toEqual([])
  })

  it('matches by keyword when the title itself does not contain the query', () => {
    const results = filterCommands(commands, 'colors')
    expect(results.some((r) => r.id === APPEARANCE_PICKER_COMMAND_ID)).toBe(true)
  })

  it('a title match ranks above a keyword-only match for a query both satisfy', () => {
    const results = filterCommands(commands, 'settings')
    const titleHit = results.findIndex((c) => c.id === 'go-to.settings')
    const keywordOnlyHit = results.findIndex((c) => c.id.startsWith('go-to.nav.'))
    expect(titleHit).toBeGreaterThanOrEqual(0)
    if (keywordOnlyHit >= 0) expect(titleHit).toBeLessThan(keywordOnlyHit)
  })
})
