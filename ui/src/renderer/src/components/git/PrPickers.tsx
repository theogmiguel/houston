import { PrTab, PR_FLOATING_CANDIDATES } from '../ui/PrTab'
import { ReviewButton } from '../ui/ReviewButtonRoles'
import { MetadataRow } from '../ui/MetadataRow'
import { Text } from '../ui/Text'
import { PullRequestLabel } from '../ui/PullRequestLabel'
import { OptionCandidateList } from '../ui/OptionCandidateList'
import { ReactionList, ReactionOptionList, PickerSection, PickerFieldLabel, ReviewerValue, CandidateCheck, CandidateName, CandidateStatus, CandidateDescription, CandidateEmptyMessage, PickerErrorMessage, CandidateActions, LabelSummaryRow, LabelSummary } from '../ui/PullRequestPickers'
import { useEffect, useState } from 'react'
import type {
  PrDetail,
  PrLabelCandidate,
  PrReviewer,
  PrReviewerCandidate
} from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconCheck, IconClose, IconLoaderCircle, IconPlus, IconTag, IconUser, IconUsers } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import { DiffLoadingMark } from '../ui'
import {
  REACTION_GLYPH,
  REACTION_LABEL,
  REACTION_ORDER,
  reviewerKey,
  reviewerName,
  requestedReviewers
} from './prDetailUi'
export function PrReactions({
  reactions,
  busy,
  onToggle
}: {
  reactions: PrDetail['reactions']
  busy: boolean
  onToggle: (content: PrDetail['reactions'][number]['content'], reacted: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <ReactionList data-testid="pr-reactions">
      {reactions.map((r) => (
        <Tooltip key={r.content} label={`${r.count} reacted`}>
          <ReviewButton variant="reaction" selected={r.reacted}
            type="button"
            data-testid={`pr-reaction-${r.content}`}
            aria-pressed={r.reacted}
            disabled={busy}
            onClick={() => onToggle(r.content, !r.reacted)}
          >
            <span aria-hidden>{REACTION_GLYPH[r.content]}</span>
            <Text mono tabular>{r.count}</Text>
          </ReviewButton>
        </Tooltip>
      ))}
      <Tooltip label="Add a reaction">
        <ReviewButton variant="compact-action"
          type="button"
          data-testid="pr-reaction-add"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon glyph={IconPlus} role="small" />
        </ReviewButton>
      </Tooltip>
      {open && (
        <ReactionOptionList data-testid="pr-reaction-picker">
          {REACTION_ORDER.map((content) => (
            <Tooltip key={content} label={REACTION_LABEL[content]}>
            <ReviewButton variant="reaction-option"
              type="button"
              aria-label={REACTION_LABEL[content]}
              data-testid={`pr-reaction-pick-${content}`}
              disabled={busy}
              onClick={() => {
                setOpen(false)
                onToggle(content, false)
              }}
            >
              <span aria-hidden>{REACTION_GLYPH[content]}</span>
            </ReviewButton>
            </Tooltip>
          ))}
        </ReactionOptionList>
      )}
    </ReactionList>
  )
}

export function PrReviewerPicker({
  detail,
  busy,
  candidates,
  loading,
  message,
  onLoad,
  onApply,
  open: openProp,
  onOpenChange,
  compact = false
}: {
  detail: PrDetail
  busy: boolean
  candidates: PrReviewerCandidate[] | null
  loading: boolean
  message: string | null
  onLoad: () => void
  onApply: (added: PrReviewer[], removed: PrReviewer[]) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  compact?: boolean
}): React.JSX.Element {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const setOpen = (next: boolean): void => {
    setOpenState(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open || candidates === null) return
    setSelected(
      new Set(candidates.filter((c) => c.is_requested).map((c) => reviewerKey(c)))
    )
  }, [open, candidates])

  const toggle = (candidate: PrReviewerCandidate): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      const key = reviewerKey(candidate)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const apply = (): void => {
    if (candidates === null) return
    const added = candidates.filter(
      (c) => selected.has(reviewerKey(c)) && !c.is_requested
    )
    const removed = candidates.filter(
      (c) => !selected.has(reviewerKey(c)) && c.is_requested
    )
    setOpen(false)
    onApply(
      added.map((c) => ({ id: c.id, kind: c.kind })),
      removed.map((c) => ({ id: c.id, kind: c.kind }))
    )
  }

  return (
    <PickerSection data-testid="pr-reviewers">
      <MetadataRow>
        <PickerFieldLabel>{compact && <Icon glyph={IconUsers} role="small" />}Reviewers</PickerFieldLabel>
        <ReviewerValue data-testid="pr-reviewers-value">
          {detail.reviewers.length === 0 ? (compact ? 'None' : 'none requested') : requestedReviewers(detail.reviewers)}
        </ReviewerValue>
        <Tooltip label={compact ? 'Add reviewer' : 'Manage reviewers'}>
        <ReviewButton variant="compact-action"
          type="button"
          data-testid="pr-reviewers-manage"
          aria-label="Add reviewer"
          disabled={busy || loading}
          onClick={() => {
            if (!open) onLoad()
            setOpen(!open)
          }}
        >
          {loading ? (
            <DiffLoadingMark>
              <Icon glyph={IconLoaderCircle} role="small" />
            </DiffLoadingMark>
          ) : (
            compact ? <><Icon glyph={IconUser} role="small" /><Icon glyph={IconPlus} role="small" /></> : 'Manage'
          )}
        </ReviewButton>
        </Tooltip>
      </MetadataRow>
      {message !== null && <PickerErrorMessage>{message}</PickerErrorMessage>}
      {open && candidates !== null && (
        <OptionCandidateList scrollable={false} className={PR_FLOATING_CANDIDATES}
          data-testid="pr-reviewer-candidates"
        >
          {candidates.map((c) => {
            const key = reviewerKey(c)
            const isSelected = selected.has(key)
            return (
              <ReviewButton variant="picker-candidate"
                key={key}
                type="button"
                aria-pressed={isSelected}
                data-testid={`pr-reviewer-${key}`}
                disabled={busy}
                onClick={() => toggle(c)}
              >
                <CandidateCheck>
                  {isSelected ? <Icon glyph={IconCheck} role="small" /> : null}
                </CandidateCheck>
                <CandidateName>{reviewerName(c)}</CandidateName>
                {c.is_requested && (
                  <CandidateStatus>requested</CandidateStatus>
                )}
              </ReviewButton>
            )
          })}
          {candidates.length === 0 && (
            <CandidateEmptyMessage>
              No reviewer candidates were returned.
            </CandidateEmptyMessage>
          )}
          <CandidateActions>
            <ReviewButton variant="primary-action"
              type="button"
              data-testid="pr-reviewers-apply"
              disabled={busy}
              onClick={apply}
            >
              Apply
            </ReviewButton>
            <ReviewButton variant="secondary-action"
              type="button"
              data-testid="pr-reviewers-cancel"
              onClick={() => setOpen(false)}
            >
              Cancel
            </ReviewButton>
          </CandidateActions>
        </OptionCandidateList>
      )}
    </PickerSection>
  )
}

