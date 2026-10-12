// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, click, file, mount, q, qa, teardown } from './ChangesPane.harness'

beforeEach(() => localStorage.clear())
afterEach(teardown)

function branch(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, current: false, is_default: false, is_remote: false, ...extra }
}

function open(): ReturnType<typeof mount> {
  const h = mount({ compact: true })
  h.status([file()], { branch: 'topic', ahead: 2 })
  click(q('[data-testid="changes-branch-chip"]'))
  act(() => h.client.emit({ type: 'git_branches', dir: '/repo', branches: [
    branch('topic', { current: true, committed_at: 1 }),
    branch('old', { committed_at: 10, behind: 2 }),
    branch('main', { is_default: true, committed_at: 2 }),
    branch('recent', { committed_at: 30, ahead: 3 })
  ], remotes: [], default_branch: 'main', truncated: false }))
  return h
}

function typeName(value: string): HTMLInputElement {
  const input = q<HTMLInputElement>('[aria-label="Find or create a branch"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

function key(input: Element, key: string, ctrlKey = false): void {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true })))
}

describe('Changes branch switcher', () => {
  it('orders current/default first, then recent commits, and names sync counts', () => {
    open()
    const options = qa('[role="dialog"] [role="option"]')
    expect(options.map((item) => item.textContent)).toEqual(['topic', 'maindefault', 'recent3 ahead', 'old2 behind'])
    expect(options.filter((item) => item.getAttribute('aria-selected') === 'true')).toHaveLength(0)
    expect(q('[data-testid="changes-push"]')?.textContent).toBe('Push 2 commits')
  })

  it('searches, keeps one active row, and switches with Enter', () => {
    const h = open()
    const input = typeName('main')
    expect(qa('[role="dialog"] [role="option"]')).toHaveLength(1)
    key(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(q('[role="dialog"] [role="option"]')?.id)
    key(input, 'Enter')
    expect(h.client.gitBranchSwitchCalls).toEqual([{ dir: '/repo', name: 'main' }])
    expect(q('[aria-label="Switch or create a branch"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="changes-branch-chip"]'))
  })

  it('Enter creates the named branch from the default base and switches to it', () => {
    const h = open()
    const input = typeName('feat/new')
    expect(qa('[role="dialog"] [aria-selected="true"]')).toHaveLength(1)
    key(input, 'Enter')
    expect(h.client.gitBranchCreateCalls).toEqual([{ dir: '/repo', name: 'feat/new', base: 'main', switchTo: true }])
  })

  it('Ctrl+Enter creates a worktree and opens one shell pane only after its receipt', () => {
    const h = open()
    const input = typeName('feat/tree')
    expect(q('[role="dialog"]')?.textContent).toContain('Worktree houston/feat-tree in a new pane')
    key(input, 'Enter', true)
    expect(h.client.gitWorktreeCreateCalls).toEqual([{ dir: '/repo', name: 'feat-tree', base: 'main' }])
    expect(h.client.createSessionCalls).toHaveLength(0)
    act(() => h.client.emit({ type: 'git_worktrees', dir: '/other', worktrees: [{ branch: 'feat/tree', path: '/wrong' }] }))
    expect(h.client.createSessionCalls).toHaveLength(0)
    const receipt = { type: 'git_worktrees', dir: '/repo', worktrees: [{ branch: 'houston/feat-tree', path: '/state/worktrees/repo/feat-tree', is_main: false, is_detached: false, is_bare: false, dirty: false }], message: 'Created worktree' }
    act(() => h.client.emit(receipt))
    act(() => h.client.emit(receipt))
    expect(h.client.createSessionCalls).toEqual([{ agent: 'shell', project_dir: '/state/worktrees/repo/feat-tree' }])
  })

  it('a worktree refusal prevents a later broadcast from opening a pane', () => {
    const h = open()
    key(typeName('feat/tree'), 'Enter', true)
    act(() => h.client.emit({ type: 'error', message: 'git worktree add failed: branch feat/tree already exists' }))
    expect(q('[data-testid="changes-tools-error"]')?.textContent).toContain('feat/tree')
    act(() => h.client.emit({ type: 'git_worktrees', dir: '/repo', worktrees: [{ branch: 'feat/tree', path: '/existing' }] }))
    expect(h.client.createSessionCalls).toHaveLength(0)
  })

  it('Escape dismisses and restores focus without switching', () => {
    const h = open()
    key(typeName('main'), 'Escape')
    expect(h.client.gitBranchSwitchCalls).toHaveLength(0)
    expect(q('[aria-label="Switch or create a branch"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="changes-branch-chip"]'))
  })
})
