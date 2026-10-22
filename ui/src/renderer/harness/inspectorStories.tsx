import React, { useEffect } from 'react'
import { SidePanel } from '../src/components/SidePanel'
import { OverviewTab } from '../src/components/OverviewTab'
import type { HoustonClient } from '../src/houston/client'
import type { SessionInfo } from '../src/houston/client'

type Theme = 'graphite' | 'paper'
type Board = 'changes' | 'pr' | 'pr-failing' | 'files' | 'children' | 'launcher' | 'diff' | 'browser-empty' | 'browser-page' | 'browser-tabs'

const repo = '/repo'
const sessionId = 1009
const orchestratorId = 1008

export class InspectorClient {
  private readonly subscribers = new Map<string, Set<(message: never) => void>>()
  private request = 0

  constructor(
    private readonly failingChecks = false,
    private readonly diffFixture = false,
    private readonly prFixture?: { number: number; state: 'open' | 'merged' | 'closed'; isDraft?: boolean; metadataMissing?: boolean; ageSeconds?: number; runningChecks?: boolean },
    private readonly unstagedFixture = false,
  ) {}

  subscribe(kind: string, handler: (message: never) => void): () => void {
    const listeners = this.subscribers.get(kind) ?? new Set()
    listeners.add(handler)
    this.subscribers.set(kind, listeners)
    return () => listeners.delete(handler)
  }

  private emit(message: Record<string, unknown>): void {
    for (const listener of this.subscribers.get(String(message.type)) ?? []) listener(message as never)
  }

  /** The merge queue fixture: PR 1's human-merged queue, or the "merge when verified" policy
   *  with the head verifying and one entry parked on a conflict. */
  mergeQueuePolicy = false
  /** GitHub's own merge path: its merge queue holds the restacked head of a stack
   *  whose dependency merged, or nothing hands off (`houston`). */
  mergeQueueGitHub: 'houston' | 'restacked' | 'watching' = 'houston'

