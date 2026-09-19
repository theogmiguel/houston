// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, click, file, mount, q, qa, state, teardown } from './ChangesPane.harness'
import { HIT_TARGET_28 } from './hitTarget'

afterEach(teardown)

describe('Changes pane — state matrix (§14)', () => {
  it('idle: no repo for the focused pane, so it says which door opens one', () => {
    mount({ dir: null })
    expect(state()).toBe('idle')
    expect(q('[data-testid="changes-idle"]')).not.toBeNull()
  })

  it('a null dir never asks the daemon for status', () => {
    const h = mount({ dir: null })
    expect(state()).toBe('idle')
    expect(h.client.gitStatusCalls).toHaveLength(0)
  })

  it('loading: the first status reply is still pending — a spinner, not a failure', () => {
    mount({})
    expect(state()).toBe('loading')
    expect(q('[data-testid="changes-loading"]')).not.toBeNull()
    expect(q('[data-testid="changes-error"]')).toBeNull()
  })

  it('empty: a clean tree says so, and does not render an empty list', () => {
    const h = mount({})
    h.status([])
    expect(state()).toBe('empty')
    expect(q('[data-testid="changes-clean"]')).not.toBeNull()
    expect(q('[data-testid="changes-list"]')).toBeNull()
  })

  it('filled: rows grouped, each with a path, counts and a mark glyph', () => {
    const h = mount({})
    h.status([
      file({ path: 'src/app.ts', staged: true, added: 9, deleted: 7 }),
      file({ path: 'notes.md', status: 'untracked', added: undefined, deleted: undefined })
    ])
    expect(state()).toBe('filled')
    const rows = qa('[data-testid="changes-file"]')
    expect(rows.map((r) => r.getAttribute('data-path'))).toEqual(['src/app.ts', 'notes.md'])
    expect(rows.map((r) => r.getAttribute('data-tag'))).toEqual(['staged', 'untracked'])
    expect(q('[data-testid="changes-list"]')!.textContent).toContain('+9')
  })

  it('error: a generic status failure names the message and offers a working Retry', () => {
    const h = mount({})
    const before = h.client.gitStatusCalls.length
    act(() => h.client.emit({ type: 'error', message: 'git status task panicked: boom' }))
    expect(state()).toBe('error')
    expect(q('[data-testid="changes-error"]')!.textContent).toContain(
      'git status task panicked: boom'
    )
    click(q('[data-testid="changes-error"]')!.querySelector('button'))
    expect(h.client.gitStatusCalls.length).toBeGreaterThan(before)
  })

  it('not-a-repo: the daemon\'s own substring routes to a distinct state naming `git init`', () => {
    const h = mount({})
    act(() => h.client.emit({ type: 'error', message: '/repo is not a git repository' }))
    expect(state()).toBe('not-a-repo')
    const body = q('[data-testid="changes-not-a-repo"]')!
    expect(body.textContent).toContain('git init')
    expect(body.querySelector('button')).toBeNull()
  })

  it('a successful status after a failure clears the error', () => {
    const h = mount({})
    act(() => h.client.emit({ type: 'error', message: 'boom' }))
    expect(state()).toBe('error')
    h.status([file()])
    expect(state()).toBe('filled')
  })
})

