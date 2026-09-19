// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'
import type { GitCheckpointInfo } from '../../houston/generated/GitCheckpointInfo'
import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'
import { BranchesDialog } from './BranchesDialog'
import { CheckpointsDialog } from './CheckpointsDialog'
import { WorktreesDialog } from './WorktreesDialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(node: React.ReactNode): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(node)
  })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  document.body.innerHTML = ''
})

function q<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el as T
}

function qa<T extends Element = HTMLElement>(sel: string): T[] {
  return [...document.querySelectorAll(sel)] as T[]
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function branch(over: Partial<GitBranchInfo> = {}): GitBranchInfo {
  return {
    name: 'main',
    current: true,
    is_default: true,
    is_remote: false,
    remote_name: null,
    upstream: null,
    worktree_path: null,
    ...over
  }
}

function worktree(over: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path: '/state/worktrees/repo/task',
    branch: 'houston/task',
    head: 'abcdef1234567890',
    is_main: false,
    is_detached: false,
    is_bare: false,
    dirty: false,
    ...over
  }
}

function checkpoint(over: Partial<GitCheckpointInfo> = {}): GitCheckpointInfo {
  return {
    ref: 'refs/houston/checkpoints/xbWFudWFs/xYmFzZQ',
    label: 'base',
    owner: 'manual',
    sha: '1234567890abcdef',
    created_ms: Date.now() - 60_000,
    ...over
  }
}

const noop = (): void => {}

describe('BranchesDialog', () => {
  it('creates, switches, renames and deletes through its callbacks', () => {
    const onCreate = vi.fn()
    const onSwitch = vi.fn()
    const onRename = vi.fn()
    const onDelete = vi.fn()
    mount(
      <BranchesDialog
        branches={[branch(), branch({ name: 'feat/x', current: false, is_default: false })]}
        remotes={[branch({ name: 'origin/main', current: false, is_default: false, is_remote: true, remote_name: 'origin' })]}
        defaultBranch="main"
        truncated={false}
        busy={false}
        error={null}
        onClose={noop}
        onRefresh={noop}
        onCreate={onCreate}
        onSwitch={onSwitch}
        onRename={onRename}
        onDelete={onDelete}
      />
    )

    const createBtn = q<HTMLButtonElement>('[data-testid="branch-new-create"]')
    expect(createBtn.disabled).toBe(true)
    type(q<HTMLInputElement>('[data-testid="branch-new-name"]'), 'feat/new')
    expect(createBtn.disabled).toBe(false)
    click(createBtn)
    expect(onCreate).toHaveBeenCalledWith('feat/new', null, true)

    // Switch is refused for the current branch but offered for the other one.
    const selects = qa<HTMLButtonElement>('[data-testid="branch-select"]')
    expect(selects[0].disabled).toBe(true)
    click(selects[1])
    expect(onSwitch).toHaveBeenCalledWith('feat/x')

    click(qa('[data-testid="branch-rename"]')[1])
    type(q<HTMLInputElement>('[data-testid="branch-rename-input"]'), 'feat/y')
    click(q('[data-testid="branch-rename-save"]'))
    expect(onRename).toHaveBeenCalledWith('feat/x', 'feat/y')

    click(qa('[data-testid="branch-delete"]')[1])
    click(q('[data-testid="branch-delete-safe"]'))
    click(qa('button').filter((b) => b.textContent === 'Delete').at(-1)!)
    expect(onDelete).toHaveBeenCalledWith('feat/x', false)
  })

  it('force delete is a separate, explicit choice', () => {
    const onDelete = vi.fn()
    mount(
      <BranchesDialog
        branches={[branch({ current: true }), branch({ name: 'gone', current: false, is_default: false })]}
        remotes={[]}
        defaultBranch="main"
        truncated={false}
        busy={false}
        error={null}
        onClose={noop}
        onRefresh={noop}
        onCreate={noop}
        onSwitch={noop}
        onRename={noop}
        onDelete={onDelete}
      />
    )
    click(qa('[data-testid="branch-delete"]')[1])
    click(q('[data-testid="branch-delete-force"]'))
    const confirm = qa('button').find((b) => b.textContent === 'Force delete')!
    click(confirm)
    expect(onDelete).toHaveBeenCalledWith('gone', true)
  })

  it('filters the listing and refuses the current branch as a delete target', () => {
    mount(
      <BranchesDialog
        branches={[branch(), branch({ name: 'feat/x', current: false, is_default: false })]}
        remotes={[]}
        defaultBranch="main"
        truncated={false}
        busy={false}
        error={null}
        onClose={noop}
        onRefresh={noop}
        onCreate={noop}
        onSwitch={noop}
        onRename={noop}
        onDelete={noop}
      />
    )
    const deleteButtons = qa<HTMLButtonElement>('[data-testid="branch-delete"]')
    expect(deleteButtons[0].disabled).toBe(true)
    expect(deleteButtons[1].disabled).toBe(false)

    type(q<HTMLInputElement>('[data-testid="branches-filter"]'), 'feat')
    expect(qa('[data-testid="branch-row"]').map((r) => r.getAttribute('data-branch'))).toEqual([
      'feat/x'
    ])
  })
})

