import { describe, expect, it } from 'vitest'
import { NAVIGABLE_SETTINGS_SECTIONS, SETTINGS_SECTIONS, settingsSectionsFor } from './settingsSections'

describe('settingsSections', () => {
  it('provides the approved flat navigation order with Notifications built', () => {
    expect(settingsSectionsFor('Linux x86_64').map(({ id, label }) => [id, label])).toEqual([
      ['appearance', 'Appearance'], ['mascot', 'Mascot'], ['terminal', 'Terminal'], ['shortcuts', 'Shortcuts'],
      ['agents', 'Agents'], ['notifications', 'Notifications'], ['workspaces', 'Workspaces'],
      ['orchestration', 'Orchestration'], ['tasks', 'Tasks'], ['dictation', 'Dictation'],
      ['privacy', 'Privacy & data'], ['daemon', 'Daemon'], ['about', 'About']
    ])
    expect(SETTINGS_SECTIONS.find(({ id }) => id === 'notifications')?.pending).toBeUndefined()
    expect(NAVIGABLE_SETTINGS_SECTIONS).toBe(SETTINGS_SECTIONS)
  })

  it('lists wsl only on windows', () => {
    const windows = settingsSectionsFor('Win32').map(({ id }) => id)
    expect(windows).toContain('wsl')
    expect(windows.indexOf('wsl')).toBe(windows.indexOf('daemon') + 1)
    expect(settingsSectionsFor('Linux x86_64').map(({ id }) => id)).not.toContain('wsl')
    expect(settingsSectionsFor('MacIntel').map(({ id }) => id)).not.toContain('wsl')
  })

  it('keeps every section searchable', () => {
    for (const section of settingsSectionsFor('Win32')) expect(section.keywords.length).toBeGreaterThan(0)
  })
})
