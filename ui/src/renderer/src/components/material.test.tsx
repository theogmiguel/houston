// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MATERIAL_CLS, MATERIALS, materialAttrs, type Material } from './material'

describe('the material ladder', () => {
  it('is an axis, in order, with every rung reachable by name', () => {
    expect([...MATERIALS]).toEqual([
      'base',
      'shell',
      'inset',
      'raised',
      'raised-glass',
      'overlay',
      'overlay-glass'
    ])
    for (const m of MATERIALS) expect(MATERIAL_CLS[m]).toBeTruthy()
  })

  it('adds tint rungs, never blur rungs', () => {
    const withFilm = MATERIALS.filter((m) => MATERIAL_CLS[m].includes('[backdrop-filter:'))
    expect(withFilm).toEqual(['raised-glass', 'overlay-glass'])
    for (const m of withFilm) {
      expect(MATERIAL_CLS[m].match(/\[backdrop-filter:/g)).toHaveLength(1)
      expect(MATERIAL_CLS[m].match(/\[-webkit-backdrop-filter:/g)).toHaveLength(1)
    }
  })

  it('every rung has a Solid form, so a forced-Solid desktop keeps the whole ladder', () => {
    for (const m of MATERIALS) {
      if (!m.endsWith('-glass')) continue
      expect(MATERIALS).toContain(m.slice(0, -'-glass'.length) as Material)
    }
  })

  it('spells no colour of its own — a rung is tokens, never a hex', () => {
    for (const m of MATERIALS) {
      expect(MATERIAL_CLS[m]).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(MATERIAL_CLS[m]).not.toMatch(/rgba?\(/)
    }
  })

  it('reads its own rung\'s tokens, and a glass form borrows only the step it shares', () => {
    for (const m of MATERIALS) {
      const own = new RegExp(`^--material-${m}-`)
      const shared = m.endsWith('-glass')
        ? new RegExp(`^--material-${m.slice(0, -'-glass'.length)}-shadow$`)
        : null
      for (const token of MATERIAL_CLS[m].matchAll(/var\((--material-[a-z-]+)\)/g)) {
        expect(own.test(token[1]) || (shared?.test(token[1]) ?? false)).toBe(true)
      }
    }
  })

  it('is frozen at module scope — a render is a lookup, never a string build', () => {
    expect(Object.isFrozen(MATERIAL_CLS)).toBe(true)
    expect(MATERIAL_CLS.raised).toBe(MATERIAL_CLS.raised)
  })

  it('hands out the marker theme.css scopes the ink on', () => {
    expect(materialAttrs('overlay-glass')).toEqual({ 'data-material': 'overlay-glass' })
  })
})
