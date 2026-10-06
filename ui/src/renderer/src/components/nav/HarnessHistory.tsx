import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReviewStatus } from '../../houston/generated/HarnessReviewStatus'
import { Chip, type ChipTone } from '../ui/Chip'
import { DataTable } from '../ui/DataTable'
import { SECONDARY_BUTTON } from './navChrome'
import { REVIEW_STATUS_LABEL, formatDay, formatWindow } from './harnessFormat'

const STATUS_TONE: Record<HarnessReviewStatus, ChipTone> = {
  running: 'info',
  published: 'success',
  failed: 'danger'
}

const RESULT_CLS =
  'block truncate [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-secondary)]'

export function HarnessHistory({
  reviews,
  liveSessions,
  onOpenSession
}: {
  reviews: HarnessReview[]
  liveSessions: { has(id: number): boolean }
  onOpenSession: (sessionId: number) => void
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-[8px]">
      <div className="min-w-0 overflow-x-auto">
          <DataTable
            aria-label="Review runs"
            className="min-w-[1000px]"
            rows={reviews}
            getRowId={(r) => String(r.id)}
            emptySetLabel="No review has run in this workspace yet."
            maxBodyHeight={480}
            columns={[
              {
                key: 'started',
                header: 'Started',
                width: '160px',
                render: (r) => <span className="whitespace-nowrap">{formatDay(r.started_at_ms)}</span>
              },
              {
                key: 'window',
                header: 'Window',
                width: '260px',
                render: (r) => <span className="whitespace-nowrap">{formatWindow(r.window)}</span>
              },
              {
                key: 'sessions',
                header: 'Sessions',
                numeric: true,
                width: '80px',
                render: (r) => (r.sessions == null ? '—' : r.sessions)
              },
              {
                key: 'findings',
                header: 'Findings',
                numeric: true,
                width: '80px',
                render: (r) => (r.status === 'published' ? r.finding_count : '—')
              },
              {
                key: 'status',
                header: 'Status',
                width: '110px',
                render: (r) => (
                  <Chip variant="state" tone={STATUS_TONE[r.status]} label={REVIEW_STATUS_LABEL[r.status]} />
                )
              },
              {
                key: 'result',
                header: 'Result',
                render: (r) => <span className={RESULT_CLS}>{r.error ?? r.summary ?? ''}</span>
              },
              {
                key: 'pane',
                header: 'Pane',
                width: '110px',
                render: (r) =>
                  r.session_id != null && liveSessions.has(r.session_id) ? (
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      onClick={() => onOpenSession(r.session_id as number)}
                    >
                      Open pane
                    </button>
                  ) : (
                    <span className={RESULT_CLS}>Closed</span>
                  )
              }
            ]}
          />
      </div>
      <p className="[font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-[var(--text-faint)]">
        A finished run says what it found; it does not mean the findings are resolved.
      </p>
    </div>
  )
}