  mergeQueueGet(dir: string): void {
    if (this.mergeQueueGitHub !== 'houston') return this.mergeQueueGitHubGet(dir)
    const sha = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432'
    const policy = this.mergeQueuePolicy
    const verification = (state: string, reason: string) => ({ kind: 'verification', state, reason })
    const gates = (threads: string | null, verify: Record<string, unknown>) => [
      { kind: 'mergeable', state: 'passed', reason: null },
      { kind: 'review_threads', state: threads ? 'failed' : 'passed', reason: threads },
      { kind: 'reviewer', state: 'not_applicable', reason: null },
      verify
    ]
    const entry = (number: number, title: string, position: number, reason: string | null, extra: Record<string, unknown> = {}) => ({
      number, repository: 'owner/houston', url: `https://github.com/owner/houston/pull/${number}`, title, head_ref: `houston/change-${number}`, head_sha: sha,
      base_ref: 'main', depends_on: null, session: null, position, enqueued_at_ms: Date.now() - position * 600_000, read_at_ms: Date.now() - 20_000,
      status: reason ? 'blocked' : 'ready', reason,
      gates: gates(reason && reason.includes('thread') ? reason : null, policy ? verification('pending', 'Runs when it goes next') : verification('not_applicable', 'No verification command is set')),
      verification: null, failure: null, worktree: null, verifying_since_ms: null, ...extra
    })
    const base = 'a91c2e4b7d0f13c58e62a90b1d4f7c3e8a5b6d21'
    const conflict = { kind: 'conflict', message: 'Rebasing onto main@7f03d1a stopped on a conflict in 2 files', files: ['src/settings/Preferences.tsx', 'src/lib/loadPreferences.ts'], output_tail: null, head_sha: sha, base_sha: '7f03d1a9c2e45b6d8f0a1b3c5d7e9f2a4b6c8d0e', handed_to: null, at_ms: Date.now() - 3 * 3_600_000 }
    const entries = policy ? [
      entry(95, 'fix(panes): terminals keep their content while the inspector opens', 1, null, { status: 'verifying', verifying_since_ms: Date.now() - 252_000, gates: gates(null, verification('pending', 'Verifying now')) }),
      entry(79, 'feat(agents): ZCode runs in a pane with reported status', 2, null, { depends_on: 95 }),
      entry(90, 'refactor(ui): every screen composes components/ui roles', 3, 'PR #90 has 1 unresolved review thread'),
      entry(87, 'feat(settings): show preferences in Settings', 0, conflict.message, { status: 'parked', head_ref: 'houston/settings-prefs', failure: conflict, worktree: '/repo/.houston/worktrees/settings-prefs', gates: gates(null, verification('failed', conflict.message)) })
    ] : [
      entry(95, 'fix(panes): terminals keep their content while the inspector opens', 1, null),
      entry(79, 'feat(agents): ZCode runs in a pane with reported status', 2, null, { depends_on: 95 }),
      entry(90, 'refactor(ui): every screen composes components/ui roles', 3, 'PR #90 has 1 unresolved review thread')
    ]
    const merged = { kind: 'merge', number: 88, repository: 'owner/houston', url: 'https://github.com/owner/houston/pull/88', title: 'fix(rail): background git refresh stays within the handler limit', ref_name: 'main', old_sha: '5c1d0e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d', new_sha: base, head_sha: sha, method: 'squash', detail: null, unattended: policy, at_ms: Date.now() - 45 * 60_000 }
    const parked = { kind: 'park', number: 87, repository: 'owner/houston', url: 'https://github.com/owner/houston/pull/87', title: 'feat(settings): show preferences in Settings', ref_name: 'main', old_sha: conflict.base_sha, new_sha: null, head_sha: sha, method: null, detail: conflict.message, unattended: true, at_ms: conflict.at_ms }
    queueMicrotask(() => this.emit({
      type: 'merge_queue', workspace: '/workspace/houston', dir, message: null, entries,
      log: policy ? [merged, parked] : [merged],
      settings: { merge_when_verified: policy, verification_command: policy ? 'cargo nextest run --workspace' : '', time_limit_minutes: 30, paused: false },
      global_paused: false,
      away: policy ? { merged: 1, parked: 1, last_merge_at_ms: merged.at_ms } : { merged: 0, parked: 0, last_merge_at_ms: null }
    }))
  }

