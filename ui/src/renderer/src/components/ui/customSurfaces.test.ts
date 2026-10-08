// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CSS = [resolve(__dirname, '..', '..', 'theme.css'), resolve(__dirname, 'inspector.css')]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

// jsdom matches selectors but does not resolve var(), so the winning declaration is read
// from the rules themselves: highest specificity, then source order.
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length
  const tags = (selector.replace(/[#.][\w-]+|\[[^\]]+\]|:+[\w-]+(\([^)]*\))?/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length
  return ids * 10000 + classes * 100 + tags
}

function declared(element: Element, property: string): string {
  let best: { rank: number; value: string } = { rank: -1, value: '' }
  const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]) as CSSStyleRule[]
  for (const rule of rules) {
    if (!rule.selectorText || !rule.style) continue
    const value = rule.style.getPropertyValue(property)
    if (!value) continue
    for (const selector of rule.selectorText.split(',').map((part) => part.trim())) {
      if (element.matches(selector) && specificity(selector) >= best.rank) best = { rank: specificity(selector), value }
    }
  }
  return best.value
}

function mount(custom: boolean): { row: HTMLElement; slot: HTMLElement; inspector: HTMLElement } {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  document.body.innerHTML = `<main class="grid-region with-side"${custom ? ' data-custom="on"' : ''}>
    <div class="side-panel-row"><div class="grid-slot contents"></div><aside class="pane-inspector"></aside></div>
  </main>`
  return {
    row: document.querySelector('.side-panel-row')!,
    slot: document.querySelector('.grid-slot')!,
    inspector: document.querySelector('.pane-inspector')!
  }
}

describe('the side panel over a custom background', () => {
  afterEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  it('keeps the grid behind the panes see-through, so the terminal keeps its scrim when the panel opens', () => {
    const { row, slot } = mount(true)
    for (const element of [row, slot]) {
      const background = declared(element, 'background')
      expect(background, `${element.className} paints ${background}`).not.toMatch(/--rail-bg|--content-bg/)
    }
  })

  it('docks the panel flush right in the same glass as the rail', () => {
    const { inspector } = mount(true)
    expect(declared(inspector, 'background')).toBe('var(--custom-chrome-scrim)')
    for (const property of ['margin', 'border', 'border-radius']) expect(declared(inspector, property)).toBe('')
  })

  it('clears the opaque grounds inside every content surface, so only the plate tints them', () => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    document.body.innerHTML = `<main class="grid-region" data-custom="on">
      <div data-material="base"><div class="card"></div></div>
      <div class="side-panel-row"><aside class="pane-inspector"><div class="body"></div></aside></div>
    </main>`
    for (const surface of [document.querySelector('[data-material="base"]')!, document.querySelector('.pane-inspector')!]) {
      for (const token of ['--content-bg', '--rail-bg', '--material-shell-bg']) {
        expect(declared(surface, token), `${surface.outerHTML.slice(0, 40)} ${token}`).toBe('transparent')
      }
      expect(declared(surface, '--card-bg')).toMatch(/transparent\)$/)
    }
  })

  it('separates the panel from the grid by its ground, not a divider line, on a solid background', () => {
    const { inspector } = mount(false)
    expect(declared(inspector, 'border-left')).toBe('')
    expect(declared(inspector, 'border')).toBe('')
  })
})
