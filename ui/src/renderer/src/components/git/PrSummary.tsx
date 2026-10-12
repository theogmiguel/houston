import { PrTab } from '../ui/PrTab'
import { PullRequestRole } from '../ui/PullRequestRoles'
import type { PrDetail } from '../../houston/client'
import { useState } from 'react'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { PrDescriptionFrame } from '../ui/PrPresentation'
import { MarkdownDocument } from '../markdownPipeline'
import type { ReactNode } from 'react'

export function PrSummary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <PullRequestRole as="div" role="summary-content" className="flex-1" data-testid="pr-summary">
      {children}
    </PullRequestRole>
  )
}

export function PrBranchSummary({ detail, people, descriptionAction }: { detail: PrDetail; people: ReactNode; descriptionAction: ReactNode; checks?: ReactNode; footer?: ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return <PrTab as="div" surface="pr-branch-summary" data-testid="pr-summary">
    {people}
    {detail.body && <>
      <PrDescriptionFrame clamped={!expanded}><MarkdownDocument source={detail.body} variant="panel" /></PrDescriptionFrame>
      <ReviewButton variant="text-link" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less description' : 'Show full description'}</ReviewButton>
      {expanded && descriptionAction}
    </>}
  </PrTab>
}
