import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./inspector.css', import.meta.url), 'utf8')
function declarations(selector: string): string {
  const start = css.indexOf(selector + '{')
  return start < 0 ? '' : css.slice(start + selector.length + 1, css.indexOf('}', start))
}

describe('commit box geometry', () => {
  it('uses a 12px outer curve and 5px buttons at a 7px inset, preserving split seams', () => {
    expect(declarations('.changes-pane[data-compact="true"] .changes-commit')).toContain('border-radius:var(--tr-radius-card)')
    expect(declarations('.changes-pane[data-compact="true"] [data-testid="changes-actions"] .btn')).toContain('border-radius:var(--tr-radius-surface-small)')
    expect(declarations('.changes-pane[data-compact="true"] [data-testid="changes-actions"]')).toContain('padding:var(--space-1-5)')
    expect(declarations('.changes-pane[data-compact="true"] [data-testid="changes-commit"]')).toContain('border-top-right-radius:0')
    expect(declarations('.changes-pane[data-compact="true"] [data-testid="changes-commit-options"]')).toContain('border-top-left-radius:0')
  })
})