describe('Changes pane — the blocked file', () => {
  it('a blocked row carries the `blocked` tag and offers no stage or discard', () => {
    const h = mount({})
    h.status([file({ path: '.env.local', status: 'untracked', is_sensitive: true })])
    const row = q('[data-testid="changes-file"]')!
    expect(row.getAttribute('data-tag')).toBe('blocked')
    click(q('[data-testid="changes-row-menu"]'))
    const items = qa<HTMLButtonElement>('[role="menuitem"]')
    expect(items.map((i) => i.disabled)).toEqual([true, true, true])
  })

  it('the row-menu button keeps its 18px box and hit-tests to the 28px floor', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts', staged: true })])
    const btn = q<HTMLButtonElement>('[data-testid="changes-row-menu"]')!
    for (const token of HIT_TARGET_28.split(/\s+/)) {
      expect(btn.className, `missing "${token}" — hit area is not expanded`).toContain(token)
    }
    expect(btn.className).toContain('w-[var(--h-ctl-mini)]')
  })

  it('selecting a blocked file shows the notice and NEVER requests its diff', () => {
    const h = mount({})
    h.status([file({ path: '.env.local', status: 'untracked', is_sensitive: true })])
    click(q('[data-testid="changes-file"]'))
    expect(q('[data-testid="changes-blocked-notice"]')).not.toBeNull()
    expect(h.client.gitDiffCalls).toHaveLength(0)
  })

  it('a blocked selection suppresses the +N/−N summary', () => {
    const h = mount({})
    h.status([file({ path: '.env.local', is_sensitive: true, added: 3, deleted: 1 })])
    click(q('[data-testid="changes-file"]'))
    expect(q('[data-testid="changes-diff-counts"]')).toBeNull()
  })

  it('a non-sensitive selection does request its diff and shows its counts', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts', added: 3, deleted: 1 })])
    click(q('[data-testid="changes-file"]'))
    expect(h.client.gitDiffCalls).toEqual([{ dir: '/repo', path: 'src/app.ts', base: null }])
    expect(q('[data-testid="changes-diff-counts"]')!.textContent).toContain('+3')
  })
})

describe('Changes pane — the reviewing state', () => {
  it('plain Changes reports its branch, counts and a missing PR to the panel', () => {
    const onSummary = vi.fn()
    const h = mount({ onSummary })
    h.status([file(), file({ path: 'b.ts', staged: true })], { branch: 'main', ahead: 2 })
    expect(onSummary).toHaveBeenLastCalledWith({
      branch: 'main',
      ahead: 2,
      behind: 0,
      changed: 2,
      hasPr: false,
      prTone: 'ok'
    })
    expect(q('[data-testid="changes-pane"]')!.getAttribute('data-reviewing')).toBeNull()
  })

  it('while a reviewer runs, the pane is flagged reviewing and the summary survives', () => {
    const onSummary = vi.fn()
    const h = mount({
      onSummary,
      review: {
        session: 7,
        codename: 'Dean',
        data: {
          dir: '/repo',
          branch: 'main',
          upstream: null,
          ahead: 0,
          behind: 0,
          head: null,
          files: [],
          sections: [],
          blocked_paths: [],
          warnings: [],
          truncated: false,
          redacted: false
        }
      }
    })
    h.status([file()])
    expect(q('[data-testid="changes-pane"]')!.getAttribute('data-reviewing')).toBe('true')
    expect(onSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ branch: 'main', changed: 1 })
    )
  })
})

describe('Changes pane — width is the panel\'s business', () => {
  it('the body keeps the stacked default and the wide @container override', () => {
    const h = mount({})
    h.status([file()])
    const body = q('[data-testid="changes-body"]')!
    expect(body.className).toContain('flex-col')
    expect(body.className).toContain('[@container_(min-width:720px)]:flex-row')
    const left = q('[data-testid="changes-left"]')!
    expect(left.className).toContain('[@container_(min-width:720px)]:w-[300px]')
  })

  it('wide mode gives the diff the remainder: the left column never flexes', () => {
    const h = mount({})
    h.status([file()])
    const left = q('[data-testid="changes-left"]')!
    expect(left.className).toContain('flex-none')
    expect(left.className).not.toContain('[@container_(min-width:720px)]:flex-1')
  })

  it('the commit actions wrap under the status line instead of clipping at 280px', () => {
    const h = mount({})
    h.status([file(), file({ path: 'b.ts', staged: true })])
    const actions = q('[data-testid="changes-actions"]')!
    expect(actions.className).toContain('flex')
    const row = actions.lastElementChild!
    expect(row.className).toContain('flex-wrap')
    expect(row.className).toContain('justify-end')
    expect(q('[data-testid="changes-staged-count"]')!.className).toContain('whitespace-nowrap')
  })
})
