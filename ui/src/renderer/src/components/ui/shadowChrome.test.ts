import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as shadowChrome from './shadowChrome'
import { FOCUS_HALO_CLS } from './shadowChrome'
import { SEG_ITEM_CLS } from './segmentedChrome'

describe('focus halo', () => {
  it('ships a complete literal utility that Tailwind can discover', () => {
    const literal = 'focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--focus-ring)]'
    expect(FOCUS_HALO_CLS).toBe(literal)
    expect(readFileSync(new URL('./shadowChrome.ts', import.meta.url), 'utf8')).toContain(`'${literal}'`)
    expect(SEG_ITEM_CLS.split(' ')).toContain(literal)
  })

  it('spells every shared focus class as one literal utility, never an interpolation', () => {
    const source = readFileSync(new URL('./shadowChrome.ts', import.meta.url), 'utf8')
    const focusClasses = Object.entries(shadowChrome).filter(([name]) => /^FOCUS_\w+_CLS$/.test(name))
    expect(focusClasses.map(([name]) => name)).toEqual(expect.arrayContaining(['FOCUS_RING_ACCENT_ICON_CLS', 'FOCUS_RING_ACCENT_INSET_45_CLS', 'FOCUS_HAIRLINE_INSET_CLS']))
    for (const [name, value] of focusClasses) {
      expect(value, name).toMatch(/^focus-(visible|within):shadow-\[[^\]$]+\]$/)
      expect(source, name).toContain(`'${value}'`)
    }
  })
})
