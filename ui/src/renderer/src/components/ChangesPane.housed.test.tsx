// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { file, mount, q, teardown } from './ChangesPane.harness'

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
