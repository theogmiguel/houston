// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { file, mount, q, teardown } from '../ChangesPane.harness'
import { changeRowClass } from './inspectorChangeClasses'
import { ROW_STATE } from './rowState'

const css = readFileSync('src/renderer/src/components/ui/inspector.css', 'utf8')
function declarations(selector: string): string {
  const start = css.indexOf(selector + '{')
  return start < 0 ? '' : css.slice(start + selector.length + 1, css.indexOf('}', start))
}
afterEach(teardown)

describe('Changes presentation', () => {
  it('keeps status letters visible instead of replacing them with a colour dot', () => {
    const mark = declarations('.changes-pane[data-compact="true"] .changes-inline-file .changes-inline-status')
    expect(mark).not.toContain('font-size:0')
    expect(css).not.toContain('.changes-inline-status::after')
  })

  it('uses the shared selected-hover state and rounded file rows', () => {
    expect(changeRowClass(true)).toContain(ROW_STATE.selected)
    const row = declarations('.changes-pane[data-compact="true"] .changes-inline-file .changes-file-row')
    expect(row).toContain('border-radius:var(--tr-radius-sm)')
    expect(row).not.toContain('background:')
    expect(css).not.toContain('.changes-file-row::before')
  })

  it('lets the maximized diff fill its column without the compact height cap', () => {
    const h = mount({ compact: true, maximized: true })
    h.status([file()])
    expect(q('[data-testid="changes-pane"]')?.getAttribute('data-maximized')).toBe('true')
    expect(css).not.toContain('max-height:60%')
    expect(css).not.toContain('.changes-diff [data-kind]{display:grid')
  })
})
