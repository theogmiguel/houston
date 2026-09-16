// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChangesPane, type ChangesReview } from './ChangesPane'
import type { GitFileStatus, HoustonClient } from '../houston/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export function file(o: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path: 'src/app.ts',
    status: 'modified',
    staged: false,
    added: 1,
    deleted: 0,
    is_sensitive: false,
    ...o
  }
}

export class FakeClient {
  gitStatusCalls: Array<{ dir: string; base: string | null | undefined }> = []
  gitDiffCalls: Array<{ dir: string; path?: string; base?: string | null }> = []
  gitStageCalls: Array<{ dir: string; paths: string[] }> = []
  gitUnstageCalls: Array<{ dir: string; paths: string[] }> = []
  gitDiscardCalls: Array<{ dir: string; path: string; kind: string }> = []
  gitCommitCalls: Array<{ dir: string; message: string }> = []
  gitPushCalls: string[] = []
  gitReviewDiffsCalls: string[] = []
  prStatusCalls: string[] = []
  prCreateCalls: string[] = []
  gitPullCalls: string[] = []
  gitFetchCalls: string[] = []
  gitBranchesCalls: string[] = []
  gitBranchCreateCalls: Array<{ dir: string; name: string; base: string | null; switchTo: boolean }> = []
  gitBranchSwitchCalls: Array<{ dir: string; name: string }> = []
  gitBranchRenameCalls: Array<{ dir: string; from: string; to: string }> = []
  gitBranchDeleteCalls: Array<{ dir: string; name: string; force: boolean }> = []
  gitWorktreesCalls: string[] = []
  gitWorktreeCreateCalls: Array<{ dir: string; name: string; base: string | null }> = []
  gitWorktreeRemoveCalls: Array<{ dir: string; path: string; force: boolean }> = []
  gitWorktreePruneCalls: string[] = []
  gitCheckpointsCalls: string[] = []
  gitCheckpointCreateCalls: Array<{ dir: string; label: string }> = []
  gitCheckpointDiffCalls: Array<{ dir: string; ref: string; against: string }> = []
  gitCheckpointRestoreCalls: Array<{ dir: string; ref: string }> = []
  gitCheckpointDeleteCalls: Array<{ dir: string; ref: string }> = []
  createSessionCalls: unknown[] = []
  private subs = new Map<string, Set<(msg: never) => void>>()

