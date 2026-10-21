// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, click, file, mount, q, teardown } from './ChangesPane.harness'

afterEach(teardown)

function reply(client: ReturnType<typeof mount>['client'], path: string, patch: string, truncated = false): void {
  act(() => client.emit({ type: 'git_diff', dir: '/repo', path, base: null, patch, truncated }))
}

function press(target: Element, init: KeyboardEventInit): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

function type(value: string): void {
  const input = q<HTMLInputElement>('[data-testid="diff-find-input"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const ctrlF = { key: 'f', code: 'KeyF', ctrlKey: true }

describe('find in the Changes diff', () => {
  it('searches the selected file diff and highlights matches', () => {
    const h = mount()
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-file"][data-path="src/app.ts"]'))
    reply(h.client, 'src/app.ts', '@@ -1,2 +1,2 @@\n-let total = 0\n+let total = 1\n return total')
    press(q('[data-testid="changes-pane"]')!, ctrlF)
    type('total')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('1/3')
    expect(document.querySelectorAll('[data-diff-find-mark]')).toHaveLength(3)
  })

  it('searches every expanded inline diff in the compact list', () => {
    const h = mount({ compact: true })
    h.status([file({ path: 'a.ts' }), file({ path: 'b.ts' })])
    expect(q('[data-testid="changes-inline-diff"][data-path="a.ts"]')).not.toBeNull()
    click(q('[data-testid="changes-file"][data-path="b.ts"]'))
    reply(h.client, 'a.ts', '@@ -1 +1 @@\n+alpha token')
    reply(h.client, 'b.ts', '@@ -1 +1 @@\n+beta token', true)
    press(q('[data-testid="changes-pane"]')!, ctrlF)
    type('token')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('1/2 · partial')
    expect(q('[data-testid="changes-inline-diff"][data-path="a.ts"] [data-diff-find-active]')?.textContent).toBe('token')
    press(q('[data-testid="diff-find-input"]')!, { key: 'Enter' })
    expect(q('[data-testid="changes-inline-diff"][data-path="b.ts"] [data-diff-find-active]')?.textContent).toBe('token')
  })
})
