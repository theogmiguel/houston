import { useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient, PrListItem, PrListState } from '../../houston/client'
import type { PrSort } from '../../houston/generated/PrSort'
import { Icon } from '../ui/Icon'
import { PRS_CLASSES } from '../ui/PrsClasses'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronDown,
  IconEye,
  IconGitPullRequest,
  IconGrid,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconFilter,
  IconAlertTriangle,
  IconPlus,
  IconGlobe,
  IconFolder,
  IconCode,
} from '../icons'
import { PrLink } from '../ui/PrLink'
import { EmptyState } from '../ui/EmptyState'
import { filterPullRequests, groupPullRequests, type PullRequestSort } from './prListModel'
import { PullRequestTab } from '../git/PullRequestTab'
import { PanelTab } from '../ui/PanelTab'
import { ShellElement } from '../ui/ShellPrimitives'
import type { SurfaceKind } from '../../scmPanel'
import '../ui/floatingSurface.css'

export interface PullRequestsScreenProps {
  repoName: string
  workspace: string
  currentUser: string
  items: PrListItem[]
  client?: HoustonClient | null
  directory?: string | null
  selectedNumber?: number | null
  state?: PrListState
  sort?: PrSort
  loading?: boolean
  onStateChange?: (state: PrListState) => void
  onSortChange?: (sort: PrSort) => void
  onRefresh?: () => void
  onOpenPullRequest?: (item: PrListItem) => void
  onCheckoutInWorktree?: (item: PrListItem) => void
  onOpenSurface?: (surface: SurfaceKind) => void
}

