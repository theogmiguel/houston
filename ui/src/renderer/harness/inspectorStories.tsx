import React, { useEffect } from 'react'
import { SidePanel } from '../src/components/SidePanel'
import { OverviewTab } from '../src/components/OverviewTab'
import type { HoustonClient } from '../src/houston/client'
import type { SessionInfo } from '../src/houston/client'

type Theme = 'graphite' | 'paper'
type Board = 'changes' | 'pr' | 'pr-failing' | 'files' | 'children' | 'launcher' | 'diff' | 'browser-empty' | 'browser-page'

const repo = '/repo'
const sessionId = 1009
const orchestratorId = 1008

export class InspectorClient {
  private readonly subscribers = new Map<string, Set<(message: never) => void>>()
  private request = 0

  constructor(
    private readonly failingChecks = false,
    private readonly diffFixture = false,
    private readonly prFixture?: { number: number; state: 'open' | 'merged' | 'closed'; isDraft?: boolean },
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

  gitStatus(dir: string): void {
    setTimeout(() => this.emit({
      type: 'git_status', dir, base: null, branch: this.diffFixture ? 'inspector-polish' : 'feat/tasks-backlog', upstream: 'origin/main',
      ahead: this.diffFixture ? 0 : 4, behind: 0, default_base: 'main', not_a_repo: false,
      files: this.diffFixture ? [
        { path: 'ui/src/renderer/src/ghostty/surface.ts', status: 'modified', staged: true, added: 12, deleted: 3, is_sensitive: false },
        { path: 'ui/src/renderer/src/components/ui/AnimOut.tsx', status: 'modified', staged: true, added: 9, deleted: 2, is_sensitive: false },
        { path: 'ui/src/renderer/src/components/ui/inspector.css', status: 'modified', staged: true, added: 6, deleted: 1, is_sensitive: false },
        { path: 'ui/src/renderer/src/ghostty/surface.fitPaint.test.ts', status: 'added', staged: true, added: 64, deleted: 0, is_sensitive: false }
      ] : [
        { path: 'core/houston-core/src/orchestrate.rs', status: 'modified', staged: true, added: 52, deleted: 12, is_sensitive: false },
        { path: 'core/houston-core/tests/batch_wake_wire.rs', status: 'added', staged: true, added: 12, deleted: 0, is_sensitive: false }
      ]
    }), 10)
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
    const pathValue = path ?? 'core/houston-core/src/orchestrate.rs'
    const diffPath = pathValue
    const patch = this.diffFixture
      ? 'diff --git a/ui/src/renderer/src/ghostty/surface.ts b/ui/src/renderer/src/ghostty/surface.ts\n--- a/ui/src/renderer/src/ghostty/surface.ts\n+++ b/ui/src/renderer/src/ghostty/surface.ts\n@@ -910,9 +910,10 @@ fit(): boolean\n     this.mountHeight = height\n     if (shouldRender) {\n-     if (!this.fitted) this.renderFrame()\n+     // A resized canvas is blank until the next paint.\n+     if (!this.fitted || canvasCleared) this.renderFrame()\n      else this.requestRender()\n    }\n'
      : 'diff --git a/core/houston-core/src/orchestrate.rs b/core/houston-core/src/orchestrate.rs\n--- a/core/houston-core/src/orchestrate.rs\n+++ b/core/houston-core/src/orchestrate.rs\n@@ -208,3 +208,4 @@ impl Daemon {\n-    for row in rows {\n+    let grouped = group_by_parent(rows);\n+    wake_each_parent(grouped);\n'
    this.emit({
      type: 'git_diff', dir, base: null, path: diffPath, truncated: false, patch
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
    const merged = number === 93
    const title = merged ? 'fix(codex): Codex panes start again with Codex CLI 0.160' : 'fix(panes): terminals keep their content while the inspector opens'
    const updatedAt = Math.floor(Date.now() / 1000) - (merged ? 13 : 12) * 60
    queueMicrotask(() => this.emit({
      type: 'pr_detail', dir, request, gh: 'ready', has_upstream: true, linked: true, hint: null, message: null,
      link: { host: 'github.com', repository: 'owner/houston', number, url: `https://github.com/owner/houston/pull/${number}`, state, source: 'detected', title, is_draft: isDraft, additions: merged ? 156 : 91, deletions: merged ? 15 : 12, changed_files: 4, checks: this.failingChecks ? 'failing' : 'passing', review_decision: null, linked_at: 1 },
      detail: {
        body: merged ? '## Problem\nSince v0.16.0, every native Codex launch fails when Codex CLI 0.160 is installed. The socket directory was writable by other users.\n\n## Changes\n- Create the socket directory with mode `0700` regardless of umask.\n- Drain stderr into a bounded 4 KiB tail.\n\n## Verification\n- Regression tests pass.\n- Full renderer gates pass.' : '## Problem\nOpening the inspector narrowed the grid, and every terminal repainted one frame late, so panes flashed blank. `fit()` resized the canvas, which clears its bitmap, but only scheduled the next paint with `requestRender()`.\n\n## Changes\n- `fix(panes)`: a fit that resizes the canvas paints in the same frame.\n- `feat(ui)`: the inspector slides in with `transform`; the grid changes width once.\n\n## Verification\n- Regression test `surface.fitPaint.test.ts` fails before the fix.\n- `bun run typecheck` and renderer tests pass.', author: 'maintainer', base_ref: 'main', head_ref: merged ? 'fix/codex-native-startup' : 'inspector-polish', head_sha: 'a1c3f09', commit_count: 5, created_at: updatedAt - 6000, updated_at: updatedAt, mergeable: 'mergeable', merge_state: 'clean',
        checks: this.failingChecks
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
        ], reviews: [], comments_total: 2, reviews_total: 0, merge_disabled_reason: null, viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true }, viewer_message: null, behind_by: null, labels: merged ? [] : [{ name: 'bug', color: 'f04438' }, { name: 'renderer', color: '3b82f6' }], reviewers: [], reactions: [], threads: [], threads_truncated: false, threads_message: null, auto_merge_enabled: null, auto_merge_method: null, cross_repository: false
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
