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
})
