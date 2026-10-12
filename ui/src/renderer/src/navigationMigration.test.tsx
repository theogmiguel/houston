// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_SETTINGS_SECTION, settingsSectionsFor } from './settingsSections'

afterEach(() => { cleanup(); localStorage.clear() })
describe('unified settings navigation', () => {
  it('groups agent setup first and folds retired section ids into live pages', () => {
    const sections = settingsSectionsFor('Linux')
    expect(sections.slice(0, 5).map((section) => section.id)).toEqual(['agents-overview', 'agents-clis', 'agents-skills', 'agents-mcp', 'agents-review'])
    expect(LEGACY_SETTINGS_SECTION).toMatchObject({ agents: 'agents-clis', accounts: 'agents-clis', 'agent-setup': 'agents-clis', mascot: 'appearance' })
    expect(sections.some((section) => section.id === ('mascot' as string))).toBe(false)
  })
  it('drops hidden configuration views while preserving work views', async () => {
    localStorage.setItem('tr-rail-views-hidden', JSON.stringify(['skills', 'harness', 'mcp', 'routines', 'usage', 'unknown']))
    vi.resetModules()
    const store = await import('./railView')
    const { result } = renderHook(() => store.useHiddenRailViews())
    expect(store.RAIL_VIEWS).toEqual(['tasks', 'prs', 'routines', 'usage'])
    expect([...result.current]).toEqual(['routines', 'usage'])
  })
  it.each(['agents', 'accounts', 'agent-setup', 'mascot'])('loads saved %s into its canonical settings page', async (id) => {
    localStorage.setItem('tr-settings-section', id)
    vi.resetModules()
    const store = await import('./settingsNav')
    const { result } = renderHook(() => store.useSettingsSection())
    expect(result.current).toBe(id === 'mascot' ? 'appearance' : 'agents-clis')
  })
})
