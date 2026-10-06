import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BTN_GHOST, BTN_GHOST_DANGER_ARM, BTN_GHOST_DANGER_HOVER } from './buttonChrome'

const SRC = join(__dirname, '..', '..')
const buttonCss = readFileSync(join(__dirname, 'button.css'), 'utf8')
const tailwindCss = readFileSync(join(SRC, 'tailwind.css'), 'utf8')

function layerBlock(css: string, layer: string): string {
  const start = css.indexOf(`@layer ${layer} {`)
  if (start < 0) throw new Error(`button.css has no "@layer ${layer} {" block; expected the ghost recipe in "components"`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  throw new Error(`Unbalanced braces in the "@layer ${layer}" block of button.css`)
}

function rule(css: string, selector: string): string {
  const m = css.match(new RegExp(`${selector.replace(/[.:()]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  if (!m) throw new Error(`No "${selector}" rule found; expected it in the components layer of button.css`)
  return m[1]
}

describe('BTN_GHOST hover state', () => {
  const components = layerBlock(buttonCss, 'components')

  it('hovering a ghost button fills with --hover-fill and lifts the label to --text-primary', () => {
    const hover = rule(components, `.${BTN_GHOST}:hover:not(:disabled)`)
    expect(hover).toMatch(/background:\s*var\(--hover-fill\)/)
    expect(hover).toMatch(/color:\s*var\(--text-primary\)/)
  })

  it('rests transparent, borderless and muted', () => {
    const rest = rule(components, `.${BTN_GHOST}`)
    expect(rest).toMatch(/background:\s*transparent/)
    expect(rest).toMatch(/border:\s*none/)
    expect(rest).toMatch(/color:\s*var\(--text-muted\)/)
  })

  it('carries no utility classes, which would outrank the hover rule in the utilities layer', () => {
    expect(BTN_GHOST).toBe('btn-ghost')
  })
})

describe('ghost-danger hover wins over the ghost hover by layer, not class order', () => {
  it('the components layer is declared below utilities', () => {
    const order = tailwindCss.match(/@layer\s+([\w\s,-]+);/)?.[1].split(',').map((s) => s.trim())
    if (!order) throw new Error('tailwind.css has no "@layer a, b, …;" order statement')
    expect(order.indexOf('components')).toBeGreaterThan(order.indexOf('base'))
    expect(order.indexOf('components')).toBeLessThan(order.indexOf('utilities'))
  })

  it('the ghost recipe is defined in components, not utilities', () => {
    expect(buttonCss).not.toMatch(/@layer utilities/)
    expect(layerBlock(buttonCss, 'components')).toContain(`.${BTN_GHOST}`)
  })

  it('the danger hover and the armed fill are utilities, so they outrank the ghost recipe', () => {
    expect(BTN_GHOST_DANGER_HOVER).toMatch(/\bhover:bg-\[color-mix\(in_srgb,var\(--danger\)/)
    expect(BTN_GHOST_DANGER_HOVER).toMatch(/\bhover:text-\[var\(--danger\)\]/)
    expect(BTN_GHOST_DANGER_ARM).toMatch(/\bbg-\[color-mix\(in_srgb,var\(--danger\)/)
    expect(BTN_GHOST_DANGER_ARM).toMatch(/\btext-\[var\(--danger\)\]/)
  })
})