  gitStatus(dir: string, base?: string | null): void {
    this.gitStatusCalls.push({ dir, base })
  }
  gitDiff(dir: string, path?: string, base?: string | null): void {
    this.gitDiffCalls.push({ dir, path, base })
  }
  gitStage(dir: string, paths: string[] = []): void {
    this.gitStageCalls.push({ dir, paths })
  }
  gitUnstage(dir: string, paths: string[] = []): void {
    this.gitUnstageCalls.push({ dir, paths })
  }
  gitDiscard(dir: string, path: string, kind: string): void {
    this.gitDiscardCalls.push({ dir, path, kind })
  }
  gitCommit(dir: string, message: string): void {
    this.gitCommitCalls.push({ dir, message })
  }
  gitPush(dir: string): void {
    this.gitPushCalls.push(dir)
  }
  gitReviewDiffs(dir: string): void {
    this.gitReviewDiffsCalls.push(dir)
  }
  prStatus(dir: string): void {
    this.prStatusCalls.push(dir)
  }
  prCreate(dir: string, _title?: string, _body?: string): void {
    this.prCreateCalls.push(dir)
    this.prComposeCalls.push({ dir, title: _title ?? null, body: _body ?? null })
  }
  prComposeCalls: Array<{ dir: string; title: string | null; body: string | null }> = []
  gitPull(dir: string): void {
    this.gitPullCalls.push(dir)
  }
  gitFetch(dir: string): void {
    this.gitFetchCalls.push(dir)
  }
  gitBranches(dir: string): void {
    this.gitBranchesCalls.push(dir)
  }
  gitBranchCreate(dir: string, name: string, base: string | null, switchTo: boolean): void {
    this.gitBranchCreateCalls.push({ dir, name, base, switchTo })
  }
  gitBranchSwitch(dir: string, name: string): void {
    this.gitBranchSwitchCalls.push({ dir, name })
  }
  gitBranchRename(dir: string, from: string, to: string): void {
    this.gitBranchRenameCalls.push({ dir, from, to })
  }
  gitBranchDelete(dir: string, name: string, force: boolean): void {
    this.gitBranchDeleteCalls.push({ dir, name, force })
  }
  gitWorktrees(dir: string): void {
    this.gitWorktreesCalls.push(dir)
  }
  gitWorktreeCreate(dir: string, name: string, base: string | null): void {
    this.gitWorktreeCreateCalls.push({ dir, name, base })
  }
  gitWorktreeRemove(dir: string, path: string, force: boolean): void {
    this.gitWorktreeRemoveCalls.push({ dir, path, force })
  }
  gitWorktreePrune(dir: string): void {
    this.gitWorktreePruneCalls.push(dir)
  }
  gitCheckpoints(dir: string): void {
    this.gitCheckpointsCalls.push(dir)
  }
  gitCheckpointCreate(dir: string, label: string): void {
    this.gitCheckpointCreateCalls.push({ dir, label })
  }
  gitCheckpointDiff(dir: string, ref: string, against: string): void {
    this.gitCheckpointDiffCalls.push({ dir, ref, against })
  }
  gitCheckpointRestore(dir: string, ref: string): void {
    this.gitCheckpointRestoreCalls.push({ dir, ref })
  }
  gitCheckpointDelete(dir: string, ref: string): void {
    this.gitCheckpointDeleteCalls.push({ dir, ref })
  }
  createSession(p: unknown): void {
    this.createSessionCalls.push(p)
  }
  subscribe(kind: string, handler: (msg: never) => void): () => void {
    let set = this.subs.get(kind)
    if (!set) {
      set = new Set()
      this.subs.set(kind, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }
  emit(msg: { type: string; [k: string]: unknown }): void {
    for (const h of Array.from(this.subs.get(msg.type) ?? [])) {
      ;(h as (msg: unknown) => void)(msg)
    }
  }
}

export interface Harness {
  client: FakeClient
  container: HTMLDivElement
  status(files: GitFileStatus[], extra?: Record<string, unknown>): void
  unmount(): void
}

let root: Root | null = null
let container: HTMLDivElement | null = null

export function teardown(): void {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  container?.remove()
  container = null
}

export function mount(
  opts: {
    dir?: string | null
    client?: FakeClient | null
    onOpenFileInEditor?: (p: string) => void
    onOpenUrlInPane?: (u: string) => void
    onReviewPacket?: (d: never) => void
    review?: ChangesReview | null
    onSummary?: (s: never) => void
    refreshSignal?: number
  } = {}
): Harness {
  container = document.createElement('div')
  document.body.appendChild(container)
  const client = opts.client === undefined ? new FakeClient() : opts.client
  const dir = opts.dir === undefined ? '/repo' : opts.dir
  root = createRoot(container)
  act(() => {
    root!.render(
      <ChangesPane
        client={client as unknown as HoustonClient | null}
        dir={dir}
        onOpenFileInEditor={opts.onOpenFileInEditor}
        onOpenUrlInPane={opts.onOpenUrlInPane}
        onReviewPacket={opts.onReviewPacket as never}
        review={opts.review ?? null}
        onSummary={opts.onSummary as never}
        refreshSignal={opts.refreshSignal ?? 0}
      />
    )
  })
  const c = container
  return {
    client: client as FakeClient,
    container: c,
    status(files, extra = {}) {
      act(() => {
        ;(client as FakeClient).emit({
          type: 'git_status',
          dir: dir as string,
          files,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          base: null,
          default_base: 'main',
          ...extra
        })
      })
    },
    unmount: teardown
  }
}

export function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel)
}
export function qa<T extends Element = HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll<T>(sel))
}
export function typeCommitMessage(value: string): void {
  const input = q<HTMLTextAreaElement>('[data-testid="changes-commit-message"]')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
export function state(): string | null {
  return q('[data-testid="changes-pane"]')?.getAttribute('data-state') ?? null
}
export function click(el: Element | null): void {
  act(() => {
    ;(el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
export { act }
