import { DiffBody, DIFF_EMPTY_CLASS, SPIN_CLASS } from './DiffBody'
import type { ChangeRow } from './changes'
import type { DiffState } from './useGitStatusSubscription'
import { IconLoaderCircle, IconShieldAlert } from '../icons'
import { Icon } from '../Icon'
import { BTN_SECONDARY } from '../buttonChrome'
import { EmptyState } from '../EmptyState'

const TAG_CLASS: Record<string, string> = {
  staged: 'bg-[color-mix(in_srgb,var(--success)_16%,transparent)] text-[var(--success)]',
  unstaged: 'bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] text-[var(--text-muted)]',
  untracked: 'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)]',
  conflict: 'bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)]',
  blocked: 'bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] text-[var(--danger)]'
}

const TAG_BASE =
  'flex-none ml-auto px-1.5 rounded-[var(--tr-radius-pill)] font-mono text-[length:var(--tr-text-xs)] font-semibold leading-4'

const SCROLL = 'min-h-0 overflow-y-auto [scrollbar-width:thin]'

function DiffHeader({ row }: { row: ChangeRow }): React.JSX.Element {
  return (
    <div className="flex-none flex items-center gap-2 px-2.5 py-1 border-b border-b-[var(--divider)] bg-[var(--card-bg)] font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">
      <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{row.path}</span>
      <span className={`${TAG_BASE} ml-0 ${TAG_CLASS[row.tag]}`}>{row.tag}</span>
      {!row.blocked && (row.added !== null || row.deleted !== null) && (
        <span className="ml-auto font-medium" data-testid="changes-diff-counts">
          {row.added !== null && <span className="text-[var(--success)]">+{row.added}</span>}{' '}
          {row.deleted !== null && <span className="text-[var(--danger)]">−{row.deleted}</span>}
        </span>
      )}
    </div>
  )
}

function DiffBodyArea({
  row,
  diff
}: {
  row: ChangeRow
  diff: DiffState | null
}): React.JSX.Element {
  if (row.blocked) {
    return (
      <div className={DIFF_EMPTY_CLASS} data-testid="changes-blocked-notice" data-tone="blocked">
        <span className="text-[var(--danger)]">
          <Icon glyph={IconShieldAlert} role="heading" />
        </span>
        Blocked path — {row.path} matches the sensitive-file rule, so its contents are never
        fetched or shown here.
      </div>
    )
  }
  if (diff === null || diff.path !== row.path) {
    return (
      <div className={DIFF_EMPTY_CLASS} data-testid="changes-diff-loading">
        <span className={SPIN_CLASS}>
          <Icon glyph={IconLoaderCircle} role="subhead" />
        </span>
        Loading diff…
      </div>
    )
  }
  if (diff.patch.trim().length === 0) {
    return <div className={DIFF_EMPTY_CLASS}>No textual diff for this file.</div>
  }
  return <DiffBody patch={diff.patch} truncated={diff.truncated} />
}

export function DiffArea({
  row,
  diff,
  emptySummary,
  onReview,
  reviewDisabledReason
}: {
  row: ChangeRow | null
  diff: DiffState | null
  emptySummary?: { headline: string; description: string }
  onReview?: () => void
  reviewDisabledReason?: string | null
}): React.JSX.Element {
  if (row === null) {
    return (
      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--content-bg)]">
        <div className={`${SCROLL} flex-1`}>
          {emptySummary && onReview ? (
            <EmptyState
              size="compact"
              testId="changes-diff-empty"
              actionTestId="changes-review"
              actionClassName={BTN_SECONDARY}
              headline={emptySummary.headline}
              description={emptySummary.description}
              action={{ label: 'Review with agent', onClick: onReview, disabled: reviewDisabledReason !== null, disabledReason: reviewDisabledReason ?? undefined }}
              className="h-full bg-[var(--material-shell-bg)]"
            />
          ) : (
            <div className={`${DIFF_EMPTY_CLASS} bg-[var(--material-shell-bg)]`}>No file diff is selected.</div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-[var(--content-bg)]">
      <DiffHeader row={row} />
      <div className={`${SCROLL} flex-1 bg-[var(--tool-code-bg)]`}>
        <DiffBodyArea row={row} diff={diff} />
      </div>
    </div>
  )
}
