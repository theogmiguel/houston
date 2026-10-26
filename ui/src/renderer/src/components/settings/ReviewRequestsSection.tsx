import type { HoustonClient } from '../../houston/client'
import type { ReviewRequestMode } from '../../houston/generated/ReviewRequestMode'
import { useReviewRequests } from '../../houston/useReviewRequests'
import { setRailView } from '../../railView'
import { setSettingsOpen } from '../../settingsNav'
import { requestPrsView } from '../prs/prsView'
import { Button, Notice, Text } from '../ui'
import { Segmented } from '../ui/SegmentedControl'
import { SettingsList } from '../ui/settingsPrimitives'
import { Row, SubHead } from './shared'

const MODE_OPTIONS: { value: ReviewRequestMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'notify', label: 'Notify' },
  { value: 'review', label: 'Review' }
]

const MODE_LABEL: Readonly<Record<ReviewRequestMode, string>> = {
  off: 'Off',
  notify: 'Notify',
  review: 'Review'
}

/** Settings ▸ Workspaces: the global GitHub review-request queue. The list lives
 *  on the Pull requests surface; this only sets how much Houston may do. */
export function ReviewRequestsSection({ client }: { client?: HoustonClient | null }): React.JSX.Element {
  const daemonClient = client ?? null
  const { state, setMode } = useReviewRequests(daemonClient)
  const mode = state?.mode ?? null
  return (
    <>
      <SubHead>Review requests</SubHead>
      <SettingsList>
        <Row
          title="Review requests"
          desc={
            <div className="grid gap-[var(--space-1)]">
              <span>Off: nothing is requested.</span>
              <span>Notify: every 2 minutes Houston asks GitHub (through your gh login) which pull requests await your review, reads their size and files, and tells you.</span>
              <span>Review: additionally starts a read-only review pane with the workspace&apos;s default agent for medium and large ones, which sends the diff to that agent&apos;s provider. Houston never approves or posts anything.</span>
            </div>
          }
        >
          <div className="grid justify-items-end gap-[var(--space-1)]">
            <Segmented
              aria-label="Review requests"
              value={mode ?? undefined}
              loading={daemonClient !== null && state === null}
              options={MODE_OPTIONS.map((option) => ({
                ...option,
                disabled: daemonClient === null,
                disabledReason: daemonClient === null ? 'Connect to the daemon to change review requests' : undefined,
                testId: `settings-review-requests-${option.value}`
              }))}
              onChange={(value) => setMode(value as ReviewRequestMode)}
            />
            <Text size="caption" tone="muted">{mode === null ? 'Loading…' : `Currently ${MODE_LABEL[mode]}`}</Text>
          </div>
        </Row>
        <Row title="Queue" desc="New requests appear on the Pull requests surface, with the reasons triage gave each one.">
          <Button
            variant="secondary"
            size="sm"
            disabled={daemonClient === null}
            data-testid="settings-review-requests-open"
            onClick={() => { setSettingsOpen(false); requestPrsView({ view: 'review-requests' }); setRailView('prs') }}
          >
            Open review requests
          </Button>
        </Row>
      </SettingsList>
      {state?.pausedUntilMs != null && (
        <Notice tone="warn" data-testid="settings-review-requests-paused">
          GitHub asked Houston to wait until {new Date(state.pausedUntilMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} before the next request.
        </Notice>
      )}
      {state?.note && <Notice tone="info" data-testid="settings-review-requests-note">{state.note}</Notice>}
    </>
  )
}