  private mergeQueueGitHubGet(dir: string): void {
    const watching = this.mergeQueueGitHub === 'watching'
    const old = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432'
    const restacked = '4c2e8a1b9d7f6e5c3a2b1d0f9e8c7b6a5d4c3b2a'
    const fork = '1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d'
    const base = 'a91c2e4b7d0f13c58e62a90b1d4f7c3e8a5b6d21'
    const at = (minutes: number) => Date.now() - minutes * 60_000
    const verification = { base_ref: 'main', base_sha: base, head_sha: old, verified_sha: restacked, at_ms: at(6), fork_sha: fork, stacked_on: 94 }
    const head = {
      number: 79, repository: 'owner/houston', url: 'https://github.com/owner/houston/pull/79', title: 'feat(export): CSV export reads preferences', head_ref: 'houston/csv-export', head_sha: watching ? restacked : old,
      base_ref: 'main', depends_on: null, session: null, position: 1, enqueued_at_ms: at(90), read_at_ms: at(1),
      status: watching ? 'watching' : 'ready', reason: watching ? 'In GitHub’s merge queue (position 2)' : null,
      gates: [
        { kind: 'mergeable', state: 'passed', reason: null },
        { kind: 'review_threads', state: 'passed', reason: null },
        { kind: 'reviewer', state: 'not_applicable', reason: null },
        { kind: 'verification', state: 'passed', reason: 'Verified on main@a91c2e4' }
      ],
      verification, failure: null, worktree: '/repo/.houston/worktrees/csv-export', verifying_since_ms: null,
      github: watching ? { mode: 'merge_queue', head_sha: restacked, base_ref: 'main', base_sha: base, method: null, unattended: true, at_ms: at(3) } : null
    }
    const next = { ...head, number: 90, title: 'refactor(ui): every screen composes components/ui roles', url: 'https://github.com/owner/houston/pull/90', head_ref: 'houston/ui-roles', head_sha: old, position: 2, status: 'ready', reason: null, verification: null, github: null, worktree: null, gates: head.gates.map((g) => g.kind === 'verification' ? { ...g, state: 'pending', reason: 'Runs when it goes next' } : g) }
    const row = (kind: string, minutes: number, extra: Record<string, unknown>) => ({ kind, number: 79, repository: 'owner/houston', url: head.url, title: head.title, ref_name: null, old_sha: null, new_sha: null, head_sha: null, method: null, detail: null, unattended: true, at_ms: at(minutes), fork_sha: null, ...extra })
    const log = [
      ...(watching ? [row('hand_off', 3, { ref_name: 'main', head_sha: restacked, detail: 'Added to GitHub’s merge queue' })] : []),
      row('restack', 4, { ref_name: 'houston/csv-export', old_sha: old, new_sha: restacked, fork_sha: fork, detail: 'Restacked after #94' }),
      row('retarget', 5, { ref_name: 'main', detail: 'Retargeted from houston/prefs' }),
      { ...row('merge', 9, { ref_name: 'main', old_sha: '5c1d0e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d', new_sha: base, head_sha: fork, method: 'squash', detail: 'Merged by GitHub’s merge queue' }), number: 94, title: 'feat(prefs): add a preferences table and service', url: 'https://github.com/owner/houston/pull/94' }
    ]
    queueMicrotask(() => this.emit({
      type: 'merge_queue', workspace: '/workspace/houston', dir, message: null, entries: [head, next], log,
      settings: { merge_when_verified: true, verification_command: 'cargo nextest run --workspace', time_limit_minutes: 30, paused: false },
      global_paused: false,
      away: { merged: 0, parked: 0, last_merge_at_ms: null },
      hand_off: { mode: 'merge_queue', base_ref: 'main', read_at_ms: at(1), from_refusal: false }
    }))
  }

  /** The workspace's default agent, which a hand-off pane preselects. */
  taskStartSettingsGet(workspace: string): void {
    queueMicrotask(() => this.emit({ type: 'task_start_settings', workspace, agent: 'codex', delivery: 'send' }))
  }

  mergeQueueEnqueue(): number { return ++this.request }
  mergeQueueDequeue(): number { return ++this.request }
  mergeQueueMergeHead(): number { return ++this.request }
  mergeQueueRetry(): number { return ++this.request }
  mergeQueueRevert(): number { return ++this.request }
  mergeQueuePause(): number { return ++this.request }
  mergeQueueSettingsSet(): number { return ++this.request }
  mergeQueueAcknowledge(): void {}
  mergeQueuePauseAll(): void {}
  mergeQueueSummaryGet(): void {}

  gitStatus(dir: string, base: string | null = null): void {
    setTimeout(() => this.emit({
      type: 'git_status', dir, base, branch: this.diffFixture ? 'inspector-polish' : 'feat/tasks-backlog', upstream: 'origin/main',
      ahead: this.diffFixture ? 2 : 4, behind: 0, default_base: 'main', not_a_repo: false,
      files: this.diffFixture ? [
        ...(base ? ['src/branch-a.ts', 'src/branch-b.ts', 'src/branch-c.ts'].map((path) => ({ path, status: 'modified', staged: false, added: 1, deleted: 0, is_sensitive: false })) : []),
        { path: 'ui/src/renderer/src/ghostty/surface.ts', status: 'modified', staged: !this.unstagedFixture, added: 12, deleted: 3, is_sensitive: false },
        { path: 'ui/src/renderer/src/components/ui/AnimOut.tsx', status: 'modified', staged: !this.unstagedFixture, added: 9, deleted: 2, is_sensitive: false },
        { path: 'ui/src/renderer/src/components/ui/inspector.css', status: 'modified', staged: !this.unstagedFixture, added: 6, deleted: 1, is_sensitive: false },
        { path: 'ui/src/renderer/src/ghostty/surface.fitPaint.test.ts', status: 'added', staged: !this.unstagedFixture, added: 64, deleted: 0, is_sensitive: false }
      ] : [
        { path: 'core/houston-core/src/orchestrate.rs', status: 'modified', staged: !this.unstagedFixture, added: 52, deleted: 12, is_sensitive: false },
        { path: 'core/houston-core/tests/batch_wake_wire.rs', status: 'added', staged: !this.unstagedFixture, added: 12, deleted: 0, is_sensitive: false }
      ]
    }), 10)
  }

