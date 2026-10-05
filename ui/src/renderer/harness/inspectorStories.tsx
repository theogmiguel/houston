import React, { useEffect } from 'react'
import { SidePanel } from '../src/components/SidePanel'
import type { HoustonClient } from '../src/houston/client'
import type { SessionInfo } from '../src/houston/client'

type Theme = 'graphite' | 'paper'
type Board = 'changes' | 'pr' | 'files' | 'children'

const repo = '/repo'
const sessionId = 1009
const orchestratorId = 1008

class InspectorClient {
  private readonly subscribers = new Map<string, Set<(message: never) => void>>()
  private request = 0

  subscribe(kind: string, handler: (message: never) => void): () => void {
    const listeners = this.subscribers.get(kind) ?? new Set()
    listeners.add(handler)
    this.subscribers.set(kind, listeners)
    return () => listeners.delete(handler)
  }

  private emit(message: Record<string, unknown>): void {
    for (const listener of this.subscribers.get(String(message.type)) ?? []) listener(message as never)
  }

  gitStatus(dir: string): void {
    queueMicrotask(() => this.emit({
      type: 'git_status', dir, base: null, branch: 'feat/tasks-backlog', upstream: 'origin/main',
      ahead: 4, behind: 0, default_base: 'main', not_a_repo: false,
      files: [
        { path: 'core/houston-core/src/orchestrate.rs', status: 'modified', staged: false, added: 52, deleted: 12, is_sensitive: false },
        { path: 'core/houston-core/tests/batch_wake_wire.rs', status: 'added', staged: false, added: 12, deleted: 0, is_sensitive: false }
      ]
    }))
  }

  gitBranchCommits(dir: string): void {
    queueMicrotask(() => this.emit({
      type: 'git_branch_commits', dir, total: 4, truncated: false,
      commits: [
        { sha: 'a1c3f09', subject: 'Add the batch wake fixture', author_time_ms: Date.now() - 12 * 60_000 },
        { sha: '7d20e44', subject: 'Read inbox rows per parent', author_time_ms: Date.now() - 31 * 60_000 },
        { sha: '26f4f70', subject: 'Add the task backlog', author_time_ms: Date.now() - 2 * 3_600_000 },
        { sha: 'e8412ab', subject: 'Create the orchestration base', author_time_ms: Date.now() - 4 * 3_600_000 }
      ]
    }))
  }

  gitDiff(dir: string, path?: string): void {
    queueMicrotask(() => this.emit({
      type: 'git_diff', dir, base: null, path: path ?? 'core/houston-core/src/orchestrate.rs', truncated: false,
      patch: 'diff --git a/core/houston-core/src/orchestrate.rs b/core/houston-core/src/orchestrate.rs\n--- a/core/houston-core/src/orchestrate.rs\n+++ b/core/houston-core/src/orchestrate.rs\n@@ -208,3 +208,4 @@ impl Daemon {\n-    for row in rows {\n+    let grouped = group_by_parent(rows);\n+    wake_each_parent(grouped);\n'
    }))
  }

  prStatus(dir: string): void {
    queueMicrotask(() => this.emit({ type: 'pr_status', dir, gh: 'ready', has_upstream: true, pr: { number: 412, url: 'https://github.com/acme/houston/pull/412', state: 'open', checks: 'running', review_decision: 'REVIEW_REQUIRED' }, hint: null }))
  }

