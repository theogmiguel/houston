import React, { useEffect, useState } from 'react'
import type { PrDetail } from '../src/houston/client'
import { PrComments, PrThreads } from '../src/components/git/PrDiscussion'
import { setPrDiscussionFilter } from '../src/components/git/prDiscussionFilter'

const noop = (): void => {}
const ago = (minutes: number): number => Math.floor(Date.now() / 1000) - minutes * 60

function remark(id: string, author: string, body: string, minutes: number, bot = false): PrDetail['threads'][number]['comments'][number] {
  return { id, author, body, created_at: ago(minutes), url: null, reactions: [], bot }
}

// An agent pull request as review bots leave it: findings, a CI summary, and
// threads a person has already settled.
const detail = {
  comments: [
    { id: 'IC_1', author: 'ci-coverage', body: 'Coverage 91.4% (+0.2%) on 14 changed files.', created_at: ago(50), url: null, reactions: [], bot: true },
    { id: 'IC_2', author: 'alice', body: 'The wake batching reads well. One question inline.', created_at: ago(30), url: null, reactions: [], bot: false },
    { id: 'IC_3', author: 'deploy-preview', body: 'Preview build ready.', created_at: ago(28), url: null, reactions: [], bot: true }
  ],
  comments_total: 3,
  threads: [
    { id: 'T_open', path: 'core/orchestrate.rs', line: 88, resolved: false, outdated: false, comments: [remark('C1', 'alice', 'Can this stay bounded when a parent has many children?', 25)] },
    { id: 'T_bot', path: 'core/inbox.rs', line: 41, resolved: false, outdated: false, comments: [remark('C2', 'review-app', 'Possible unbounded Vec growth in drain loop.', 45, true)] },
    { id: 'T_answered', path: 'core/inbox.rs', line: 97, resolved: false, outdated: false, comments: [remark('C3', 'review-app', 'This clone may be avoidable.', 44, true), remark('C4', 'theo', 'Kept on purpose: the row outlives the lock.', 20)] },
    { id: 'T_done', path: 'core/wake.rs', line: 12, resolved: true, outdated: false, comments: [remark('C5', 'alice', 'Rename to wake_parents?', 120)] },
    { id: 'T_done_bot', path: 'core/wake.rs', line: 30, resolved: true, outdated: true, comments: [remark('C6', 'review-app', 'Unused import.', 130, true)] }
  ],
  threads_truncated: false,
  threads_message: null,
  viewer: { can_write: true, can_triage: true, can_update: true, did_author: false, can_update_branch: true }
} as unknown as PrDetail

export function PrDiscussionFiltersCapture({ hide }: { hide: boolean }): React.JSX.Element {
  useState(() => setPrDiscussionFilter({ hideResolved: hide, hideBots: hide }))
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="disclosure"] button[aria-expanded]'))
        .find((candidate) => candidate.textContent?.includes('Comments'))
      if (button?.getAttribute('aria-expanded') === 'false') button.click()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <div className="pr-closeout-capture h-full overflow-auto bg-[var(--content-bg)] p-[var(--space-3)]"><style>{'.pr-closeout-capture [data-testid="disclosure"] > div { transition: none !important; }'}</style><PrThreads detail={detail} busy={false} number={412} onReply={noop} onResolve={noop} onReact={noop} /><PrComments detail={detail} busy={false} onComment={noop} onCommentEdit={noop} onReact={noop} /></div>
}