  gitBranches(dir: string): void {
    queueMicrotask(() => this.emit({ type: 'git_branches', dir, default_branch: 'main', truncated: false, remotes: [], branches: [
      { name: 'inspector-polish', current: true, is_default: false, is_remote: false, committed_at: Math.floor(Date.now() / 1000) - 3600 },
      { name: 'main', current: false, is_default: true, is_remote: false, committed_at: Math.floor(Date.now() / 1000) - 7200 },
      { name: 'feature/source-control', current: false, is_default: false, is_remote: false, committed_at: Math.floor(Date.now() / 1000) - 10800, ahead: 0, behind: 2 },
      { name: 'houston/pr-list', current: false, is_default: false, is_remote: false, committed_at: Math.floor(Date.now() / 1000) - 14400, worktree_path: '/repo/.houston/worktrees/pr-list' }
    ] }))
  }

  gitWorktrees(dir: string): void {
    queueMicrotask(() => this.emit({ type: 'git_worktrees', dir, worktrees: [
      { path: '/repo', branch: 'inspector-polish', is_main: false, is_detached: false, is_bare: false, dirty: true },
      { path: '/repo/.houston/worktrees/pr-list', branch: 'houston/pr-list', is_main: false, is_detached: false, is_bare: false, dirty: false }
    ] }))
  }

  worktreeCleanupStatus(): void {}

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

  gitDiff(dir: string, path?: string, base: string | null = null): void {
    const pathValue = path ?? 'core/houston-core/src/orchestrate.rs'
    const diffPath = pathValue
    const patch = this.diffFixture
      ? 'diff --git a/ui/src/renderer/src/ghostty/surface.ts b/ui/src/renderer/src/ghostty/surface.ts\n--- a/ui/src/renderer/src/ghostty/surface.ts\n+++ b/ui/src/renderer/src/ghostty/surface.ts\n@@ -910,9 +910,10 @@ fit(): boolean\n     this.mountHeight = height\n     if (shouldRender) {\n-     if (!this.fitted) this.renderFrame()\n+     // A resized canvas is blank until the next paint.\n+     if (!this.fitted || canvasCleared) this.renderFrame()\n      else this.requestRender()\n    }\n'
      : 'diff --git a/core/houston-core/src/orchestrate.rs b/core/houston-core/src/orchestrate.rs\n--- a/core/houston-core/src/orchestrate.rs\n+++ b/core/houston-core/src/orchestrate.rs\n@@ -208,3 +208,4 @@ impl Daemon {\n-    for row in rows {\n+    let grouped = group_by_parent(rows);\n+    wake_each_parent(grouped);\n'
    this.emit({
      type: 'git_diff', dir, base, path: diffPath, truncated: false, patch
    })
  }

  prStatus(dir: string): void {
    queueMicrotask(() => this.emit({ type: 'pr_status', dir, gh: 'ready', has_upstream: true, pr: { number: 95, url: 'https://github.com/owner/houston/pull/95', state: 'open', checks: this.failingChecks ? 'failing' : 'passing', review_decision: null }, hint: null }))
  }