type ScreenSort = PullRequestSort
const SORTS: readonly { value: ScreenSort; label: string }[] = [
  { value: 'ready', label: 'Merge readiness' },
  { value: 'blocked', label: 'Blocked on me' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'created', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
]

function relativeAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor(Date.now() / 1000 - timestamp) / 60)
  if (minutes < 60) return `${Math.floor(minutes)}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

function checkState(item: PrListItem): 'passing' | 'failing' | 'running' | 'unknown' {
  return !item.checks || item.checks === 'none' ? 'unknown' : item.checks
}

function CheckStatusIcon({ state }: { state: ReturnType<typeof checkState> }): React.JSX.Element {
  if (state === 'passing') {
    return <span aria-label="Checks passing" className={PRS_CLASSES.PRS_CLASS_1}><svg viewBox="0 0 16 16" className={PRS_CLASSES.PRS_CLASS_2} fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.25" /><path d="m5 8 2 2 4-4" /></svg></span>
  }
  if (state === 'failing') {
    return <span aria-label="Checks failing" className={PRS_CLASSES.PRS_CLASS_3}><svg viewBox="0 0 16 16" className={PRS_CLASSES.PRS_CLASS_2} fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.25" /><path d="m6 6 4 4m0-4-4 4" /></svg></span>
  }
  return <span aria-label={state === PRS_CLASSES.PRS_STATE_RUNNING ? 'Checks running' : 'Checks unavailable'} className={state === PRS_CLASSES.PRS_STATE_RUNNING ? PRS_CLASSES.PRS_CHECK_RUNNING : PRS_CLASSES.PRS_CHECK_UNKNOWN}><svg viewBox="0 0 16 16" className={PRS_CLASSES.PRS_CLASS_2} fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6.25" />{state === PRS_CLASSES.PRS_STATE_RUNNING && <path d="M8 4v4l2.5 1.5" />}</svg></span>
}

function ReviewApprovedIcon(): React.JSX.Element {
  return <span aria-label="Approved" className={PRS_CLASSES.PRS_CLASS_1}><svg viewBox="0 0 16 16" className={PRS_CLASSES.PRS_CLASS_2} fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="5.5" cy="4.5" r="2.25" /><path d="M1.8 12.5c.2-2.2 1.7-3.5 3.7-3.5 1.2 0 2.1.4 2.8 1.2M9 11l1.5 1.5 3-3" /></svg></span>
}

function MergedIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" className={PRS_CLASSES.PRS_CLASS_4} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
}

function PrRow({
  item,
  repoName,
  selected,
  onOpen,
  onContextMenu,
}: {
  item: PrListItem
  repoName: string
  selected: boolean
  onOpen: () => void
  onContextMenu: (event: React.MouseEvent, item: PrListItem) => void
}): React.JSX.Element {
  const check = checkState(item)
  const reviewed = item.review_decision === 'APPROVED'
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${PRS_CLASSES.PRS_PR_ROW} ${selected ? PRS_CLASSES.PRS_PR_ROW_SELECTED : ''}`}
      data-testid={`pr-row-${item.number}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen()
        }
      }}
      onContextMenu={(event) => onContextMenu(event, item)}
    >
      <span
        className={`${PRS_CLASSES.PRS_PR_STATE} ${item.is_draft ? PRS_CLASSES.PRS_PR_STATE_CLOSED : item.state === PRS_CLASSES.PRS_STATE_MERGED ? PRS_CLASSES.PRS_PR_STATE_MERGED : item.state === PRS_CLASSES.PRS_STATE_CLOSED ? PRS_CLASSES.PRS_PR_STATE_CLOSED : PRS_CLASSES.PRS_CLASS_1}`}
      >
        {item.state === 'merged' ? (
          <MergedIcon />
        ) : <Icon glyph={IconGitPullRequest} role="small" />}
        {item.mergeable === 'conflicting' && (
          <Icon glyph={IconAlertTriangle} role="small" className={PRS_CLASSES.PRS_CLASS_5} />
        )}
      </span>
      <span className={PRS_CLASSES.PRS_CLASS_6}>
        <span className={PRS_CLASSES.PRS_CLASS_7}>
          <PrLink href={item.url} onClick={onOpen} className={PRS_CLASSES.PRS_CLASS_8}>
            #{item.number}
          </PrLink>
          <span className={PRS_CLASSES.PRS_CLASS_9}>{item.title}</span>
          {item.is_draft && <span className={PRS_CLASSES.PRS_DRAFT_BADGE}>Draft</span>}
          <span className={PRS_CLASSES.PRS_CLASS_10}>
            <CheckStatusIcon state={check} />
            {reviewed && <ReviewApprovedIcon />}
          </span>
          <span className={PRS_CLASSES.PRS_CLASS_11}>
            <span className={PRS_CLASSES.PRS_CLASS_1}>+{item.additions.toLocaleString('en-US')}</span>
            <span className={PRS_CLASSES.PRS_CLASS_3}>-{item.deletions.toLocaleString('en-US')}</span>
          </span>
        </span>
        <span className={PRS_CLASSES.PRS_CLASS_12}>
          <span className={`${PRS_CLASSES.PRS_AUTHOR_AVATAR} ${item.author === PRS_CLASSES.PRS_AUTHOR_MAINTAINER ? PRS_CLASSES.PRS_AVATAR_MAINTAINER : PRS_CLASSES.PRS_AVATAR_OTHER}`}>
            {(item.author ?? '?')[0].toUpperCase()}
          </span>
          <span className={PRS_CLASSES.PRS_CLASS_13}>{item.author ?? 'Unknown'}</span>
          <span>·</span>
          <span className={PRS_CLASSES.PRS_CLASS_14}>{repoName}</span>
          {item.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className={PRS_CLASSES.PRS_CLASS_15}
            >
              <i
                className={PRS_CLASSES.PRS_CLASS_16}
                style={{ background: label.color ? `#${label.color.replace(/^#/, '')}` : 'var(--text-muted)' }}
              />
              {label.name}
            </span>
          ))}
          {item.labels.length > 3 && <span className={PRS_CLASSES.PRS_CLASS_15}>+{item.labels.length - 3}</span>}
          <span className={PRS_CLASSES.PRS_CLASS_17}>{relativeAge(item.updated_at)}</span>
        </span>
      </span>
    </div>
  )
}

function prStateIconClass(state: PrListItem['state']): string {
  if (state === 'merged') return PRS_CLASSES.PRS_STATE_MERGED_ICON
  if (state === 'closed') return PRS_CLASSES.PRS_STATE_CLOSED_ICON
  return ''
}

function PrListLoading(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading pull requests" className={PRS_CLASSES.PRS_CLASS_51}>
      {[0, 1, 2].map((row) => <div key={row} className={PRS_CLASSES.PRS_CLASS_52} />)}
    </div>
  )
}

function PrListEmpty({ searching }: { searching: boolean }): React.JSX.Element {
  return (
    <EmptyState
      icon={searching ? IconSearch : IconGitPullRequest}
      heading={searching ? 'No matching pull requests' : 'No pull requests found'}
      description={searching ? 'Try another search or clear the filters.' : 'Pull requests for this repository will appear here.'}
    />
  )
}

