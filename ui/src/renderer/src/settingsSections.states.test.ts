import { describe, expect, it } from 'vitest'
import { NAVIGABLE_SETTINGS_SECTIONS, SETTINGS_SECTIONS } from './settingsSections'

describe('settingsSections', () => {
  it('provides the approved flat navigation order with Notifications built', () => {
    expect(SETTINGS_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
      ['appearance', 'Appearance'], ['terminal', 'Terminal'], ['shortcuts', 'Shortcuts'],
      ['agents', 'Agents'], ['notifications', 'Notifications'], ['workspaces', 'Workspaces'],
      ['orchestration', 'Orchestration'], ['tasks', 'Tasks'], ['dictation', 'Dictation'],
      ['privacy', 'Privacy & data'], ['daemon', 'Daemon'], ['about', 'About']
    ])
    expect(SETTINGS_SECTIONS.find(({ id }) => id === 'notifications')?.pending).toBeUndefined()
    expect(NAVIGABLE_SETTINGS_SECTIONS).toHaveLength(12)
  })

  it('keeps every section searchable', () => {
    for (const section of SETTINGS_SECTIONS) expect(section.keywords.length).toBeGreaterThan(0)
  })
})