export function PrLabelPicker({
  detail,
  busy,
  candidates,
  loading,
  message,
  onLoad,
  onToggle,
  open: openProp,
  onOpenChange,
  compact = false
}: {
  detail: PrDetail
  busy: boolean
  candidates: PrLabelCandidate[] | null
  loading: boolean
  message: string | null
  onLoad: () => void
  onToggle: (name: string, applied: boolean) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  compact?: boolean
}): React.JSX.Element {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState

  const setOpen = (next: boolean): void => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  return (
    <PickerSection data-testid="pr-labels">
      <LabelSummaryRow>
        <PickerFieldLabel>{compact && <Icon glyph={IconTag} role="small" />}Labels</PickerFieldLabel>
        <LabelSummary data-testid="pr-labels-value">
          {detail.labels.length === 0 ? (
            <Text size="small" tone="primary">{compact ? 'None' : 'none'}</Text>
          ) : (
            detail.labels.map((l) => (
              <PrTab as={PullRequestLabel} surface="pr-label-pill"
                key={l.name}
                selected
                data-testid={`pr-label-${l.name}`}
              >
                <PrTab as="span" surface="pr-label-dot" aria-hidden="true" style={{ backgroundColor: l.color ? `#${l.color.replace(/^#/, '')}` : 'var(--accent)' }} />
                {l.name}
              </PrTab>
            ))
          )}
        </LabelSummary>
        <Tooltip label={compact ? 'Add label' : 'Manage labels'}>
        <ReviewButton variant="compact-action"
          type="button"
          data-testid="pr-labels-manage"
          aria-label="Add label"
          disabled={busy || loading}
          onClick={() => {
            if (!open) onLoad()
            setOpen(!open)
          }}
        >
          {loading ? (
            <DiffLoadingMark>
              <Icon glyph={IconLoaderCircle} role="small" />
            </DiffLoadingMark>
          ) : (
            compact ? <Icon glyph={IconTag} role="small" /> : 'Edit'
          )}
        </ReviewButton>
        </Tooltip>
      </LabelSummaryRow>
      {message !== null && <PickerErrorMessage>{message}</PickerErrorMessage>}
      {open && candidates !== null && (
        <OptionCandidateList data-testid="pr-label-candidates" className={PR_FLOATING_CANDIDATES}>
          {candidates.map((c) => (
            <ReviewButton variant="picker-candidate"
              key={c.name}
              type="button"
              role="option"
              aria-selected={c.is_applied}
              data-testid={`pr-label-candidate-${c.name}`}
              disabled={busy}
              onClick={() => onToggle(c.name, !c.is_applied)}
            >
              <CandidateCheck>
                {c.is_applied ? <Icon glyph={IconCheck} role="small" /> : null}
              </CandidateCheck>
              <CandidateName>{c.name}</CandidateName>
              {c.description !== null && c.description !== undefined && (
                <CandidateDescription>
                  {c.description}
                </CandidateDescription>
              )}
            </ReviewButton>
          ))}
          {candidates.length === 0 && (
            <CandidateEmptyMessage>
              No labels were returned.
            </CandidateEmptyMessage>
          )}
          <CandidateActions align="end">
            <ReviewButton variant="picker-done-action"
              type="button"
              data-testid="pr-labels-close"
              onClick={() => setOpen(false)}
            >
              <Icon glyph={IconClose} role="small" />
              Done
            </ReviewButton>
          </CandidateActions>
        </OptionCandidateList>
      )}
    </PickerSection>
  )
}
