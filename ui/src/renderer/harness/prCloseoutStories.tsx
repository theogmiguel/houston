import React, { useEffect } from 'react'
import type { PrDetail, PrReviewDraft, PullRequestLink } from '../src/houston/client'
import { PrBrowse } from '../src/components/git/PrBrowse'
import { PrComments, PrThreads } from '../src/components/git/PrDiscussion'
import { PrEmptyStates } from '../src/components/git/PrEmptyStates'
import { PrFiles } from '../src/components/git/PrFiles'
import { PrFooterBar } from '../src/components/git/PrFooterBar'
import { PrLabelPicker, PrReviewerPicker } from '../src/components/git/PrPickers'
import { PrReviewBar } from '../src/components/git/PrReviewBar'
import { PrStackSection } from '../src/components/git/PrStack'
import { ReviewProviderModal } from '../src/components/git/ReviewProviderModal'
import type { PrDiffView, PrListController, PrDetailController } from '../src/components/git/usePrDetailSubscription'

const noop = (): void => {}

const detail = {
  author: 'theo',
  reviewers: [{ id: 'alice', kind: 'user' }],
  labels: [{ name: 'needs-review', color: '0e8a16' }],
  reactions: [{ content: 'THUMBS_UP', count: 2, reacted: true }],
  reviews: [{ id: 'review-1', author: 'alice', state: 'COMMENTED', body: 'Please keep the wake bounded.', submitted_at: 2, reactions: [] }],
  reviews_total: 1,
  comments: [{ id: 'comment-1', author: 'alice', body: 'This is clear.', created_at: 1, reactions: [] }],
  comments_total: 1,
  threads: [{ id: 'thread-1', path: 'core/orchestrate.rs', line: 88, resolved: false, outdated: false, comments: [{ id: 'thread-comment-1', author: 'reviewer', body: 'Can this stay bounded?', created_at: Math.floor(Date.now() / 1000) - 300, reactions: [] }] }],
  threads_truncated: false,
  threads_message: null,
  viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true },
  head_sha: 'a1c3f09',
  auto_merge_enabled: false,
  cross_repository: false
} as unknown as PrDetail

const list = {
  items: [
    { number: 412, title: 'Batch wake requests per parent', author: 'theo', head_ref: 'feat/tasks-backlog', base_ref: 'main', state: 'open', is_draft: false, checks: 'running', labels: [{ name: 'needs-review', color: '0e8a16' }] },
    { number: 408, title: 'Keep child pane state', author: 'alice', head_ref: 'fix/pane-state', base_ref: 'main', state: 'merged', is_draft: false, checks: 'passing', labels: [] }
  ],
  busy: false,
  loadingMore: false,
  truncated: true,
  message: null,
  state: 'open',
  involvement: 'all',
  query: '',
  setFilters: noop,
  load: noop,
  loadMore: noop
} as unknown as PrListController

const controller = {
  write: { busy: null, message: null, notice: null },
  linkBusy: false,
  mergeBusy: false,
  stack: null,
  unlink: noop,
  link: noop,
  action: noop,
  merge: noop,
  mergeStack: noop
} as unknown as PrDetailController

const link = {
  number: 412,
  url: 'https://github.com/acme/houston/pull/412',
  state: 'open',
  is_draft: false,
  title: 'Batch wake requests per parent'
} as PullRequestLink

const patch = `diff --git a/core/orchestrate.rs b/core/orchestrate.rs
--- a/core/orchestrate.rs
+++ b/core/orchestrate.rs
@@ -10,2 +10,3 @@
-    wake_parent(parent);
+    for parent in parents {
+        wake_parent(parent);
+    }
`

export function PrBrowseCapture(): React.JSX.Element {
  return <div className="h-full overflow-auto bg-[var(--content-bg)]"><PrBrowse list={list} active onSelect={noop} onBack={noop} /></div>
}

export function PrBrowseStatesCapture(): React.JSX.Element {
  const empty = { ...list, items: [], truncated: false } as unknown as PrListController
  const failed = { ...list, items: null, message: 'Pull requests could not be loaded.' } as unknown as PrListController
  return <div className="flex h-full flex-col bg-[var(--content-bg)]"><PrBrowse list={empty} active onSelect={noop} /><PrBrowse list={failed} active onSelect={noop} /></div>
}

export function PrDiscussionCapture(): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const label of ['Discussions', 'Comments']) {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="disclosure"] button[aria-expanded]'))
          .find((candidate) => candidate.textContent?.includes(label))
        if (button?.getAttribute('aria-expanded') === 'false') button.click()
      }
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="pr-closeout-capture h-full overflow-auto bg-[var(--content-bg)] p-[var(--space-3)]"><style>{'.pr-closeout-capture [data-testid="disclosure"] > div { transition: none !important; }'}</style><PrThreads detail={detail} busy={false} number={412} onReply={noop} onResolve={noop} onReact={noop} /><PrComments detail={detail} busy={false} onComment={noop} onCommentEdit={noop} onReact={noop} /></div>
}