  prDetail(dir: string, requestedNumber?: number): number {
    const request = ++this.request
    const number = requestedNumber ?? this.prFixture?.number ?? 95
    const state = this.prFixture?.state ?? 'open'
    const isDraft = this.prFixture?.isDraft ?? false
    const failingChecks = this.failingChecks || (number === 93 && state === 'open')
    const runningChecks = this.prFixture?.runningChecks === true
    const merged = number === 93
    const title = merged ? 'fix(codex): Codex panes start again with Codex CLI 0.160' : 'fix(panes): terminals keep their content while the inspector opens'
    const updatedAt = Math.floor(Date.now() / 1000) - (this.prFixture?.ageSeconds ?? (merged ? 13 : 12) * 60)
    queueMicrotask(() => this.emit({
      type: 'pr_detail', dir, request, gh: 'ready', has_upstream: true, linked: true, hint: null, message: null,
      link: { host: 'github.com', repository: 'owner/houston', number, url: `https://github.com/owner/houston/pull/${number}`, state, source: 'detected', title, is_draft: isDraft, additions: merged ? 156 : 91, deletions: merged ? 15 : 12, changed_files: 4, checks: failingChecks ? 'failing' : runningChecks ? 'running' : 'passing', review_decision: null, linked_at: 1 },
      detail: {
        body: merged ? '## Problem\nSince v0.16.0, every native Codex launch fails when Codex CLI 0.160 is installed. The socket directory was writable by other users.\n\n## Changes\n- Create the socket directory with mode `0700` regardless of umask.\n- Drain stderr into a bounded 4 KiB tail.\n\n## Verification\n- Regression tests pass.\n- Full renderer gates pass.' : '## Problem\nOpening the inspector narrowed the grid, and every terminal repainted one frame late, so panes flashed blank. `fit()` resized the canvas, which clears its bitmap, but only scheduled the next paint with `requestRender()`.\n\n## Changes\n- `fix(panes)`: a fit that resizes the canvas paints in the same frame.\n- `feat(ui)`: the inspector slides in with `transform`; the grid changes width once.\n\n## Verification\n- Regression test `surface.fitPaint.test.ts` fails before the fix.\n- `bun run typecheck` and renderer tests pass.', author: this.prFixture?.metadataMissing ? null : 'maintainer', base_ref: this.prFixture?.metadataMissing ? null : 'main', head_ref: this.prFixture?.metadataMissing ? null : merged ? 'fix/codex-native-startup' : 'inspector-polish', head_sha: 'a1c3f09', commit_count: 5, created_at: updatedAt - 6000, updated_at: updatedAt, mergeable: 'mergeable', merge_state: 'clean',
        checks: runningChecks ? [
          { name: 'core-checks', state: 'running', url: null, duration_ms: null },
          { name: 'safety-checks', state: 'passing', url: null, duration_ms: 72000 },
          { name: 'windows-checks', state: 'queued', url: null, duration_ms: null },
          { name: 'optional-checks', state: 'skipped', url: null, duration_ms: null }
        ] : failingChecks
          ? [
              { name: 'core-checks', state: 'failing', url: 'https://github.com/acme/houston/actions/runs/412001', duration_ms: 252000, run_id: 412001 },
              { name: 'safety-checks', state: 'passing', url: null, duration_ms: 72000 },
              { name: 'renderer-checks', state: 'passing', url: null, duration_ms: 360000 },
              { name: 'licence-inventory', state: 'passing', url: null, duration_ms: 22000 }
            ]
          : [
              { name: 'safety-checks', state: 'passing', url: null, duration_ms: 72000 },
              { name: 'renderer-checks', state: 'passing', url: null, duration_ms: 360000 },
              { name: 'core-checks', state: 'passing', url: null, duration_ms: 843000 },
              { name: 'licence-inventory', state: 'passing', url: null, duration_ms: 22000 }
            ],
        comments: [
          { id: 'comment-1', author: 'reviewer', body: 'Nice catch on the cleared bitmap. Can the regression test assert the paint count instead of timing?', created_at: updatedAt - 8 * 60, reactions: [] },
          { id: 'comment-2', author: 'maintainer', body: 'Done, the test now counts renderFrame calls inside the resize frame.', created_at: updatedAt - 2 * 60, reactions: [] },
        ], reviews: [], comments_total: 2, reviews_total: 0, merge_disabled_reason: failingChecks ? `PR #${number} has failing checks: core-checks` : null, viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true }, viewer_message: null, behind_by: null, labels: merged ? [] : [{ name: 'bug', color: 'f04438' }, { name: 'renderer', color: '3b82f6' }], reviewers: [], reactions: [], threads: [], threads_truncated: false, threads_message: null, auto_merge_enabled: null, auto_merge_method: null, cross_repository: false
      }
    }))
    return request
  }

  prDiff(dir: string, number: number): number {
    const request = ++this.request
    const paths = number === 93
      ? ['core/houston-core/src/codex_pane.rs', 'core/houston-core/src/daemon.rs', 'ui/src/renderer/src/components/git/GridRailGitSubscription.tsx', 'ui/src/renderer/src/components/git/GridRailGitSubscription.test.ts']
      : ['ui/src/renderer/src/ghostty/surface.ts', 'ui/src/renderer/src/components/ui/AnimOut.tsx', 'ui/src/renderer/src/components/ui/inspector.css', 'ui/src/renderer/src/ghostty/surface.fitPaint.test.ts']
    const hunks = number === 93
      ? [
          '@@ -40 +40 @@ socket_directory\n-    create_dir(&socket_path)?;\n+    create_private_dir(&socket_path)?;\n',
          '@@ -88 +88 @@ launch_codex\n-    return Err(startup_error);\n+    return Err(with_stderr_tail(startup_error));\n',
          '@@ -124 +124 @@ poll_git\n-  if (session) refreshStatus(session);\n+  if (session.state === "running") refreshStatus(session);\n',
          '@@ -55 +55 @@ refresh_status\n-  expect(result).toBeNull();\n+  expect(result).toEqual("running");\n',
        ]
      : [
          '@@ -910,4 +910,5 @@ fit(): boolean\n     if (shouldRender) {\n-      this.requestRender()\n+      this.renderFrame()\n     }\n',
          '@@ -25 +25 @@ animatePanel\n-  element.style.width = targetWidth;\n+  element.style.transform = "translateX(0)";\n',
          '@@ -40 +40 @@ inspector\n-  transition: width .2s;\n+  transition: transform .24s;\n',
          '@@ -60 +60 @@ fit paint\n-  expect(renderCount).toBe(0);\n+  expect(renderCount).toBe(1);\n',
        ]
    const patch = paths.map((path, index) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks[index]}`).join('')
    queueMicrotask(() => this.emit({
      type: 'pr_diff', dir, number, request, truncated: false, message: null,
      patch,
    }))
    return request
  }

  send(message: Record<string, unknown>): void {
    if (message.type === 'pr_watch_list') queueMicrotask(() => this.emit({ type: 'pr_watch_list', watches: [sessionId, orchestratorId].map((session) => ({ session, watches: [] })) }))
    if (message.type === 'workspace_local_servers') queueMicrotask(() => this.emit({
      type: 'workspace_local_servers', workspace: message.workspace, truncated: false, unsupported: null,
      servers: [
        { port: 5173, url: 'http://localhost:5173', process: 'vite', session: orchestratorId, pane_title: 'Claude · Inspector polish', title_hint: 'Houston renderer' },
        { port: 6006, url: 'http://localhost:6006', process: 'storybook', session: sessionId, pane_title: 'Shell · Terminal', title_hint: 'Storybook' }
      ]
    }))
  }

  inboxList(workspace: string): void { queueMicrotask(() => this.emit({ type: 'inbox_rows', workspace, rows: [] })) }
  delegationResultsList(parent: number): void { queueMicrotask(() => this.emit({ type: 'delegation_results', parent, results: [] })) }
  workspaceLocalServers(workspace: string): void { this.send({ type: 'workspace_local_servers', workspace }) }
  prCheckLog(dir: string, run_id: number): void {
    queueMicrotask(() => this.emit({
      type: 'pr_check_log', dir, run_id, available: true, truncated: false,
      lines: ['Running 412 tests', 'test inspector::slide_keeps_width_until_end … ok', 'test rail::cards::checkout_identity_tracks_head … FAILED', '', '---- rail::cards::checkout_identity_tracks_head stdout ----', 'assertion failed: left == right', '  left: "main"  right: "houston/rail-cards"  (tests/checkout_identity.rs:48)']
    }))
  }
  gitStage(): void {}
  gitStatusRefresh(): void {}
}

const client = new InspectorClient() as unknown as HoustonClient
const diffClient = new InspectorClient(false, true) as unknown as HoustonClient
const failingClient = new InspectorClient(true) as unknown as HoustonClient
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

function Frame({ theme, board, width = 470 }: { theme: Theme; board: Board; width?: number }): React.JSX.Element {
  const tab = board === 'pr' ? 'pull-request' : 'changes'
  const closed = board === 'children'
  const activeSessionId = board === 'pr' ? orchestratorId : sessionId
  const failing = board === 'pr-failing'
  const surfaces = board === 'launcher'
    ? []
    : board.startsWith('browser')
      ? ['diff', 'pull-request', 'browser']
      : ['diff', 'pull-request']
  const surface = board === 'launcher' ? null : board.startsWith('browser') ? 'browser' : board === 'diff' ? 'diff' : 'pull-request'
  const [ready] = React.useState(() => {
    localStorage.setItem('tr-scm-width', String(width))
    localStorage.setItem(`tr-inspector-tabs:${repo}`, JSON.stringify({ openTabs: surfaces, active: surface }))
    if (board.startsWith('browser')) localStorage.setItem('tr-browser-recents:/repo', JSON.stringify([
      { url: 'http://localhost:4321/docs', title: 'Houston docs', favicon: null },
      { url: 'https://vite.dev/guide/', title: 'Getting Started | Vite', favicon: null }
    ]))
    if (board === 'browser-tabs') {
      localStorage.setItem(`tr-inspector-tabs:${repo}`, JSON.stringify({openTabs:['browser:story-one','browser:story-two'],active:'browser:story-two'}))
      localStorage.setItem(`tr-inspector-browser-url:${repo}:story-one`, 'http://localhost:5173/')
      localStorage.setItem(`tr-inspector-browser-url:${repo}:story-two`, 'https://example.test/')
    }
    if (board === 'browser-page') localStorage.setItem('tr-browser-tabs.leaf.inspector', JSON.stringify({ tabs: [{ id: 1, url: 'http://localhost:5173' }], activeTabId: 1 }))
    return true
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    if (board === 'browser-page') {
      const timer = window.setTimeout(() => {
        const webview = document.querySelector<HTMLElement>('[data-browser-tab]')
        if (webview) webview.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'Houston renderer' }))
      }, 100)
      return () => window.clearTimeout(timer)
    }
    if (board.startsWith('pr')) document.documentElement.dataset.motionPaused = ''
    return () => {
      if (board.startsWith('pr')) delete document.documentElement.dataset.motionPaused
    }
  }, [theme, board])
  if (!ready) return <></>
  return <div className="flex h-full min-w-0 flex-col" data-story-board={board}>
    <div className="h-8 shrink-0 border-b border-[var(--divider)] bg-[var(--rail-bg)]" />
    {board.startsWith('pr') && <style>{'[data-story-board^="pr"] .loop-anim { animation: none !important; }'}</style>}
    <div className="inspector-story-viewport min-h-0 flex-1" data-testid="side-panel-row">
      <div className="inspector-story-grid" />
      {!closed && <SidePanel
        dir={repo}
        workspace={repo}
        client={failing ? failingClient : board === 'diff' ? diffClient : client}
        width={width}
        onWidth={() => {}}
        onResetWidth={() => {}}
        onOpenUrlInPane={() => {}}
        onSendToTerminal={() => {}}
        tab={tab === 'pull-request' ? 'pull-request' : 'changes'}
        onTab={() => {}}
        sessions={sessions}
        activeSessionId={activeSessionId}
        isGitRepository
        hasPullRequest
        checkoutLabel={board === 'diff' ? 'wt/inspector-polish' : 'inspector-polish'}
        request={board === 'files' ? { kind: 'files', root: repo, path: `${repo}/core/houston-core/src/orchestrate.rs` } : null}
        onReviewChild={() => {}}
        onMoveFile={() => {}}
        onFocusSide={() => {}}
        onFocusGrid={() => {}}
        linkedPullRequests={[{ host: 'github.com', repository: 'owner/houston', number: 95, url: 'https://github.com/owner/houston/pull/95', state: 'open', source: 'detected', title: 'fix(panes): terminals keep their content while the inspector opens', is_draft: false, additions: 91, deletions: 12, changed_files: 4, checks: failing ? 'failing' : 'passing', review_decision: null, linked_at: 1 }]}
      />}
    </div>
  </div>
}

export const InspectorChangesGraphite = (): React.JSX.Element => <Frame theme="graphite" board="changes" />
export const InspectorChangesPaper = (): React.JSX.Element => <Frame theme="paper" board="changes" />
export const InspectorPrGraphite = (): React.JSX.Element => <Frame theme="graphite" board="pr" />
export const InspectorPrPaper = (): React.JSX.Element => <Frame theme="paper" board="pr" />
export const InspectorFilesGraphite = (): React.JSX.Element => <Frame theme="graphite" board="files" />
export const InspectorChildrenGraphite = (): React.JSX.Element => <Frame theme="graphite" board="children" />
export const InspectorChildrenPaper = (): React.JSX.Element => <Frame theme="paper" board="children" />

export const SurfaceLauncher = (): React.JSX.Element => <Frame theme="paper" board="launcher" />
export const SurfaceDiff = (): React.JSX.Element => <Frame theme="paper" board="diff" />
export const SurfaceDiffGraphite = (): React.JSX.Element => <Frame theme="graphite" board="diff" />
export const SurfaceDiff340 = (): React.JSX.Element => <Frame theme="paper" board="diff" width={340} />
export const SurfaceDiff600 = (): React.JSX.Element => <Frame theme="paper" board="diff" width={600} />
export const SurfaceDiff732 = (): React.JSX.Element => <Frame theme="paper" board="diff" width={732} />
export const SurfacePrPassing = (): React.JSX.Element => <Frame theme="paper" board="pr" />
export const SurfacePrFailing = (): React.JSX.Element => <Frame theme="paper" board="pr-failing" />
export const SurfacePrFailing340 = (): React.JSX.Element => <Frame theme="paper" board="pr-failing" width={340} />
export const SurfacePrFailing600 = (): React.JSX.Element => <Frame theme="paper" board="pr-failing" width={600} />
export const SurfacePrFailing732 = (): React.JSX.Element => <Frame theme="paper" board="pr-failing" width={732} />
export const SurfaceBrowserEmpty = (): React.JSX.Element => <Frame theme="paper" board="browser-empty" />
export const SurfaceBrowserPage = (): React.JSX.Element => <Frame theme="paper" board="browser-page" />
export const SurfaceBrowserEmpty340 = (): React.JSX.Element => <Frame theme="paper" board="browser-empty" width={340} />
export const SurfaceBrowserPage340 = (): React.JSX.Element => <Frame theme="paper" board="browser-page" width={340} />
export const SurfaceWidth340 = (): React.JSX.Element => <Frame theme="paper" board="launcher" width={340} />
export const SurfaceWidth470 = (): React.JSX.Element => <Frame theme="paper" board="launcher" width={470} />
export const SurfaceWidth600 = (): React.JSX.Element => <Frame theme="paper" board="launcher" width={600} />
export const SurfaceWidth732 = (): React.JSX.Element => <Frame theme="paper" board="launcher" width={732} />

export const InspectorOverviewStory = (): React.JSX.Element => <><style>{'.agent-dot{animation:none!important}'}</style><OverviewTab parentId={orchestratorId} sessions={sessions} client={client} onClose={() => {}} onReview={() => {}} /></>

export const SurfaceBrowserTabs = (): React.JSX.Element => <Frame board="browser-tabs" theme="graphite" width={470} />