describe('WorktreesDialog', () => {
  it('creates, adds as workspace, and removes with force when dirty', () => {
    const onCreate = vi.fn()
    const onAddWorkspace = vi.fn()
    const onRemove = vi.fn()
    mount(
      <WorktreesDialog
        dir="/repo"
        worktrees={[
          worktree({ path: '/repo', branch: 'main', is_main: true }),
          worktree({ dirty: true })
        ]}
        branches={[branch()]}
        defaultBranch="main"
        busy={false}
        error={null}
        onClose={noop}
        onRefresh={noop}
        onCreate={onCreate}
        onRemove={onRemove}
        onPrune={noop}
        onAddWorkspace={onAddWorkspace}
      />
    )

    type(q<HTMLInputElement>('[data-testid="worktree-new-name"]'), 'fix-login')
    click(q('[data-testid="worktree-new-create"]'))
    expect(onCreate).toHaveBeenCalledWith('fix-login', null)

    click(qa('[data-testid="worktree-add-workspace"]')[1])
    expect(onAddWorkspace).toHaveBeenCalledWith('/state/worktrees/repo/task')

    // The main checkout cannot be removed.
    expect(qa<HTMLButtonElement>('[data-testid="worktree-remove"]')[0].disabled).toBe(true)
    click(qa('[data-testid="worktree-remove"]')[1])
    expect(document.body.textContent).toContain('Uncommitted changes there are lost')
    const confirm = qa('button').find((b) => b.textContent === 'Force remove')!
    click(confirm)
    expect(onRemove).toHaveBeenCalledWith('/state/worktrees/repo/task', true)
  })
})

describe('CheckpointsDialog', () => {
  it('captures with a label, inspects, restores behind a confirm and deletes', () => {
    const onCreate = vi.fn()
    const onInspect = vi.fn()
    const onRestore = vi.fn()
    const onDelete = vi.fn()
    mount(
      <CheckpointsDialog
        checkpoints={[checkpoint(), checkpoint({ ref: 'r2', label: 'second', owner: 'session_3' })]}
        busy={false}
        error={null}
        inspect={null}
        onClose={noop}
        onRefresh={noop}
        onCreate={onCreate}
        onInspect={onInspect}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    )

    type(q<HTMLInputElement>('[data-testid="checkpoint-new-label"]'), 'before refactor')
    click(q('[data-testid="checkpoint-create"]'))
    expect(onCreate).toHaveBeenCalledWith('before refactor')

    click(qa('[data-testid="checkpoint-inspect"]')[0])
    expect(onInspect).toHaveBeenCalledWith(checkpoint().ref)

    click(qa('[data-testid="checkpoint-restore"]')[0])
    expect(document.body.textContent).toContain('Commits are not moved')
    click(qa('button').find((b) => b.textContent === 'Restore')!)
    expect(onRestore).toHaveBeenCalled()

    click(qa('[data-testid="checkpoint-delete"]')[1])
    click(qa('button').find((b) => b.textContent === 'Delete')!)
    expect(onDelete).toHaveBeenCalledWith('r2')
  })

  it('shows the inspect diff, its redaction notice and its empty state', () => {
    const { rerender } = (() => {
      mount(
        <CheckpointsDialog
          checkpoints={[checkpoint()]}
          busy={false}
          error={null}
          inspect={{ ref: checkpoint().ref, patch: '+x', truncated: false, redacted: true, loading: false }}
          onClose={noop}
          onRefresh={noop}
          onCreate={noop}
          onInspect={noop}
          onRestore={noop}
          onDelete={noop}
        />
      )
      return { rerender: () => {} }
    })()
    expect(q('[data-testid="checkpoint-diff"]').textContent).toContain('redacted')
    expect(q('[data-testid="checkpoint-diff"]').textContent).toContain('+x')
    void rerender
  })
})
