import { useState } from 'react'
import type { PrListItem, PrListInvolvement, PrListState } from '../../houston/client'
import { BTN_GHOST, BTN_SECONDARY } from '../buttonChrome'
import { Icon } from '../Icon'
import { IconLoaderCircle, IconSearch } from '../icons'
import { Segmented } from '../Segmented'
import { Select, type SelectOption } from '../Select'
import { SPIN_CLASS } from './DiffBody'
import type { PrListController } from './usePrDetailSubscription'

const SMALL = 'text-[length:var(--tr-text-small-size)]'
const ACTION = 'inline-flex items-center gap-1.5'
const ERROR_LINE =
  'text-[length:var(--tr-text-small-size)] text-[var(--danger)] break-words [overflow-wrap:anywhere]'
const ROW_BTN =
  'w-full flex flex-col gap-0.5 px-2.5 py-2 bg-transparent border-0 border-t border-t-[var(--divider)] first:border-t-0 text-left hover:bg-[var(--card-hover)] focus-visible:outline-none focus-visible:bg-[var(--card-hover)]'

const STATES: readonly { value: PrListState; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' }
]

const INVOLVEMENTS: readonly SelectOption[] = [
  { value: 'all', label: 'Anyone' },
  { value: 'authored', label: 'Mine' },
  { value: 'reviewing', label: 'Reviewing' }
]

function stateLabel(item: PrListItem): string {
  if (item.state === 'merged') return 'Merged'
  if (item.state === 'closed') return 'Closed'
  return item.is_draft ? 'Draft' : 'Open'
}

function checkTone(checks: PrListItem['checks']): string {
  switch (checks) {
    case 'passing':
      return 'text-[var(--ok)]'
    case 'failing':
      return 'text-[var(--danger)]'
    case 'running':
      return 'text-[var(--warn)]'
    default:
      return 'text-[var(--text-faint)]'
  }
}

function checkDotTone(checks: PrListItem['checks']): string {
  switch (checks) {
    case 'passing':
      return 'bg-[var(--ok)]'
    case 'failing':
      return 'bg-[var(--danger)]'
    case 'running':
      return 'bg-[var(--warn)]'
    default:
      return 'bg-[var(--text-faint)]'
  }
}

export function PrBrowse({
  list,
  active,
  onSelect,
  onBack
}: {
  list: PrListController
  active: boolean
  onSelect: (number: number) => void
  onBack?: () => void
}): React.JSX.Element {
  const [queryDraft, setQueryDraft] = useState(list.query)

  if (!active) return <div className="flex-1" />
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="pr-browse">
      <div className="flex flex-col gap-2 p-2.5 border-b border-b-[var(--border)]">
        <div className="flex items-center gap-1 flex-wrap">
          <Segmented
            aria-label="Pull request state"
            value={list.state}
            onChange={(value) => list.setFilters({ state: value })}
            options={STATES.map((state) => ({
              ...state,
              testId: `pr-browse-state-${state.value}`
            }))}
          />
          <span className="ml-auto">
            <Select
              aria-label="Pull request involvement"
              data-testid="pr-browse-involvement"
              value={list.involvement}
              options={INVOLVEMENTS}
              onChange={(value) =>
                list.setFilters({ involvement: value as PrListInvolvement })
              }
            />
          </span>
          {onBack && (
            <button
              type="button"
              data-testid="pr-browse-back"
              onClick={onBack}
              className={`btn ${BTN_GHOST} ${ACTION} h-[var(--h-ctl-mini)] px-1.5 ${SMALL} text-[var(--text-muted)]`}
            >
              Back
            </button>
          )}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            list.setFilters({ query: queryDraft })
          }}
        >
          <input
            data-testid="pr-browse-query"
            aria-label="Search pull requests"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="Search"
            className={`h-[var(--h-ctl)] flex-1 min-w-0 px-2 rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] ${SMALL} text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-visible:outline-none focus-visible:border-[var(--border-focus)]`}
          />
          <button
            type="submit"
            aria-label="Search"
            data-testid="pr-browse-search"
            className={`btn ${BTN_SECONDARY} ${ACTION} h-[var(--h-ctl)] px-2`}
          >
            <Icon glyph={IconSearch} role="small" />
          </button>
        </form>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:thin]">
        {list.busy && list.items === null && (
          <div className="flex items-center justify-center p-6" data-testid="pr-browse-loading">
            <span className={SPIN_CLASS}>
              <Icon glyph={IconLoaderCircle} role="subhead" />
            </span>
          </div>
        )}
        {list.message !== null && (
          <div className={`p-3 ${ERROR_LINE}`} data-testid="pr-browse-message">
            {list.message}
          </div>
        )}
        {list.items !== null && list.items.length === 0 && (
          <div className={`p-3 ${SMALL} text-[var(--text-muted)]`} data-testid="pr-browse-empty">
            No pull requests match this view.
          </div>
        )}
        {list.items?.map((item) => (
          <button
            key={item.number}
            type="button"
            data-testid={`pr-browse-row-${item.number}`}
            onClick={() => onSelect(item.number)}
            className={ROW_BTN}
          >
            <div className="flex items-center gap-2">
              <span className={`flex-none font-mono ${SMALL} text-[var(--text-faint)]`}>
                #{item.number}
              </span>
              <span className="flex-1 min-w-0 truncate text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">
                {item.title}
              </span>
              <span className={`flex-none ${SMALL} text-[var(--text-muted)]`}>{stateLabel(item)}</span>
            </div>
            <div className={`flex items-center gap-2 ${SMALL} text-[var(--text-faint)]`}>
              <span className="min-w-0 truncate">
                {item.author ?? 'unknown'} · {item.head_ref} → {item.base_ref}
              </span>
              <span className={`flex-none inline-flex items-center gap-1 font-mono ${checkTone(item.checks)}`}>
                <span className={`h-[7px] w-[7px] rounded-full ${checkDotTone(item.checks)}`} aria-hidden />
                {item.checks ?? 'no checks'}
              </span>
            </div>
            {item.labels.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {item.labels.map((label) => (
                  <span
                    key={label.name}
                    className="px-1.5 rounded-[var(--tr-radius-pill)] border border-[var(--border)] text-[length:var(--tr-text-label-size)] text-[var(--text-muted)]"
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
        {list.truncated && (
          <div className="p-2.5 border-t border-t-[var(--divider)]">
            <button
              type="button"
              data-testid="pr-browse-more"
              disabled={list.loadingMore}
              onClick={list.loadMore}
              className={`btn ${ACTION} ${BTN_SECONDARY} disabled:opacity-55`}
            >
              {list.loadingMore ? (
                <span className={SPIN_CLASS}>
                  <Icon glyph={IconLoaderCircle} role="small" />
                </span>
              ) : (
                'Load more'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