function PrScreenDetail({ item, client, directory, requestNonce, onClose, onOpenSurface }: {
  item: PrListItem
  client: HoustonClient | null
  directory: string | null
  requestNonce: number
  onClose: () => void
  onOpenSurface: PullRequestsScreenProps['onOpenSurface']
}): React.JSX.Element {
  const [surfaceMenuOpen, setSurfaceMenuOpen] = useState(false)
  return (
    <aside className={PRS_CLASSES.PRS_DETAIL_COLUMN} data-testid="pr-screen-detail" aria-label={`Pull request #${item.number}`}>
      <div className={PRS_CLASSES.PRS_DETAIL_TABBAR}>
        <div role="tablist" aria-label="Pull request surface">
          <PanelTab
            label={`#${item.number}`}
            icon={<span className={prStateIconClass(item.state)}>{item.state === 'merged' ? <MergedIcon /> : <Icon glyph={IconGitPullRequest} role="small" />}</span>}
            active
            onClose={onClose}
          />
        </div>
        <button type="button" className={PRS_CLASSES.PRS_DETAIL_ADD} aria-label="Open a surface" aria-expanded={surfaceMenuOpen} onClick={() => setSurfaceMenuOpen((open) => !open)}>
          <Icon glyph={IconPlus} role="small" />
        </button>
        {surfaceMenuOpen && <ShellElement as="div" shellRole="panel-add-menu" role="menu" aria-label="Open a surface">
          {([
            ['browser', 'Browser', 'B'],
            ['files', 'Files', 'F'],
            ['diff', 'Diff', 'D'],
            ['pull-request', 'Pull request', 'P'],
            ['linked-pull-requests', 'Linked pull requests', 'L'],
          ] as const).map(([surface, label, shortcut]) => <ShellElement as="button" key={surface} type="button" role="menuitem" shellRole="panel-add-item" state={surface === 'linked-pull-requests' ? 'disabled' : undefined} aria-disabled={surface === 'linked-pull-requests' || undefined} onClick={() => { if (surface === 'linked-pull-requests') return; onOpenSurface?.(surface); setSurfaceMenuOpen(false) }}><Icon glyph={surface === 'pull-request' ? IconGitPullRequest : surface === 'diff' ? IconCode : surface === 'browser' ? IconGlobe : IconFolder} role="small" /><span>{label}</span><ShellElement as="kbd" shellRole="panel-add-key">{shortcut}</ShellElement></ShellElement>)}
        </ShellElement>}
      </div>
      <div className={PRS_CLASSES.PRS_DETAIL_CONTENT}>
        <PullRequestTab
          key={`${directory}:${item.number}`}
          client={client}
          dir={directory}
          compact
          requestedPr={{ number: item.number, nonce: requestNonce }}
        />
      </div>
    </aside>
  )
}

