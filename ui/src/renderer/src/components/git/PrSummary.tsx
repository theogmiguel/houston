import { PrTab } from '../ui/PrTab'
import { PullRequestRole } from '../ui/PullRequestRoles'
import type { PrDetail } from '../../houston/client'
import { Disclosure } from '../ui/Disclosure'
import { MarkdownDocument } from '../markdownPipeline'
import type { ReactNode } from 'react'

export function PrSummary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <PullRequestRole as="div" role="summary-content" className="flex-1" data-testid="pr-summary">
      {children}
    </PullRequestRole>
  )
}

export function PrBranchSummary({
  detail,
  people,
  checks,
  footer,
  descriptionAction
}: {
  detail: PrDetail
  people: ReactNode
  checks: ReactNode
  footer: ReactNode
  descriptionAction: ReactNode
}): React.JSX.Element {
  return <PrTab as="div" surface="pr-branch-summary" data-testid="pr-summary">
    {people}
    <Disclosure summary="Description" defaultOpen variant="flush" scrollBody={false}>
      <div data-testid="pr-description">
        <PrTab as="div" surface="pr-branch-description-action">{descriptionAction}</PrTab>
        {detail.body ? <MarkdownDocument source={detail.body} variant="editor" /> : null}
      </div>
    </Disclosure>
    {checks}
    {footer}
  </PrTab>
}
