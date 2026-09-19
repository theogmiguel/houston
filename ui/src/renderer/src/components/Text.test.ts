import { describe, expect, it } from 'vitest'
import { TEXT_ROLE_CLS, type TextRole } from './Text'

const ROLES: TextRole[] = [
  'display',
  'title',
  'heading',
  'subhead',
  'body',
  'ui',
  'small',
  'label'
]

describe('Text — the eight rungs', () => {
  it('every rung carries its own size and weight token, and nothing hand-typed', () => {
    for (const role of ROLES) {
      const cls = TEXT_ROLE_CLS[role]
      expect(cls, role).toContain(`[font-size:var(--tr-text-${role}-size)]`)
      expect(cls, role).toContain(`[font-weight:var(--tr-text-${role}-weight)]`)
      expect(cls, role).not.toMatch(/\[[a-z-]+:\d/)
    }
  })

  it('display is the one rung that names a family; label is the one that transforms', () => {
    expect(TEXT_ROLE_CLS.display).toContain('[font-family:var(--tr-text-display-family)]')
    expect(TEXT_ROLE_CLS.label).toContain('[text-transform:var(--tr-text-label-transform)]')
    for (const role of ROLES) {
      if (role !== 'display') expect(TEXT_ROLE_CLS[role], role).not.toContain('font-family')
      if (role !== 'label') expect(TEXT_ROLE_CLS[role], role).not.toContain('text-transform')
    }
  })

  it('the table is frozen, so a consumer cannot redefine a rung at runtime', () => {
    expect(Object.isFrozen(TEXT_ROLE_CLS)).toBe(true)
  })
})
