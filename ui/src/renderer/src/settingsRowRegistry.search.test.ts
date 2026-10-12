import { describe, expect, it } from 'vitest'
import { searchSettingsRows } from './settingsRowRegistry'

describe('settings row search', () => {
  it('ranks a direct row match ahead of section keyword matches', () => {
    const results = searchSettingsRows('font size')
    expect(results[0]).toEqual({
      section: expect.objectContaining({ id: 'terminal' }),
      title: 'Font size'
    })
  })

  it('routes companion keywords and mascot rows to Appearance', () => {
    for (const query of ['mascot', 'companion', 'buddy', 'hat', 'holidays', 'pixel', 'colors', 'floating', 'rail', 'sounds', 'nap', 'break']) {
      const results = searchSettingsRows(query)
      expect(results.length).toBeGreaterThan(0)
      expect(results.every(hit => hit.section.id === 'appearance')).toBe(true)
    }
    expect(searchSettingsRows('Position')[0]).toEqual({
      section: expect.objectContaining({ id: 'appearance' }),
      title: 'Position'
    })
  })

  it('finds ZCode under Agents', () => {
    expect(searchSettingsRows('zcode')).toContainEqual({
      section: expect.objectContaining({ id: 'agents-clis' }),
      title: 'ZCode'
    })
  })
})
