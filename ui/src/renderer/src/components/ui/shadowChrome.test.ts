import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FOCUS_HALO_CLS } from './shadowChrome'
import { SEG_ITEM_CLS } from './segmentedChrome'

describe('focus halo', () => {
  it('ships a complete literal utility that Tailwind can discover', () => {
    const literal = 'focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_3px_var(--focus-ring)]'
    expect(FOCUS_HALO_CLS).toBe(literal)
    expect(readFileSync(new URL('./shadowChrome.ts', import.meta.url), 'utf8')).toContain(`'${literal}'`)
    expect(SEG_ITEM_CLS.split(' ')).toContain(literal)
  })
})
