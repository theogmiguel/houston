import { describe, expect, it } from 'vitest'
import {
  NAVIGABLE_SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsGroupId
} from './settingsSections'

describe('settingsSections — state matrix', () => {
  it('Empty — N/A: this is a module-level literal array, always fully populated at import time; there is no "not loaded yet" for a data module.', () => {
    expect(true).toBe(true)
  })

  it('Filled — fifteen sections, all navigable, across three labelled groups plus the quiet tail', () => {
    expect(SETTINGS_SECTIONS.length).toBe(15)
    expect(NAVIGABLE_SETTINGS_SECTIONS.length).toBe(15)
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('usage')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('accounts')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('agent-setup')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('headless-roles')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('autopilot')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('bots')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('agent-defaults')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('sessions')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('mcp')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('skills')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('routines')
    expect(SETTINGS_SECTIONS.map((s) => s.id)).not.toContain('hooks')
    expect(SETTINGS_GROUPS.length).toBe(4)
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(['look', 'agents', 'data', 'reference'])
  })

  it('a renamed label never renames its persisted id — two ids outlive their old labels', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s.label]))
    expect(byId.get('workspace-defaults')).toBe('Workspaces')
    expect(byId.get('voice')).toBe('Dictation')
  })

  it('exactly one group is quiet, and it holds only the two read-only pages', () => {
    const quiet = SETTINGS_GROUPS.filter((g) => g.quiet)
    expect(quiet.map((g) => g.id)).toEqual(['reference'])
    expect(SETTINGS_SECTIONS.filter((s) => s.group === 'reference').map((s) => s.id)).toEqual([
      'diagnostics',
      'about'
    ])
  })

  it('the sections sit in the decided order inside each group', () => {
    const inGroup = (g: string): string[] =>
      SETTINGS_SECTIONS.filter((s) => s.group === g).map((s) => s.id)
    expect(inGroup('look')).toEqual(['appearance', 'terminal', 'shortcuts', 'notifications'])
    expect(inGroup('agents')).toEqual([
      'accounts',
      'agent-setup',
      'workspace-defaults',
      'orchestration',
      'headless-roles',
      'voice'
    ])
    expect(inGroup('data')).toEqual(['privacy', 'usage', 'daemon'])
  })

  it('Workspaces and Diagnostics are genuinely reachable — no `pending` flag left standing, and both resolve through NAVIGABLE_SETTINGS_SECTIONS the same way every other section does', () => {
    const pending = SETTINGS_SECTIONS.filter((s) => s.pending).map((s) => s.id)
    expect(pending).toEqual([])
    for (const id of ['workspace-defaults', 'diagnostics'] as const) {
      const nav = NAVIGABLE_SETTINGS_SECTIONS.find((s) => s.id === id)
      expect(nav).toBeDefined()
      expect(nav?.pending).toBeUndefined()
    }
    expect(NAVIGABLE_SETTINGS_SECTIONS.length).toBe(SETTINGS_SECTIONS.length)
  })

  it('every section sits in a declared group — an orphan would render nowhere', () => {
    const groups = new Set(SETTINGS_GROUPS.map((g) => g.id))
    for (const s of SETTINGS_SECTIONS) expect(groups.has(s.group)).toBe(true)
  })

  it('Hover — N/A: this module renders nothing; hover is a rendered-element concern for whatever step 09 mounts from this data.', () => {
    expect(true).toBe(true)
  })

  it('Focus — N/A: same reasoning as Hover.', () => {
    expect(true).toBe(true)
  })

  it('Active — N/A: same reasoning as Hover.', () => {
    expect(true).toBe(true)
  })

  it("Selected — N/A: \"which section is currently open\" is UI state owned by whatever consumes this list (step 09's rail), not by the data module itself.", () => {
    expect(true).toBe(true)
  })

  it('Disabled (+reason) — N/A: every section is always reachable; none is conditionally unavailable the way, say, a needsWorkspace pane type can be.', () => {
    expect(true).toBe(true)
  })

  it('Loading — N/A: same reasoning as Empty — nothing here is fetched.', () => {
    expect(true).toBe(true)
  })

  it('Error (+retry) — N/A: same reasoning as Loading.', () => {
    expect(true).toBe(true)
  })

  it('Overflow — N/A: fifteen entries in four groups is a fixed, small, known-at-compile-time size; there is no scroll/truncation concern in the data itself.', () => {
    expect(true).toBe(true)
  })

  it('Empty set — N/A: the section/group shape is a fixed decision, not a fetched collection that could come back empty.', () => {
    expect(true).toBe(true)
  })

  it('every section belongs to a group that actually exists', () => {
    const groupIds = new Set<SettingsGroupId>(SETTINGS_GROUPS.map((g) => g.id))
    for (const section of SETTINGS_SECTIONS) {
      expect(groupIds.has(section.group)).toBe(true)
    }
  })

  it('every section id and every icon key is unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    const icons = SETTINGS_SECTIONS.map((s) => s.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('Orchestration keeps its own mark, not the fan-out glyph headless roles now uses', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s.icon]))
    expect(byId.get('headless-roles')).toBe('sparkles')
    expect(byId.get('orchestration')).toBe('fork')
  })

  it('every section carries at least one search keyword', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.keywords.length).toBeGreaterThan(0)
    }
  })

  it('the three labelled groups appear in question order, with the quiet tail last', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      'Look & feel',
      'Agents',
      'Your data',
      'Reference'
    ])
  })
})
