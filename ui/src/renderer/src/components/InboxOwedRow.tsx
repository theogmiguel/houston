import { useEffect, useState } from 'react'
import type { InboxRow, SessionInfo } from '../houston/client'
import { fmtAgo } from '../noticeFeed'
import {
  inboxFromLabel,
  inboxJumpTarget,
  inboxTargetLabel,
  inboxWhyLabel,
  RESOLVABLE_INBOX_KINDS,
  severityForInboxKind
} from '../inboxOwed'
import { NOTICE_SEVERITY, NoticeSeverityChip } from './noticeSeverity'
import { ProvisionalMarker } from './DelegationCard'
import { BELL_GHOST, BELL_ITEM_GHOST, BTN_GHOST, LINK_INLINE } from './buttonChrome'

export function InboxOwedRow({
  row,
  sessions,
  correctedBy,
  flash,
  onAck,
  onResolve,
  onJump,
  onFlashCorrection
}: {
  row: InboxRow
  sessions: ReadonlyMap<number, SessionInfo>
  correctedBy: bigint | null
  flash: boolean
  onAck: (id: bigint) => void
  onResolve: (id: bigint) => void
  onJump: (workspace: string, session: number) => void
  onFlashCorrection: (id: bigint) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const unread = row.delivered_at == null
  const severity = severityForInboxKind(row.kind)
  const tone = NOTICE_SEVERITY[severity].tone
  const from = inboxFromLabel(row, sessions)
  const target = inboxTargetLabel(row, sessions)
  const why = inboxWhyLabel(row.reason)
  const jump = inboxJumpTarget(row, sessions)
  const corrected = correctedBy != null

  // `?.` on both the element and the method: jsdom implements no scrolling, and a
  // flash must never throw just because nothing can be scrolled.
  useEffect(() => {
    if (!flash) return
    document
      .getElementById(`owed-row-${String(row.id)}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [flash, row.id])

  return (
    <div
      id={`owed-row-${String(row.id)}`}
      data-testid={`owed-row-${String(row.id)}`}
      className={`bell-item py-2 px-3 border-b border-b-[var(--divider)] last:border-b-0 [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ${unread ? 'border-l-2' : ''} flex flex-col gap-[3px]`}
      style={
        flash
          ? { background: 'var(--selected-fill)' }
          : unread
            ? {
                borderLeftColor: tone,
                background: `color-mix(in srgb, ${tone} 8%, transparent)`
              }
            : undefined
      }
    >
      <div className="text-[var(--text-secondary)]">
        <b className="text-[var(--text-primary)]">
          [{row.kind}] {from}
          {target != null ? ` → ${target}` : ''}
        </b>{' '}
        <span className={corrected ? 'line-through' : undefined}>{row.summary}</span>
        {correctedBy != null && (
          <>
            {' '}
            <button
              type="button"
              className={LINK_INLINE}
              onClick={() => onFlashCorrection(correctedBy)}
            >
              corrected by #{String(correctedBy)}
            </button>
          </>
        )}
        {row.corrects != null && (
          <span className="text-[var(--text-faint)]"> corrects #{String(row.corrects)}</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <NoticeSeverityChip severity={severity} />
        {row.provisional && <ProvisionalMarker />}
        {why != null && (
          <span className="inline-flex items-center gap-[3px] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] shrink-0 text-[var(--text-muted)]">
            {why}
          </span>
        )}
        <span className="text-[var(--text-faint)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] mr-auto tabular-nums">
          {fmtAgo(Number(row.created_at))}
        </span>
        <button
          type="button"
          className={`btn ${BTN_GHOST} ${BELL_ITEM_GHOST} [-webkit-app-region:no-drag]`}
          onClick={() => {
            if (unread) onAck(row.id)
            setOpen((cur) => !cur)
          }}
        >
          Open
        </button>
        {RESOLVABLE_INBOX_KINDS.has(row.kind) && (
          <button
            type="button"
            className={`btn ${BTN_GHOST} ${BELL_ITEM_GHOST} [-webkit-app-region:no-drag]`}
            onClick={() => onResolve(row.id)}
          >
            Resolve
          </button>
        )}
        {jump != null && (
          <button
            type="button"
            className={`btn ${BTN_GHOST} ${BELL_ITEM_GHOST} [-webkit-app-region:no-drag]`}
            onClick={() => onJump(jump.workspace, jump.session)}
          >
            Jump to pane
          </button>
        )}
      </div>
      {open && (
        <div className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1.5 text-[var(--text-secondary)]">
          {row.body.trim() !== '' && <div>{row.body}</div>}
          {row.artifacts.map((path) => (
            <span
              key={path}
              className="block font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-muted)] [overflow-wrap:anywhere]"
            >
              {path}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function BellClearAllButton({ onClear }: { onClear: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`btn ${BTN_GHOST} ${BELL_GHOST} [-webkit-app-region:no-drag]`}
      onClick={onClear}
    >
      Clear all
    </button>
  )
}

export function OwedInboxSection({
  rows,
  sessions,
  correctedBy,
  flashId,
  onAck,
  onResolve,
  onJump,
  onFlashCorrection
}: {
  rows: InboxRow[]
  sessions: ReadonlyMap<number, SessionInfo>
  correctedBy: ReadonlyMap<string, bigint>
  flashId: bigint | null
  onAck: (id: bigint) => void
  onResolve: (id: bigint) => void
  onJump: (workspace: string, session: number) => void
  onFlashCorrection: (id: bigint) => void
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <>
      <h2
        className="m-0 px-3 pt-2 pb-1 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase"
        style={{ color: 'var(--warning)' }}
      >
        Owed to you
      </h2>
      {rows.map((r) => (
        <InboxOwedRow
          key={String(r.id)}
          row={r}
          sessions={sessions}
          correctedBy={correctedBy.get(String(r.id)) ?? null}
          flash={flashId === r.id}
          onAck={onAck}
          onResolve={onResolve}
          onJump={onJump}
          onFlashCorrection={onFlashCorrection}
        />
      ))}
    </>
  )
}
