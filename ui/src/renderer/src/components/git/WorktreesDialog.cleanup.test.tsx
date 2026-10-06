// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ManagedWorktreeInfo } from '../../houston/generated/ManagedWorktreeInfo'
import type { WorktreeKeep } from '../../houston/generated/WorktreeKeep'
import { WorktreesDialog } from './WorktreesDialog'
import type { WorktreeCleanupView } from './worktreeCleanup'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(
  view: WorktreeCleanupView,
  overrides: { onCheck?: () => void; onCleanNow?: (paths: string[]) => void; onRemove?: (p: string, f: boolean) => void; onRemoveStale?: (path: string) => void } = {}
): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(
      <WorktreesDialog
        dir="/repo"
        worktrees={[]}
        cleanup={view}
        branches={[]}
        defaultBranch="main"
        busy={false}
        error={null}
        onClose={() => {}}
        onRefresh={() => {}}
        onCreate={() => {}}
        onRemove={overrides.onRemove ?? (() => {})}
        onPrune={() => {}}
        onCheckCleanup={overrides.onCheck ?? (() => {})}
        onCleanNow={overrides.onCleanNow ?? (() => {})}
        onRemoveStale={overrides.onRemoveStale ?? (() => {})}
        onAddWorkspace={() => {}}
        nowMs={NOW}
      />
    )
  })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
})

function entry(p: Partial<ManagedWorktreeInfo> = {}): ManagedWorktreeInfo {
  return {
    path: '/repo/.houston/worktrees/demo',
    branch: 'houston/demo',
    base_branch: 'main',
    pr: 36,
    keep: null,
    bytes: 23_000_000_000,
    measured_at_ms: NOW - 2 * HOUR,
    checked_at_ms: NOW - 2 * HOUR,
    ...p
  }
}

function staleEntry(path: string): ManagedWorktreeInfo {
  return {
    ...entry({ path, keep: null }),
    base_branch: 'main',
    status: 'stale',
    keep: { kind: 'stale', idle_days: 20, removal_in_days: 10 }
  } as unknown as ManagedWorktreeInfo
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="table-row"]'))
}

function section(): string {
  return document.querySelector('[data-testid="worktree-cleanup"]')?.textContent ?? ''
}

function click(el: Element | null | undefined): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

