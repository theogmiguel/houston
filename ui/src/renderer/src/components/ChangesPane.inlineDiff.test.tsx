// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, click, file, mount, q, teardown } from './ChangesPane.harness'

afterEach(teardown)

const inline = (path: string): Element | null => q(`[data-testid="changes-inline-diff"][data-path="${path}"]`)

function reply(client: ReturnType<typeof mount>['client'], path: string, base: string | null, patch: string, dir = '/repo'): void {
  act(() => client.emit({ type: 'git_diff', dir, path, base, patch, truncated: false }))
}

describe('compact inline comparison diffs', () => {
  it('invalidates working patches and refreshes every expanded file when switching base', () => {
    const h = mount({ compact: true })
    const files = [file({ path: 'a.ts' }), file({ path: 'b.ts' })]
    h.status(files, { default_base: 'origin/main' })
    click(q('[data-testid="changes-file"][data-path="b.ts"]'))
    reply(h.client, 'a.ts', null, '')
    reply(h.client, 'b.ts', null, '@@ -1 +1 @@\n+working')
    const before = h.client.gitDiffCalls.length
    click(q('[data-testid="changes-scope-branch"]'))
    h.status(files, { base: 'origin/main', default_base: 'origin/main' })
    expect(inline('a.ts')?.textContent).toContain('Loading diff…')
    expect(inline('b.ts')?.textContent).not.toContain('working')
    expect(h.client.gitDiffCalls.slice(before)).toEqual(expect.arrayContaining(files.map(({ path }) => ({ dir: '/repo', path, base: 'origin/main' }))))
    reply(h.client, 'b.ts', 'origin/main', '@@ -1 +1 @@\n+branch B')
    reply(h.client, 'a.ts', 'origin/main', '@@ -1 +1 @@\n+branch A')
    reply(h.client, 'a.ts', null, '')
    reply(h.client, 'b.ts', 'origin/main', '', '/other')
    expect(inline('a.ts')?.textContent).toContain('branch A')
    expect(inline('b.ts')?.textContent).toContain('branch B')
    click(q('[data-testid="changes-scope-working"]'))
    h.status(files, { default_base: 'origin/main' })
    reply(h.client, 'a.ts', 'origin/main', '@@ -1 +1 @@\n+stale branch')
    expect(inline('a.ts')?.textContent).toContain('Loading diff…')
  })

  it.each([false, true])('shows empty textual diff copy with detached tree = %s', (detached) => {
    const h = mount({ compact: true })
    h.status([file({ path: 'image.png' })])
    reply(h.client, 'image.png', null, '')
    if (detached) {
      click(q('[aria-label="View"]'))
      click(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === 'File tree')!)
    }
    expect(h.container.textContent).toContain('No textual diff for this file.')
  })
})
