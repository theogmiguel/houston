import type { PrDetail, PrReviewDraft, PrReviewVerdict } from '../../houston/client'
import { BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import { Disclosure } from '../Disclosure'
import { Select, type SelectOption } from '../Select'
import { Tooltip } from '../Tooltip'
import { draftLabel } from './prDetailUi'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const TEXTAREA =
  'w-full resize-none rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 ' +
  'text-[length:var(--tr-text-small-size)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] ' +
  'focus-visible:outline-none focus-visible:border-[var(--border-focus)]'

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
    <div className="flex flex-col gap-[var(--space-2)] p-[var(--space-2-5)]">
      <div className="flex items-center gap-2">
        <span className={`${SMALL} [font-weight:var(--tr-text-small-weight)] text-[var(--text-primary)]`}>
          Review
        </span>
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
          <button
            type="button"
            data-testid="pr-review-drafts-toggle"
            aria-expanded={draftsOpen}
            onClick={() => onDraftsOpenChange(!draftsOpen)}
            className={`btn ${BTN_SECONDARY} ${ACTION} ${SMALL}`}
          >
            {drafts.length === 1 ? '1 inline comment' : `${drafts.length} inline comments`}
          </button>
        )}
      </div>
      <textarea
        data-testid="pr-review-body"
        aria-label="Review body"
        rows={3}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Say what you think"
        className={TEXTAREA}
      />
      {drafts.length > 0 && draftsOpen && (
        <div className="flex flex-col gap-1" data-testid="pr-review-drafts">
          {drafts.map((draft) => (
            <div
              key={`${draft.path}:${draft.side}:${draft.line}`}
              data-testid={`pr-review-draft-${draft.path}-${draft.side}-${draft.line}`}
              className="flex items-start gap-2"
            >
              <span className={`flex-1 min-w-0 font-mono ${SMALL} text-[var(--text-secondary)] break-words`}>
                {draftLabel(draft)} — {draft.body}
              </span>
              <button
                type="button"
                data-testid="pr-review-draft-remove"
                disabled={busy}
                onClick={() => onRemoveDraft(draft)}
                className={`btn ${BTN_SECONDARY} ${ACTION} disabled:opacity-55`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={`${SMALL} text-[var(--text-faint)]`}>
          Nothing is sent until you submit.
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="pr-review-submit"
          disabled={busy}
          onClick={() => {
            onSubmit(effective, body)
          }}
        className={`btn ${BTN_PRIMARY} inline-flex items-center gap-1.5 disabled:opacity-55 disabled:cursor-not-allowed`}
        >
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
    </div>
  )
  if (disclosure) {
    return (
      <Disclosure
        summary="Leave a review"
        count={body.trim().length > 0 || drafts.length > 0 ? 'draft' : undefined}
        scrollBody={false}
        className="rounded-none border-0 border-t border-t-[var(--divider)] bg-transparent"
      >
        <div data-testid="pr-review-bar">{content}</div>
      </Disclosure>
    )
  }
  return (
    <div
      className="flex flex-none flex-col gap-[var(--space-2)] border-t border-t-[var(--border)] bg-[var(--material-shell-bg)]"
      data-testid="pr-review-bar"
    >
      {content}
    </div>
  )
}