  prDetail(dir: string): number {
    const request = ++this.request
    queueMicrotask(() => this.emit({
      type: 'pr_detail', dir, request, gh: 'ready', has_upstream: true, linked: true, hint: null, message: null,
      link: { host: 'github.com', repository: 'acme/houston', number: 412, url: 'https://github.com/acme/houston/pull/412', state: 'open', source: 'branch', title: 'Batch wake requests per parent', is_draft: false, additions: 402, deletions: 52, changed_files: 8, checks: 'running', review_decision: 'REVIEW_REQUIRED', linked_at: 1 },
      detail: {
        body: 'Wake each parent once per batch of inbox rows.', author: 'theo', base_ref: 'main', head_ref: 'feat/tasks-backlog', head_sha: 'a1c3f09', commit_count: 3, created_at: 1, updated_at: 2, mergeable: 'mergeable', merge_state: 'blocked',
        checks: [{ name: 'safety-checks', state: 'passing', url: null, duration_ms: 72000 }, { name: 'core-checks', state: 'passing', url: null, duration_ms: 843000 }, { name: 'renderer-checks', state: 'running', url: null, duration_ms: 360000 }, { name: 'licence-inventory', state: 'passing', url: null, duration_ms: 22000 }],
        comments: [], reviews: [{ id: 'review-1', author: 'alice', state: 'COMMENTED', body: 'Please keep the wake bounded to one pass per parent.', submitted_at: 2, reactions: [] }], comments_total: 0, reviews_total: 1, merge_disabled_reason: 'Waiting for renderer-checks and 1 approval', viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true }, viewer_message: null, behind_by: null, labels: [], reviewers: [{ id: 'reviewer', kind: 'user' }], reactions: [], threads: [{ id: 'thread-1', path: 'PaneHeader.tsx', line: 88, resolved: false, outdated: false, comments: [{ id: 'comment-1', author: 'reviewer', body: 'Hide the watch chip when the pane is narrower than the header budget; it pushes the context meter off the edge.', created_at: Math.floor(Date.now() / 1000) - 9 * 60, reactions: [] }] }], threads_truncated: false, threads_message: null, auto_merge_enabled: null, auto_merge_method: null, cross_repository: false
      }
    }))
    return request
  }

  send(message: Record<string, unknown>): void {
    if (message.type === 'pr_watch_list') queueMicrotask(() => this.emit({ type: 'pr_watch_list', watches: [sessionId, orchestratorId].map((session) => ({ session, watches: [{ number: 412, url: 'https://github.com/acme/houston/pull/412', last_checked_at_ms: Date.now() - 40_000 }] })) }))
  }

  gitStage(): void {}
  gitStatusRefresh(): void {}
}

const client = new InspectorClient() as unknown as HoustonClient
const sessions = new Map<number, SessionInfo>([
  [orchestratorId, {
    id: orchestratorId, title: 'orchestrator', agent: 'claude', detected_agent: 'claude', state: 'running', project_dir: repo,
    checkout_root: repo, spawned_by: null
  } as unknown as SessionInfo],
  [sessionId, {
  id: sessionId, title: 'inbox-api', agent: 'codex', detected_agent: 'codex', state: 'running', project_dir: repo,
  worktree: { path: 'inbox-api' }, checkout_root: repo, spawned_by: orchestratorId
  } as unknown as SessionInfo],
  [1010, { id: 1010, title: 'api-review', agent: 'claude', detected_agent: 'claude', state: 'running', project_dir: repo, spawned_by: orchestratorId } as unknown as SessionInfo]
])

function Frame({ theme, board }: { theme: Theme; board: Board }): React.JSX.Element {
  const tab = board === 'pr' ? 'pull-request' : 'changes'
  const closed = board === 'children'
  const activeSessionId = board === 'pr' ? orchestratorId : sessionId
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  return <div className="inspector-story-viewport" data-story-board={board}>
    <div className="inspector-story-grid" data-testid="side-panel-row" />
    {!closed && <SidePanel
      dir={repo}
      workspace={repo}
      client={client}
      width={384}
      onWidth={() => {}}
      onResetWidth={() => {}}
      onOpenUrlInPane={() => {}}
      onSendToTerminal={() => {}}
      tab={tab === 'pull-request' ? 'pull-request' : 'changes'}
      onTab={() => {}}
      sessions={sessions}
      activeSessionId={activeSessionId}
      request={board === 'files' ? { kind: 'files', root: repo, path: `${repo}/core/houston-core/src/orchestrate.rs` } : null}
      onReviewChild={() => {}}
      onMoveFile={() => {}}
      onFocusSide={() => {}}
      onFocusGrid={() => {}}
    />}
  </div>
}

export const InspectorChangesGraphite = (): React.JSX.Element => <Frame theme="graphite" board="changes" />
export const InspectorChangesPaper = (): React.JSX.Element => <Frame theme="paper" board="changes" />
export const InspectorPrGraphite = (): React.JSX.Element => <Frame theme="graphite" board="pr" />
export const InspectorPrPaper = (): React.JSX.Element => <Frame theme="paper" board="pr" />
export const InspectorFilesGraphite = (): React.JSX.Element => <Frame theme="graphite" board="files" />
export const InspectorChildrenGraphite = (): React.JSX.Element => <Frame theme="graphite" board="children" />
export const InspectorChildrenPaper = (): React.JSX.Element => <Frame theme="paper" board="children" />