export function PrCommentEditCapture(): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const comments = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="disclosure"] button[aria-expanded]'))
        .find((button) => button.textContent?.includes('Comments'))
      if (comments?.getAttribute('aria-expanded') === 'false') comments.click()
      window.setTimeout(() => {
        document.querySelector<HTMLButtonElement>('[data-testid="pr-comment-edit-comment-1"]')?.click()
        document.querySelector<HTMLButtonElement>('[data-testid="pr-reaction-add"]')?.click()
      }, 0)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="pr-closeout-capture h-full overflow-auto bg-[var(--content-bg)] p-[var(--space-3)]"><style>{'.pr-closeout-capture [data-testid="disclosure"] > div { transition: none !important; }'}</style><PrComments detail={detail} busy={false} onComment={noop} onCommentEdit={noop} onReact={noop} /></div>
}

export function PrEmptyCapture(): React.JSX.Element {
  return <div className="flex h-full flex-col gap-[var(--space-3)] bg-[var(--content-bg)]"><PrEmptyStates testId="pr-empty" headline="No pull request" description="This branch has no upstream, so it cannot have a pull request yet." /></div>
}

export function PrFilesCapture(): React.JSX.Element {
  return <div className="h-full overflow-auto bg-[var(--content-bg)]"><PrFiles diff={{ number: 412, patch, truncated: false, message: null } as PrDiffView} loading={false} drafts={[]} writeBusy={false} onAddDraft={noop} onReload={noop} /></div>
}

export function PrFilesStatesCapture(): React.JSX.Element {
  return <div className="flex h-full flex-col gap-[var(--space-2)] overflow-auto bg-[var(--content-bg)]"><PrFiles diff={{ number: 412, patch: '', truncated: false, message: null } as PrDiffView} loading={false} drafts={[]} writeBusy={false} onAddDraft={noop} onReload={noop} /><PrFiles diff={{ number: 412, patch: '', truncated: false, message: 'The remote diff could not be read.' } as PrDiffView} loading={false} drafts={[]} writeBusy={false} onAddDraft={noop} onReload={noop} /></div>
}

export function PrActionsCapture(): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="pr-actions-menu"]')?.click(), 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="flex h-full items-end bg-[var(--content-bg)]"><PrFooterBar link={link} detail={detail} pr={controller} linked onOpenUrlInPane={noop} method="squash" setMethod={noop} mergeReason={null} /></div>
}

export function PrPickerCapture(): React.JSX.Element {
  return <div className="flex h-full flex-col gap-[var(--space-3)] overflow-auto bg-[var(--content-bg)] p-[var(--space-3)]">
    <PrReviewerPicker detail={detail} busy={false} candidates={[{ id: 'alice', login: 'alice', kind: 'user', name: 'Alice Example', is_requested: true }, { id: 'bob', login: 'bob', kind: 'user', name: 'Bob Example', is_requested: false }]} loading={false} message={null} onLoad={noop} onApply={noop} open />
    <PrLabelPicker detail={detail} busy={false} candidates={[{ name: 'needs-review', color: '0e8a16', description: 'Review requested', is_applied: true }, { name: 'bug', color: 'd73a4a', description: 'Something is broken', is_applied: false }]} loading={false} message={null} onLoad={noop} onToggle={noop} open />
    <PrStackSection number={412} busy={false} stack={{ number: 412, layers: [{ number: 412, title: link.title, head_ref: 'feat/tasks-backlog', state: 'open', is_draft: false }] } as never} checked loading={false} message={null} onLoad={noop} open />
  </div>
}

export function PrReviewCapture(): React.JSX.Element {
  const drafts: PrReviewDraft[] = [{ path: 'core/orchestrate.rs', side: 'right', line: 12, body: 'Please retain a test for this branch.' }]
  return <div className="h-full overflow-auto bg-[var(--content-bg)] p-[var(--space-3)]"><PrReviewBar detail={detail} busy={false} drafts={drafts} onRemoveDraft={noop} onSubmit={noop} verdict="approve" onVerdictChange={noop} body="Looks good overall." onBodyChange={noop} draftsOpen onDraftsOpenChange={noop} /></div>
}

export function ReviewProviderCapture(): React.JSX.Element {
  return <div className="h-full bg-[var(--content-bg)]"><ReviewProviderModal onCancel={noop} onStart={noop} /></div>
}

export function ReviewProviderSelectedCapture(): React.JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid^="review-provider-"]')?.click(), 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="h-full bg-[var(--content-bg)]"><ReviewProviderModal onCancel={noop} onStart={noop} /></div>
}
