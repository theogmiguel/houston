import { describe, expect, it } from 'vitest'
import { buildCommands, type Command } from '../commandRegistry'
import { groupPaletteCommands, PALETTE_RECENTS_KEY, paletteShortcutLabels, readPaletteRecents, rememberPaletteCommand, sessionDotClass } from './paletteHelpers'

const command = (id: string, group: Command['group'] = 'View'): Command => ({ id, title: id, group, enabled: true, run: () => {} })

describe('command palette helpers', () => {
  it('groups sessions before persisted recent commands and keeps unavailable recent items', () => {
    const commands = [command('session.focus.1', 'Sessions'), command('view.toggle-sidebar'), command('pane.restart-focused', 'Recent')]
    expect(groupPaletteCommands(commands, ['view.toggle-sidebar'])).toEqual([
      { group: 'Sessions', items: [commands[0]] },
      { group: 'Recent', items: [commands[1], commands[2]] }
    ])
  })

  it('persists unique recent ids in recency order and bounds the list', () => {
    expect(rememberPaletteCommand(['a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(rememberPaletteCommand(Array.from({ length: 9 }, (_, i) => `${i}`), 'new')).toHaveLength(8)
    expect(readPaletteRecents({ getItem: () => '["x",1,"y"]' })).toEqual(['x', 'y'])
    expect(readPaletteRecents({ getItem: () => '{broken' })).toEqual([])
    expect(PALETTE_RECENTS_KEY).toBe('houston-command-palette-recents')
  })

  it('labels chords using the effective keymap overrides', () => {
    const commands = buildCommands({ actions: { newTerminal: () => {}, newGrid: () => {}, toggleGitPane: () => {}, spawnAgent: () => {}, openTasks: () => {}, toggleSidebarRail: () => {}, toggleChromeTheme: () => {}, openAddPanePopover: () => {}, setGridLayout: () => {}, openShortcutSheet: () => {}, selectNavRow: () => {}, switchWorkspace: () => {}, switchGrid: () => {} }, hasWorkspace: true, workspaces: [] })
    const labels = paletteShortcutLabels(commands, { shortcuts_enabled: true, bindings: { 'toggle-sidebar': { ctrl: true, alt: true, code: 'KeyJ', shift: false, meta: false } } })
    expect(labels['view.toggle-sidebar']).toBe('Ctrl+Alt+J')
  })

  it('colours a session dot like the pane header: working is info, needs input is warn', () => {
    expect(sessionDotClass('working')).toBe('bg-[var(--info)]')
    expect(sessionDotClass('spawning')).toBe('bg-[var(--accent)]')
    expect(sessionDotClass('needs-input')).toBe('bg-[var(--warn)]')
    expect(sessionDotClass('idle')).toBe('bg-[var(--text-muted)]')
  })
})
