// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { click, file, mount, q, teardown } from './ChangesPane.harness'

afterEach(teardown)

describe('Changes pane — housed ground', () => {
  it('keeps the pane root off terminal-only background tokens', () => {
    const h = mount()
    h.status([file()])
    const root = q('[data-testid="changes-pane"]')!

    expect(root.className).not.toContain('bg-[var(--pane-bg)]')
    expect(root.className).not.toContain('bg-[var(--tool-code-bg)]')
    expect(root.className).toContain('bg-[var(--material-shell-bg)]')
  })
})


describe('compact side panel changes', () => {
  it('keeps diff scope and Git operations available through the compact actions control', () => {
    const h = mount({ compact: true })
    h.status([file()])
    expect(q('[aria-label="Diff scope"]')).toBeNull()
    click(q('[aria-label="Git actions and diff scope"]'))
    expect(q('[aria-label="Diff scope"]')).not.toBeNull()
    click(q('[aria-label="Git actions and diff scope"]'))
    expect(q('[aria-label="Diff scope"]')).toBeNull()
  })
})
