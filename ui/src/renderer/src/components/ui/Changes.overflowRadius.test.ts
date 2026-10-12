import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./inspector.css', import.meta.url), 'utf8')
function declarations(selector: string): string {
  const start = css.indexOf(selector + '{')
  return start < 0 ? '' : css.slice(start + selector.length + 1, css.indexOf('}', start))
}

describe('diff toolbar overflow geometry', () => {
  it('matches the 5px siblings and leaves the toolbar ground visible', () => {
    const floating = declarations('.changes-compact-tools>span>button')
    expect(floating).toContain('border-radius:var(--tr-radius-surface-small)')
    expect(floating).toContain('background:transparent')
    const toolbar = declarations('.changes-pane[data-compact="true"] .changes-diff-actions .changes-compact-tools>span>button')
    expect(toolbar).toContain('background:transparent')
    expect(declarations('.changes-tools-trigger')).toContain('border-radius:var(--tr-radius-surface-small)')
  })
})
