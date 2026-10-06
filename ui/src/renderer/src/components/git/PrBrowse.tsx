import { Button } from '../ui/Button'
import { CheckStateText, CheckStateDot } from '../ui/PullRequestState'
import { PullRequestLabel } from '../ui/PullRequestLabel'
import { RepositoryBrowserFrame, RepositoryFilterPanel, RepositoryFilterToolbar, RepositoryFilterSpacer, RepositorySearchForm, RepositorySearchField, RepositoryResultList, RepositoryLoadingState, RepositoryErrorMessage, RepositoryEmptyMessage, RepositoryRowHeading, RepositoryNumber, RepositoryTitle, RepositoryStateLabel, RepositoryRowMeta, RepositoryRefSummary, RepositoryLabels, RepositoryLoadMoreRegion } from '../ui/RepositoryBrowser'
import { useState } from 'react'
import type { PrListItem, PrListInvolvement, PrListState } from '../../houston/client'
import { Icon } from '../ui/Icon'
import { IconLoaderCircle, IconSearch } from '../icons'
import { Segmented } from '../ui/SegmentedControl'
import { Select, type SelectOption } from '../ui/Select'
import { DiffLoadingMark } from '../ui'
import type { PrListController } from './usePrDetailSubscription'
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
    <RepositoryBrowserFrame data-testid="pr-browse">
      <RepositoryFilterPanel>
        <RepositoryFilterToolbar>
          <Segmented
            aria-label="Pull request state"
            value={list.state}
            onChange={(value) => list.setFilters({ state: value })}
            options={STATES.map((state) => ({
              ...state,
              testId: `pr-browse-state-${state.value}`
            }))}
          />
          <RepositoryFilterSpacer>
            <Select
              aria-label="Pull request involvement"
              data-testid="pr-browse-involvement"
              value={list.involvement}
              options={INVOLVEMENTS}
              onChange={(value) =>
                list.setFilters({ involvement: value as PrListInvolvement })
              }
            />
          </RepositoryFilterSpacer>
          {onBack && (
            <Button variant="compact-action"
              type="button"
              data-testid="pr-browse-back"
              onClick={onBack}
            >
              Back
            </Button>
          )}
        </RepositoryFilterToolbar>
        <RepositorySearchForm
          onSubmit={(e) => {
            e.preventDefault()
            list.setFilters({ query: queryDraft })
          }}
        >
          <RepositorySearchField
            data-testid="pr-browse-query"
            aria-label="Search pull requests"
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="Search"
          />
          <Button variant="compact-control"
            type="submit"
            aria-label="Search"
            data-testid="pr-browse-search"
          >
            <Icon glyph={IconSearch} role="small" />
          </Button>
        </RepositorySearchForm>
      </RepositoryFilterPanel>
      <RepositoryResultList>
        {list.busy && list.items === null && (
          <RepositoryLoadingState data-testid="pr-browse-loading">
            <DiffLoadingMark>
              <Icon glyph={IconLoaderCircle} role="subhead" />
            </DiffLoadingMark>
          </RepositoryLoadingState>
        )}
        {list.message !== null && (
          <RepositoryErrorMessage data-testid="pr-browse-message">
            {list.message}
          </RepositoryErrorMessage>
        )}
        {list.items !== null && list.items.length === 0 && (
          <RepositoryEmptyMessage data-testid="pr-browse-empty">
            No pull requests match this view.
          </RepositoryEmptyMessage>
        )}
        {list.items?.map((item) => (
          <Button
            key={item.number}
            type="button"
            data-testid={`pr-browse-row-${item.number}`}
            onClick={() => onSelect(item.number)}
            variant="repository-list-row"
          >
            <RepositoryRowHeading>
              <RepositoryNumber>
                #{item.number}
              </RepositoryNumber>
              <RepositoryTitle>
                {item.title}
              </RepositoryTitle>
              <RepositoryStateLabel>{stateLabel(item)}</RepositoryStateLabel>
            </RepositoryRowHeading>
            <RepositoryRowMeta>
              <RepositoryRefSummary>
                {item.author ?? 'unknown'} · {item.head_ref} → {item.base_ref}
              </RepositoryRefSummary>
              <CheckStateText state={item.checks} layout="inline">
                <CheckStateDot state={item.checks} size="check" runningTone="warn" />
                {item.checks ?? 'no checks'}
              </CheckStateText>
            </RepositoryRowMeta>
            {item.labels.length > 0 && (
              <RepositoryLabels>
                {item.labels.map((label) => (
                  <PullRequestLabel
                    key={label.name}
                  >
                    {label.name}
                  </PullRequestLabel>
                ))}
              </RepositoryLabels>
            )}
          </Button>
        ))}
        {list.truncated && (
          <RepositoryLoadMoreRegion>
            <Button variant="repository-load-more-action"
              type="button"
              data-testid="pr-browse-more"
              disabled={list.loadingMore}
              onClick={list.loadMore}
            >
              {list.loadingMore ? (
                <DiffLoadingMark>
                  <Icon glyph={IconLoaderCircle} role="small" />
                </DiffLoadingMark>
              ) : (
                'Load more'
              )}
            </Button>
          </RepositoryLoadMoreRegion>
        )}
      </RepositoryResultList>
    </RepositoryBrowserFrame>
  )
}
