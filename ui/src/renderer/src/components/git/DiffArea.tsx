import { DiffBody } from './DiffBody'
import { DiffBlockedMark, DiffEmptyState, DiffHeader, DiffLoadingMark, DiffPaneSurface, DiffScrollArea } from '../ui'
import type { ChangeRow } from './changes'
import type { DiffState } from './useGitStatusSubscription'
import { IconLoaderCircle, IconShieldAlert } from '../icons'
import { Icon } from '../ui/Icon'
import { BTN_SECONDARY } from '../ui/buttonChrome'
import { EmptyState } from '../ui/ActionEmptyState'

function DiffBodyArea({
  row,
  diff,
  split
}: {
  row: ChangeRow
  diff: DiffState | null
  split?: boolean
}): React.JSX.Element {
  if (row.blocked) {
    return (
      <DiffEmptyState data-testid="changes-blocked-notice" data-tone="blocked">
        <DiffBlockedMark>
          <Icon glyph={IconShieldAlert} role="heading" />
        </DiffBlockedMark>
        Blocked path — {row.path} matches the sensitive-file rule, so its contents are never
        fetched or shown here.
      </DiffEmptyState>
    )
  }
  if (diff === null || diff.path !== row.path) {
    return (
      <DiffEmptyState data-testid="changes-diff-loading">
        <DiffLoadingMark>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </DiffLoadingMark>
        Loading diff…
      </DiffEmptyState>
    )
  }
  if (diff.patch.trim().length === 0) {
    return <DiffEmptyState>No textual diff for this file.</DiffEmptyState>
  }
  return <DiffBody patch={diff.patch} truncated={diff.truncated} split={split} />
}

export function DiffArea({
  row,
  diff,
  emptySummary,
  onReview,
  reviewDisabledReason,
  onOpenInEditor,
  controls,
  split
}: {
  row: ChangeRow | null
  diff: DiffState | null
  split?: boolean
  emptySummary?: { headline: string; description: string }
  onReview?: () => void
  reviewDisabledReason?: string | null
  onOpenInEditor?: () => void
  controls?: React.ReactNode
}): React.JSX.Element {
  if (row === null) {
    return (
      <DiffPaneSurface>
        <DiffScrollArea className="flex-1">
          {emptySummary && onReview ? (
            <EmptyState
              size="compact"
              testId="changes-diff-empty"
              actionTestId="changes-review"
              actionClassName={BTN_SECONDARY}
              headline={emptySummary.headline}
              description={emptySummary.description}
              action={{ label: 'Review with agent', onClick: onReview, disabled: reviewDisabledReason !== null, disabledReason: reviewDisabledReason ?? undefined }}
              surface="shell"
              className="h-full"
            />
          ) : (
            <DiffEmptyState surface="shell">No file diff is selected.</DiffEmptyState>
          )}
        </DiffScrollArea>
      </DiffPaneSurface>
    )
  }
  return (
    <DiffPaneSurface selected>
      <DiffHeader controls={controls} status={row.state} path={row.path} tag={row.tag} added={row.added} deleted={row.deleted} blocked={row.blocked} onOpenInEditor={onOpenInEditor} />
      <DiffScrollArea className="flex-1">
        <DiffBodyArea row={row} diff={diff} split={split} />
      </DiffScrollArea>
    </DiffPaneSurface>
  )
}
