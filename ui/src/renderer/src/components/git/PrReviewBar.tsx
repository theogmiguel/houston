import { LazyLegacyButton } from '../ui/LazyLegacyButtonRoles'
import { Button } from '../ui/Button'
import { TextArea } from '../ui/TextArea'
import { Text } from '../ui/Text'
import { ReviewComposer, ReviewToolbar, ReviewDraftList, ReviewDraftRow, ReviewDraftBody, ReviewSubmitFooter, ReviewBarPanel } from '../ui/ReviewSubmission'

import type { PrDetail, PrReviewDraft, PrReviewVerdict } from '../../houston/client'
import { Disclosure } from '../ui/Disclosure'
import { Select, type SelectOption } from '../ui/Select'
import { Tooltip } from '../ui/Tooltip'
import { draftLabel } from './prDetailUi'
const VERDICTS: readonly SelectOption[] = [
  { value: 'comment', label: 'Comment' },
  { value: 'approve', label: 'Approve' },
  { value: 'request_changes', label: 'Request changes' }
]

export function PrReviewBar({
  detail,
  busy,
  drafts,
  onRemoveDraft,
  onSubmit,
  verdict,
  onVerdictChange,
  body,
  onBodyChange,
  draftsOpen,
  onDraftsOpenChange,
  disclosure = false
}: {
  detail: PrDetail
  busy: boolean
  drafts: PrReviewDraft[]
  onRemoveDraft: (draft: PrReviewDraft) => void
  onSubmit: (verdict: PrReviewVerdict, body: string) => void
  verdict: PrReviewVerdict
  onVerdictChange: (verdict: PrReviewVerdict) => void
  body: string
  onBodyChange: (body: string) => void
  draftsOpen: boolean
  onDraftsOpenChange: (open: boolean) => void
  disclosure?: boolean
}): React.JSX.Element {
  const didAuthor = detail.viewer?.did_author === true
  const options = didAuthor ? VERDICTS.filter((v) => v.value === 'comment') : VERDICTS
  const effective = didAuthor ? 'comment' : verdict
  const content = (
    <ReviewComposer>
      <ReviewToolbar>
        <Text size="small" weight="small" tone="primary">
          Review
        </Text>
        <Tooltip
          label={didAuthor ? 'GitHub takes only comments from the author' : undefined}
          className={didAuthor ? 'inline-flex' : undefined}
        >
          <Select
            aria-label="Review verdict"
            data-testid="pr-review-verdict"
            value={effective}
            options={options}
            disabled={didAuthor}
            onChange={(value) => onVerdictChange(value as PrReviewVerdict)}
          />
        </Tooltip>
        <span className="flex-1" />
        {drafts.length > 0 && (
          <LazyLegacyButton variant="legacy-secondary"
            type="button"
            data-testid="pr-review-drafts-toggle"
            aria-expanded={draftsOpen}
            onClick={() => onDraftsOpenChange(!draftsOpen)}
          >
            {drafts.length === 1 ? '1 inline comment' : `${drafts.length} inline comments`}
          </LazyLegacyButton>
        )}
      </ReviewToolbar>
      <TextArea surface="content"
        data-testid="pr-review-body"
        aria-label="Review body"
        rows={3}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Say what you think"

      />
      {drafts.length > 0 && draftsOpen && (
        <ReviewDraftList data-testid="pr-review-drafts">
          {drafts.map((draft) => (
            <ReviewDraftRow
              key={`${draft.path}:${draft.side}:${draft.line}`}
              data-testid={`pr-review-draft-${draft.path}-${draft.side}-${draft.line}`}
            >
              <ReviewDraftBody>
                {draftLabel(draft)} — {draft.body}
              </ReviewDraftBody>
              <LazyLegacyButton variant="legacy-secondary"
                type="button"
                data-testid="pr-review-draft-remove"
                disabled={busy}
                onClick={() => onRemoveDraft(draft)}
              >
                Remove
              </LazyLegacyButton>
            </ReviewDraftRow>
          ))}
        </ReviewDraftList>
      )}
      <ReviewSubmitFooter>
        <Text size="small" tone="faint">
          Nothing is sent until you submit.
        </Text>
        <span className="flex-1" />
        <Button variant="legacy-primary"
          type="button"
          data-testid="pr-review-submit"
          disabled={busy}
          onClick={() => {
            onSubmit(effective, body)
          }}
        >
          {busy ? 'Submitting…' : 'Submit review'}
        </Button>
      </ReviewSubmitFooter>
    </ReviewComposer>
  )
  if (disclosure) {
    return (
      <Disclosure
        summary="Leave a review"
        variant="divided"
        count={body.trim().length > 0 || drafts.length > 0 ? 'draft' : undefined}
        scrollBody={false}
      >
        <div data-testid="pr-review-bar">{content}</div>
      </Disclosure>
    )
  }
  return (
    <ReviewBarPanel data-testid="pr-review-bar">{content}</ReviewBarPanel>
  )
}
