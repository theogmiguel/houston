import { useEffect, useState } from 'react'
import type {
  PrDetail,
  PrLabelCandidate,
  PrReviewer,
  PrReviewerCandidate
} from '../../houston/client'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from '../buttonChrome'
import { Icon } from '../Icon'
import { IconCheck, IconClose, IconLoaderCircle, IconPlus } from '../icons'
import { Tooltip } from '../Tooltip'
import { SPIN_CLASS } from './DiffBody'
import {
  REACTION_GLYPH,
  REACTION_LABEL,
  REACTION_ORDER,
  reviewerKey,
  reviewerName,
  requestedReviewers
} from './prDetailUi'
import { META_ROW_CLS } from './scmChrome'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const LABEL =
  'flex-none text-[length:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)]'
const ERROR_LINE =
  'text-[length:var(--tr-text-small-size)] text-[var(--danger)] break-words [overflow-wrap:anywhere]'
const ROW_BTN =
  'w-full flex items-center gap-2 px-2 py-1 bg-transparent border-0 text-left hover:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]'

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
    <span className="inline-flex items-center gap-1 flex-wrap" data-testid="pr-reactions">
      {reactions.map((r) => (
        <Tooltip key={r.content} label={`${r.count} reacted`}>
          <button
            type="button"
            data-testid={`pr-reaction-${r.content}`}
            aria-pressed={r.reacted}
            disabled={busy}
            onClick={() => onToggle(r.content, !r.reacted)}
            className={`inline-flex items-center gap-1 h-[var(--h-ctl-mini)] px-1.5 rounded-[var(--tr-radius-pill)] border text-[length:var(--tr-text-small-size)] disabled:opacity-55 ${
              r.reacted
                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text-primary)]'
                : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span aria-hidden>{REACTION_GLYPH[r.content]}</span>
            <span className="font-mono tabular-nums">{r.count}</span>
          </button>
        </Tooltip>
      ))}
      <Tooltip label="Add a reaction">
        <button
          type="button"
          data-testid="pr-reaction-add"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 text-[var(--text-muted)]`}
        >
          <Icon glyph={IconPlus} role="small" />
        </button>
      </Tooltip>
      {open && (
        <span className="inline-flex items-center gap-0.5" data-testid="pr-reaction-picker">
          {REACTION_ORDER.map((content) => (
            <button
              key={content}
              type="button"
              aria-label={REACTION_LABEL[content]}
              data-testid={`pr-reaction-pick-${content}`}
              disabled={busy}
              onClick={() => {
                setOpen(false)
                onToggle(content, false)
              }}
              className={`btn ${BTN_GHOST} h-[var(--h-ctl-mini)] px-1 leading-none disabled:opacity-55`}
            >
              <span aria-hidden>{REACTION_GLYPH[content]}</span>
            </button>
          ))}
        </span>
      )}
    </span>
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
  onOpenChange
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
    <div className="flex flex-col gap-1" data-testid="pr-reviewers">
      <div className={META_ROW_CLS}>
        <span className={`${LABEL} w-[92px]`}>Reviewers</span>
        <span className={`min-w-0 flex-1 ${SMALL} text-[var(--text-primary)]`} data-testid="pr-reviewers-value">
          {detail.reviewers.length === 0 ? 'none requested' : requestedReviewers(detail.reviewers)}
        </span>
        <button
          type="button"
          data-testid="pr-reviewers-manage"
          disabled={busy || loading}
          onClick={() => {
            if (!open) onLoad()
            setOpen(!open)
          }}
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)] disabled:opacity-55`}
        >
          {loading ? (
            <span className={SPIN_CLASS}>
              <Icon glyph={IconLoaderCircle} role="small" />
            </span>
          ) : (
            'Manage'
          )}
        </button>
      </div>
      {message !== null && <div className={ERROR_LINE}>{message}</div>}
      {open && candidates !== null && (
        <div
          className="border border-[var(--border)] rounded-[var(--tr-radius-sm)] overflow-hidden flex flex-col bg-[var(--content-bg)]"
          data-testid="pr-reviewer-candidates"
        >
          {candidates.map((c) => {
            const key = reviewerKey(c)
            const isSelected = selected.has(key)
            return (
              <button
                key={key}
                type="button"
                aria-pressed={isSelected}
                data-testid={`pr-reviewer-${key}`}
                disabled={busy}
                onClick={() => toggle(c)}
                className={`${ROW_BTN} ${SMALL} text-[var(--text-primary)] disabled:opacity-55`}
              >
                <span className="flex-none w-3.5 inline-flex justify-center text-[var(--accent)]">
                  {isSelected ? <Icon glyph={IconCheck} role="small" /> : null}
                </span>
                <span className="flex-1 min-w-0 truncate">{reviewerName(c)}</span>
                {c.is_requested && (
                  <span className="flex-none text-[var(--text-faint)]">requested</span>
                )}
              </button>
            )
          })}
          {candidates.length === 0 && (
            <div className={`px-2 py-1.5 ${SMALL} text-[var(--text-muted)]`}>
              No reviewer candidates were returned.
            </div>
          )}
          <div className="flex items-center gap-2 p-1.5 border-t border-t-[var(--divider)]">
            <button
              type="button"
              data-testid="pr-reviewers-apply"
              disabled={busy}
              onClick={apply}
              className={`btn ${ACTION} ${BTN_PRIMARY} disabled:opacity-55`}
            >
              Apply
            </button>
            <button
              type="button"
              data-testid="pr-reviewers-cancel"
              onClick={() => setOpen(false)}
              className={`btn ${ACTION} ${BTN_SECONDARY}`}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
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
  onOpenChange
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
}): React.JSX.Element {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState

  const setOpen = (next: boolean): void => {
    setOpenState(next)
    onOpenChange?.(next)
  }
  return (
    <div className="flex flex-col gap-1" data-testid="pr-labels">
      <div className={`${META_ROW_CLS} flex-wrap`}>
        <span className={`${LABEL} w-[92px]`}>Labels</span>
        <span className="min-w-0 flex-1 inline-flex items-center gap-1 flex-wrap" data-testid="pr-labels-value">
          {detail.labels.length === 0 ? (
            <span className={`${SMALL} text-[var(--text-primary)]`}>none</span>
          ) : (
            detail.labels.map((l) => (
              <span
                key={l.name}
                data-testid={`pr-label-${l.name}`}
                className="px-1.5 rounded-[var(--tr-radius-pill)] border border-[var(--border)] text-[length:var(--tr-text-label-size)] text-[var(--text-primary)]"
              >
                {l.name}
              </span>
            ))
          )}
        </span>
        <button
          type="button"
          data-testid="pr-labels-manage"
          disabled={busy || loading}
          onClick={() => {
            if (!open) onLoad()
            setOpen(!open)
          }}
          className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)] disabled:opacity-55`}
        >
          {loading ? (
            <span className={SPIN_CLASS}>
              <Icon glyph={IconLoaderCircle} role="small" />
            </span>
          ) : (
            'Edit'
          )}
        </button>
      </div>
      {message !== null && <div className={ERROR_LINE}>{message}</div>}
      {open && candidates !== null && (
        <div
          className="border border-[var(--border)] rounded-[var(--tr-radius-sm)] overflow-hidden flex flex-col max-h-[240px] overflow-y-auto [scrollbar-width:thin] bg-[var(--content-bg)]"
          data-testid="pr-label-candidates"
        >
          {candidates.map((c) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={c.is_applied}
              data-testid={`pr-label-candidate-${c.name}`}
              disabled={busy}
              onClick={() => onToggle(c.name, !c.is_applied)}
              className={`${ROW_BTN} ${SMALL} text-[var(--text-primary)] disabled:opacity-55`}
            >
              <span className="flex-none w-3.5 inline-flex justify-center text-[var(--accent)]">
                {c.is_applied ? <Icon glyph={IconCheck} role="small" /> : null}
              </span>
              <span className="flex-1 min-w-0 truncate">{c.name}</span>
              {c.description !== null && c.description !== undefined && (
                <span className="flex-none max-w-[40%] truncate text-[var(--text-faint)]">
                  {c.description}
                </span>
              )}
            </button>
          ))}
          {candidates.length === 0 && (
            <div className={`px-2 py-1.5 ${SMALL} text-[var(--text-muted)]`}>
              No labels were returned.
            </div>
          )}
          <div className="flex items-center gap-2 p-1.5 border-t border-t-[var(--divider)]">
            <button
              type="button"
              data-testid="pr-labels-close"
              onClick={() => setOpen(false)}
              className={`btn ${ACTION} ${BTN_SECONDARY} ml-auto`}
            >
              <Icon glyph={IconClose} role="small" />
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
