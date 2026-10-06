import type { HarnessReview } from '../../houston/generated/HarnessReview'
import type { HarnessReviewStatus } from '../../houston/generated/HarnessReviewStatus'
import { Chip, type ChipTone } from '../ui/Chip'
import { DataTable } from '../ui/DataTable'
import { FieldActionButton } from '../ui/formPrimitives'
import { SingleLineText, Text } from '../ui'
import { REVIEW_STATUS_LABEL, formatDay, formatWindow } from './harnessFormat'

const STATUS_TONE: Record<HarnessReviewStatus, ChipTone> = {
  running: 'info',
  published: 'success',
  failed: 'danger'
}

function ResultText({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" weight="small" tone="secondary" className="truncate">{children}</Text>
}

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
    <div className="grid min-w-0 gap-[var(--space-2)]">
      <div className="min-w-0 overflow-x-auto">
          <DataTable
            aria-label="Review runs"
            minWidth={1000}
            rows={reviews}
            getRowId={(r) => String(r.id)}
            emptySetLabel="No review has run in this workspace yet."
            maxBodyHeight={480}
            columns={[
              {
                key: 'started',
                header: 'Started',
                width: '160px',
                render: (r) => <SingleLineText>{formatDay(r.started_at_ms)}</SingleLineText>
              },
              {
                key: 'window',
                header: 'Window',
                width: '260px',
                render: (r) => <SingleLineText>{formatWindow(r.window)}</SingleLineText>
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
                render: (r) => <ResultText>{r.error ?? r.summary ?? ''}</ResultText>
              },
              {
                key: 'pane',
                header: 'Pane',
                width: '110px',
                render: (r) =>
                  r.session_id != null && liveSessions.has(r.session_id) ? (
                    <FieldActionButton onClick={() => onOpenSession(r.session_id as number)}>
                      Open pane
                    </FieldActionButton>
                  ) : (
                    <ResultText>Closed</ResultText>
                  )
              }
            ]}
          />
      </div>
      <Text as="p" size="small" weight="small" tone="faint">
        A finished run says what it found; it does not mean the findings are resolved.
      </Text>
    </div>
  )
}