describe('WorktreesDialog cleanup section', () => {
  it('each managed worktree shows its size and reason', () => {
    mount({
      status: 'ready',
      entries: [
        entry(),
        entry({ path: '/repo/.houston/worktrees/fresh', branch: 'houston/fresh', pr: null, bytes: null, measured_at_ms: null })
      ]
    })
    const [first, second] = rows()
    expect(first.textContent).toContain('/repo/.houston/worktrees/demo')
    expect(first.textContent).toContain('houston/demo')
    expect(first.textContent).toContain('#36')
    expect(first.textContent).toContain('23.0 GB')
    expect(first.textContent).toContain('can be removed')
    expect(second.textContent).toContain('not measured yet')
  })

  it('every keep reason has its own line', () => {
    const cases: [WorktreeKeep, string][] = [
      [{ kind: 'branch_changed', current: 'feat/other' }, 'Kept: switched to feat/other'],
      [{ kind: 'branch_changed', current: null }, 'Kept: its HEAD is detached from the branch Houston created'],
      [{ kind: 'dirty', files: 3 }, 'Kept: 3 uncommitted files'],
      [{ kind: 'ignored_files', files: 1 }, 'Kept: 1 ignored file removal would delete'],
      [{ kind: 'commits_outside_pr', count: 2, pr: 36 }, 'Kept: 2 commits not in PR #36'],
      [{ kind: 'not_integrated' }, 'Kept: one or more commits are not integrated into the base branch'],
      [{ kind: 'pr_head_unavailable', pr: 36 }, 'Kept: the head of PR #36 could not be fetched'],
      [{ kind: 'in_use', session: 12 }, 'Kept: in use by pane 12'],
      [{ kind: 'grace', until_ms: NOW + 3 * HOUR }, 'Kept: merged, removable in 3 h'],
      [{ kind: 'not_merged', state: 'OPEN' }, 'Kept: its PR is open'],
      [{ kind: 'no_pr' }, 'Kept: no pull request for this branch'],
      [{ kind: 'gh_unavailable', gh: 'missing' }, 'Kept: gh is not installed, so the PR cannot be checked'],
      [{ kind: 'probably_integrated' }, 'Kept: its upstream branch is gone, so it is probably integrated — remove it by hand'],
      [{ kind: 'remove_failed', message: 'locked' }, 'Kept: removing it failed: locked']
    ]
    mount({
      status: 'ready',
      entries: cases.map(([keep], i) => entry({ path: `/repo/.houston/worktrees/t${i}`, keep }))
    })
    const rendered = section()
    for (const [, reason] of cases) expect(rendered).toContain(reason)
  })

  it('clean now confirms before sending, and sends only what it listed', () => {
    const onCleanNow = vi.fn()
    mount(
      {
        status: 'ready',
        entries: [
          entry({ path: '/repo/.houston/worktrees/a', bytes: 1_500_000_000 }),
          entry({ path: '/repo/.houston/worktrees/b', bytes: 2_000_000_000 }),
          staleEntry('/repo/stale'),
          entry({ path: '/repo/.houston/worktrees/kept', keep: { kind: 'dirty', files: 1 } }),
          entry({ path: '/repo/.houston/worktrees/unchecked', checked_at_ms: null })
        ]
      },
      {
        onCleanNow,
        onRemoveStale: () => {}
      }
    )
    click(document.querySelector('[data-testid="worktree-cleanup-run"]'))
    expect(onCleanNow).not.toHaveBeenCalled()
    const body = document.body.textContent ?? ''
    expect(body).toContain('/repo/.houston/worktrees/a')
    expect(body).toContain('/repo/.houston/worktrees/b')
    expect(body).toContain('3.5 GB')
    const cleanConfirm = document.querySelector('[role="alertdialog"]')
    expect(cleanConfirm?.textContent).not.toContain('/repo/stale')
    const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Remove')
    click(confirm)
    expect(onCleanNow).toHaveBeenCalledTimes(1)
    expect(onCleanNow).toHaveBeenCalledWith(['/repo/.houston/worktrees/a', '/repo/.houston/worktrees/b'])
  })

  it('check asks for a pass even when nothing is removable yet', () => {
    const onCheck = vi.fn()
    mount({ status: 'ready', entries: [entry({ checked_at_ms: null, keep: null })] }, { onCheck })
    expect(document.querySelector<HTMLButtonElement>('[data-testid="worktree-cleanup-run"]')?.disabled).toBe(true)
    click(document.querySelector('[data-testid="worktree-cleanup-check"]'))
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  it('no managed worktrees', () => {
    mount({ status: 'ready', entries: [] })
    expect(section()).toContain('No worktrees created by Houston here')
    expect((document.querySelector('[data-testid="worktree-cleanup-run"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('pending and refused', () => {
    mount({ status: 'pending' })
    expect(section()).toContain('Checking worktrees…')
    act(() => root!.unmount())
    root = null
    host?.remove()
    mount({ status: 'refused', message: 'a worktree cleanup pass is already running for /repo' })
    expect(section()).toContain('a worktree cleanup pass is already running for /repo')
  })

  it('stale removal asks first, Escape cancels, and confirmation removes the worktree', () => {
    const onRemoveStale = vi.fn()
    mount(
      { status: 'ready', entries: [staleEntry('/stale')] },
      { onRemoveStale }
    )
    click(document.querySelector('[data-testid="worktree-cleanup-remove"]'))
    expect(document.body.textContent).toContain('no unpushed work is lost')
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(document.activeElement?.textContent).toBe('Cancel')
    act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onRemoveStale).not.toHaveBeenCalled()
    click(document.querySelector('[data-testid="worktree-cleanup-remove"]'))
    click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Remove'))
    expect(onRemoveStale).toHaveBeenCalledWith('/stale')
  })
})

describe('useGitToolsSubscription cleanup calls', () => {
  it('check, clean now and remove reach the client', async () => {
    const { useGitToolsSubscription } = await import('./useGitToolsSubscription')
    const calls: [string, ...unknown[]][] = []
    const client = new Proxy(
      {},
      {
        get: (_t, name: string) =>
          name === 'subscribe'
            ? () => () => {}
            : (...args: unknown[]) => {
                calls.push([name, ...args])
              }
      }
    ) as never
    let tools: ReturnType<typeof useGitToolsSubscription> | null = null
    function Harness(): null {
      tools = useGitToolsSubscription({
        client,
        repoDir: '/repo',
        pendingTools: { current: null },
        toolsError: null,
        setToolsNotice: () => {},
        setToolsBusy: () => {},
        setToolsError: () => {}
      })
      return null
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root!.render(<Harness />))

    act(() => tools!.checkCleanup())
    expect(calls).toContainEqual(['worktreeCleanupRun', '/repo', []])
    act(() => tools!.cleanNow(['/a']))
    expect(calls).toContainEqual(['worktreeCleanupRun', '/repo', ['/a']])
    act(() => tools!.removeWorktree('/p', false))
    expect(calls).toContainEqual(['gitWorktreeRemove', '/repo', '/p', false])
  })
})