export function PullRequestsScreen({
  repoName,
  workspace,
  currentUser,
  items,
  client = null,
  directory = null,
  selectedNumber = null,
  state = 'all',
  sort = 'updated',
  loading = false,
  onStateChange,
  onSortChange,
  onRefresh,
  onOpenPullRequest,
  onCheckoutInWorktree,
  onOpenSurface,
}: PullRequestsScreenProps): React.JSX.Element {
  const storageKey = `tr-pr-list:${workspace}`
  const [query, setQuery] = useState('')
  const [openMenu, setOpenMenu] = useState<'sort' | 'filters' | null>(null)
  const [selectedState, setSelectedState] = useState(state)
  const [selectedSort, setSelectedSort] = useState<ScreenSort>(sort)
  const [folded, setFolded] = useState(false)
  const [selected, setSelected] = useState<number | null>(selectedNumber)
  const [requestNonce, setRequestNonce] = useState(0)
  const previousWorkspace = useRef(workspace)
  const [context, setContext] = useState<{ item: PrListItem; x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedItem = items.find((item) => item.number === selected) ?? null
  const openItem = (item: PrListItem): void => {
    setSelected((current) => current === item.number ? null : item.number)
    setRequestNonce((nonce) => nonce + 1)
    onOpenPullRequest?.(item)
  }

  useEffect(() => {
    if (previousWorkspace.current !== workspace) {
      previousWorkspace.current = workspace
      setSelected(null)
    }
  }, [workspace])
  const visible = useMemo(
    () =>
      filterPullRequests(
        items.filter((item) => selectedState === 'all' || item.state === selectedState),
        query,
      ),
    [items, query, selectedState],
  )
  const groups = useMemo(
    () => groupPullRequests(visible, currentUser, selectedSort),
    [currentUser, selectedSort, visible],
  )

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved) as { query?: string; state?: PrListState; sort?: PrSort; scrollTop?: number }
        if (typeof parsed.query === 'string') setQuery(parsed.query)
        if (parsed.state) setSelectedState(parsed.state)
        if (parsed.sort) setSelectedSort(parsed.sort)
        if (parsed.scrollTop != null && scrollRef.current) scrollRef.current.scrollTop = parsed.scrollTop
      }
    } catch {
      /* ignore invalid local preferences */
    }
  }, [storageKey])

  useEffect(() => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ query, state: selectedState, sort: selectedSort, scrollTop: scrollRef.current?.scrollTop ?? 0 }),
    )
  }, [query, selectedSort, selectedState, storageKey])

  const persist = (): void =>
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ query, state: selectedState, sort: selectedSort, scrollTop: scrollRef.current?.scrollTop ?? 0 }),
    )
  const group = (
    key: keyof typeof groups,
    label: string,
    icon: typeof IconEye | typeof IconGrid | typeof IconPencil,
  ): React.JSX.Element => {
    const rows = groups[key]
    return (
      <section key={key} className={PRS_CLASSES.PRS_CLASS_18} aria-label={label}>
        <div className={PRS_CLASSES.PRS_CLASS_19}>
          <Icon glyph={icon} role="ui" />
          {label}
          <span className={PRS_CLASSES.PRS_CLASS_20}>{rows.length}</span>
          <span className={PRS_CLASSES.PRS_CLASS_21} />
        </div>
        <div className={PRS_CLASSES.PRS_CLASS_22}>
          {rows.map((item) => (
            <PrRow
              key={item.number}
              item={item}
              repoName={repoName}
              selected={selected === item.number}
              onOpen={() => openItem(item)}
              onContextMenu={(event, row) => {
                event.preventDefault()
                  setContext({ item: row, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 216)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 160)) })
              }}
            />
          ))}
        </div>
      </section>
    )
  }

  return (
    <main
      className={PRS_CLASSES.PRS_CLASS_23}
      data-testid="pull-requests-screen"
    >
      <div className={PRS_CLASSES.PRS_LIST_COLUMN}>
      <header className={PRS_CLASSES.PRS_CLASS_24}>
        <div className={PRS_CLASSES.PRS_CLASS_25}>
          <span>Pull Requests</span>
          {folded && (
            <>
              <span className={PRS_CLASSES.PRS_CLASS_26}>/</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedState('open')
                  onStateChange?.('open')
                }}
                className={PRS_CLASSES.PRS_CLASS_27}
              >
                Open
                <Icon glyph={IconChevronDown} role="small" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedState('all')
                  onStateChange?.('all')
                }}
                className={PRS_CLASSES.PRS_CLASS_27}
              >
                All
                <Icon glyph={IconChevronDown} role="small" />
              </button>
            </>
          )}
        </div>
        {folded && (
          <div className={PRS_CLASSES.PRS_CLASS_28}>
            <button
              type="button"
              className={PRS_CLASSES.PRS_CLASS_29}
              aria-label="Search pull requests"
              onClick={() => document.getElementById('pr-search')?.focus()}
            >
              <Icon glyph={IconSearch} role="small" />
            </button>
            <button
              type="button"
              className={PRS_CLASSES.PRS_CLASS_29}
              aria-label="Refresh pull requests"
              onClick={onRefresh}
            >
              <Icon glyph={IconRefresh} role="small" />
            </button>
          </div>
        )}
      </header>
      {context && (
        <div
          role="menu"
          className={PRS_CLASSES.PRS_CLASS_30}
          style={{ left: context.x, top: context.y }}
        >
          <button
            type="button"
            role="menuitem"
            className={PRS_CLASSES.PRS_CLASS_31}
            onClick={() => {
              void navigator.clipboard.writeText(context.item.url)
              setContext(null)
            }}
          >
            Copy link
          </button>
          <button
            type="button"
            role="menuitem"
            className={PRS_CLASSES.PRS_CLASS_31}
            onClick={() => {
              window.open(context.item.url, '_blank', 'noopener,noreferrer')
              setContext(null)
            }}
          >
            Open on GitHub
          </button>
          {onCheckoutInWorktree && (
            <button
              type="button"
              role="menuitem"
              className={PRS_CLASSES.PRS_CLASS_31}
              onClick={() => {
                onCheckoutInWorktree(context.item)
                setContext(null)
              }}
            >
              Check out in new worktree
            </button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        data-testid="pr-list-scroll"
        className={PRS_CLASSES.PRS_CLASS_32}
        onScroll={(event) => {
          const isFolded = event.currentTarget.scrollTop > 58
          setFolded((prior) => (prior === isFolded ? prior : isFolded))
          persist()
        }}
      >
        <div className={PRS_CLASSES.PRS_CLASS_33}>
          <div className={PRS_CLASSES.PRS_CLASS_34}>
            <label className={PRS_CLASSES.PRS_CLASS_35}>
              <Icon glyph={IconSearch} role="small" />
              <input
                id="pr-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pull requests, or label:bug"
                aria-label="Search pull requests"
                className={PRS_CLASSES.PRS_CLASS_36}
              />
            </label>
            <div className={PRS_CLASSES.PRS_CLASS_37}>
              <button
                type="button"
                className={PRS_CLASSES.PRS_CLASS_38}
                onClick={() => setOpenMenu(openMenu === 'sort' ? null : 'sort')}
              >
                <span className={PRS_CLASSES.PRS_SORT_ICON}><Icon glyph={IconArrowDown} role="small" /><Icon glyph={IconArrowUp} role="small" /></span>
                Sort
              </button>
              {openMenu === 'sort' && (
                <div
                  role="menu"
                  className={PRS_CLASSES.PRS_CLASS_41}
                >
                  {SORTS.map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selectedSort === entry.value}
                      className={PRS_CLASSES.PRS_CLASS_42}
                      onClick={() => {
                        setSelectedSort(entry.value)
                        if (entry.value === 'ready' || entry.value === 'updated' || entry.value === 'created')
                          onSortChange?.(entry.value)
                        setOpenMenu(null)
                      }}
                    >
                      <span className={PRS_CLASSES.PRS_CLASS_43}>
                        {selectedSort === entry.value && <Icon glyph={IconCheck} role="small" />}
                      </span>
                      {entry.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className={PRS_CLASSES.PRS_CLASS_37}>
              <button
                type="button"
                className={PRS_CLASSES.PRS_CLASS_38}
                onClick={() => setOpenMenu(openMenu === 'filters' ? null : 'filters')}
              >
                <Icon glyph={IconFilter} role="small" />
                Filters<span className={PRS_CLASSES.PRS_CLASS_44}>1</span>
              </button>
              {openMenu === 'filters' && (
                <div
                  role="menu"
                  className={PRS_CLASSES.PRS_CLASS_45}
                >
                  {[
                    ['State', selectedState[0].toUpperCase() + selectedState.slice(1)],
                    ['Involvement', 'All'],
                    ['Author', 'Anyone'],
                    ['Labels', 'Any'],
                    ['Draft', 'Hide drafts'],
                    ['Review', 'All'],
                    ['Checks', 'All'],
                    ['Workspace', repoName],
                  ].map(([label, value]) => (
                    <button
                      key={label}
                      type="button"
                      role="menuitem"
                      className={PRS_CLASSES.PRS_CLASS_46}
                      onClick={() => {
                        if (label === 'State') {
                          setSelectedState((current) => (current === 'open' ? 'all' : 'open'))
                          onStateChange?.(selectedState === 'open' ? 'all' : 'open')
                        }
                      }}
                    >
                      <span>{label}</span>
                      <span className={PRS_CLASSES.PRS_CLASS_47}>
                        {value}
                        <Icon glyph={IconChevronDown} role="small" />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className={PRS_CLASSES.PRS_CLASS_48}
              aria-label="Refresh pull requests"
              disabled={loading}
              onClick={onRefresh}
            >
              <Icon glyph={IconRefresh} role="small" />
            </button>
          </div>
          <div className={PRS_CLASSES.PRS_CLASS_49} />
          <div className={PRS_CLASSES.PRS_CLASS_50}>
            {loading && visible.length === 0 ? (
              <PrListLoading />
            ) : visible.length === 0 ? (
              <PrListEmpty searching={query !== ''} />
            ) : (
              <>
                {group('authored', 'Authored', IconPencil)}
                {group('reviewRequested', 'Review requested', IconEye)}
                {group('others', 'Others', IconGrid)}
              </>
            )}
          </div>
        </div>
      </div>
      </div>
      {selectedItem && (
        <PrScreenDetail
          item={selectedItem}
          client={client}
          directory={directory}
          requestNonce={requestNonce}
          onClose={() => setSelected(null)}
          onOpenSurface={onOpenSurface}
        />
      )}
    </main>
  )
}
