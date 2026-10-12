import { IconGitPullRequest, IconSearch } from '../icons'
import { MascotSurfaceMount } from '../../mascot/MascotMount'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HoustonClient, PrListItem, PrListState, Workspace } from '../../houston/client'
import type { PrSort } from '../../houston/generated/PrSort'
import { PRS_CLASSES } from '../ui/PrsClasses'
import { EmptyState } from '../ui/EmptyState'
import { NavSurfaceFrame } from '../ui/NavSurfaceFrame'
import { PrPageContent, PrPageHeader, PrPageFilters, PrPageGroupHeading, PrListEntry } from '../ui/PrPage'
import { PrStatusWord } from '../ui/PrPresentation'
import { ContextMenu, ContextMenuItem, ContextMenuItems } from '../ui/ContextMenu'
import { filterPullRequests, groupPullRequests, pullRequestStatus, type PullRequestSort } from './prListModel'
import { prRelativeAge } from '../git/prRelativeAge'
import { PullRequestTab } from '../git/PullRequestTab'
import type { SurfaceKind } from '../../scmPanel'

export interface PullRequestsScreenProps {
  repoName: string; workspace: string; currentUser: string; items: PrListItem[]; client?: HoustonClient | null; directory?: string | null; selectedNumber?: number | null; state?: PrListState; sort?: PrSort; loading?: boolean; workspaces?: readonly Workspace[]; onWorkspaceChange?: (workspace: string) => void; onStateChange?: (state: PrListState) => void; onSortChange?: (sort: PrSort) => void; onRefresh?: () => void; onOpenPullRequest?: (item: PrListItem) => void; onCheckoutInWorktree?: (item: PrListItem) => void; onOpenSurface?: (surface: SurfaceKind) => void; onOpenUrlInPane?: (url: string) => void
}

function PrRow({ item, selected, onOpen, onContextMenu }: { item: PrListItem; selected: boolean; onOpen: () => void; onContextMenu: (event: React.MouseEvent, item: PrListItem) => void }): React.JSX.Element {
  const status = pullRequestStatus(item)
  return <PrListEntry data-testid={`pr-row-${item.number}`} selected={selected} number={item.number} heading={item.title} author={item.author ?? 'Author unavailable'} age={prRelativeAge(item.updated_at)} additions={item.additions} deletions={item.deletions} status={<PrStatusWord tone={status.tone}>{status.label}</PrStatusWord>} onClick={onOpen} onContextMenu={(event) => onContextMenu(event, item)} />
}

function PrListGroup({ label, rows, selected, onOpen, onContextMenu }: { label: string; rows: PrListItem[]; selected: number | null; onOpen: (item: PrListItem) => void; onContextMenu: (event: React.MouseEvent, item: PrListItem) => void }): React.JSX.Element | null {
  if (rows.length === 0) return null
  return <section className="grid gap-[var(--space-0-5)]" aria-label={label}><PrPageGroupHeading label={label} count={rows.length} />{rows.map((item) => <PrRow key={item.number} item={item} selected={selected === item.number} onOpen={() => onOpen(item)} onContextMenu={onContextMenu} />)}</section>
}

function pageState(state: PrListState): 'open' | 'merged' | 'closed' {
  return state === 'merged' || state === 'closed' ? state : 'open'
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
    <>
    <MascotSurfaceMount mood={searching ? "scan" : "read"} />
    <EmptyState
      icon={searching ? IconSearch : IconGitPullRequest}
      heading={searching ? 'No matching pull requests' : 'No pull requests found'}
      description={searching ? 'Try another search or clear the filters.' : 'Pull requests for this repository will appear here.'}
    /></>
  )
}

function PrScreenDetail({ item, client, directory, requestNonce, onOpenUrlInPane }: { item: PrListItem; client: HoustonClient | null; directory: string | null; requestNonce: number; onOpenUrlInPane: PullRequestsScreenProps['onOpenUrlInPane'] }): React.JSX.Element {
  return <aside className={PRS_CLASSES.PRS_DETAIL_COLUMN} data-testid="pr-screen-detail" aria-label={`Pull request #${item.number}`}><div className={PRS_CLASSES.PRS_DETAIL_CONTENT}><PullRequestTab key={`${directory}:${item.number}`} client={client} dir={directory} compact onOpenUrlInPane={onOpenUrlInPane} requestedPr={{ number: item.number, nonce: requestNonce }} /></div></aside>
}

export function PullRequestsScreen({ repoName, workspace, currentUser, items, client = null, directory = null, selectedNumber = null, state = 'open', sort = 'updated', loading = false, workspaces = [], onWorkspaceChange, onStateChange, onOpenPullRequest, onCheckoutInWorktree, onOpenUrlInPane }: PullRequestsScreenProps): React.JSX.Element {
  const storageKey = `tr-pr-list:${workspace}`
  const [query, setQuery] = useState('')
  const [selectedState, setSelectedState] = useState(pageState(state))
  const [selectedSort, setSelectedSort] = useState<PullRequestSort>(sort)
  const [selected, setSelected] = useState<number | null>(selectedNumber)
  const [requestNonce, setRequestNonce] = useState(0)
  const [context, setContext] = useState<{ item: PrListItem; x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousWorkspace = useRef(workspace)
  const selectedItem = items.find((item) => item.number === selected) ?? null
  const options = workspaces.map((item) => ({ value: item.path, label: item.name }))
  if (!options.some((item) => item.value === workspace)) options.unshift({ value: workspace, label: repoName })
  const visible = useMemo(() => filterPullRequests(items.filter((item) => item.state === selectedState), query), [items, query, selectedState])
  const groups = useMemo(() => groupPullRequests(visible, currentUser, selectedSort), [visible, currentUser, selectedSort])

  useEffect(() => { if (previousWorkspace.current !== workspace) { previousWorkspace.current = workspace; setSelected(null); setContext(null) } }, [workspace])
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as { query?: string; state?: PrListState; sort?: PullRequestSort; scrollTop?: number } | null
      if (!saved) return
      if (typeof saved.query === 'string') setQuery(saved.query)
      if (saved.state) {
        const restored = pageState(saved.state)
        setSelectedState(restored)
        if (restored !== pageState(state)) onStateChange?.(restored)
      }
      if (saved.sort) setSelectedSort(saved.sort)
      if (saved.scrollTop != null && scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop
    } catch { /* ignore invalid local preferences */ }
  }, [storageKey])
  const persist = (): void => localStorage.setItem(storageKey, JSON.stringify({ query, state: selectedState, sort: selectedSort, scrollTop: scrollRef.current?.scrollTop ?? 0 }))
  useEffect(persist, [query, selectedState, selectedSort, storageKey])
  const openItem = (item: PrListItem): void => { setSelected((current) => current === item.number ? null : item.number); setRequestNonce((nonce) => nonce + 1); onOpenPullRequest?.(item) }
  const menu = (event: React.MouseEvent, item: PrListItem): void => { event.preventDefault(); setContext({ item, x: event.clientX, y: event.clientY }) }
  return <NavSurfaceFrame row data-testid="pull-requests-screen">
    <div ref={scrollRef} data-testid="pr-list-scroll" className={PRS_CLASSES.PRS_LIST_COLUMN} onScroll={persist}>
      <PrPageContent><PrPageHeader workspace={workspace} options={options} onWorkspaceChange={(value) => onWorkspaceChange?.(value)} /><PrPageFilters query={query} onQueryChange={setQuery} state={selectedState} openCount={state === 'merged' || state === 'closed' ? null : items.filter((item) => item.state === 'open').length} onStateChange={(value) => { setSelectedState(value); onStateChange?.(value) }} />
        {loading && visible.length === 0 ? <PrListLoading /> : visible.length === 0 ? <PrListEmpty searching={query !== ''} /> : <><PrListGroup label="Waiting on you" rows={groups.waitingOnYou} selected={selected} onOpen={openItem} onContextMenu={menu} /><PrListGroup label="Yours" rows={groups.yours} selected={selected} onOpen={openItem} onContextMenu={menu} /><PrListGroup label="Others" rows={groups.others} selected={selected} onOpen={openItem} onContextMenu={menu} /></>}
      </PrPageContent>
    </div>
    {context && <ContextMenu role="menu" style={{ left: context.x, top: context.y }}><ContextMenuItems><ContextMenuItem role="menuitem" onClick={() => { void navigator.clipboard?.writeText(context.item.url); setContext(null) }}>Copy link</ContextMenuItem><ContextMenuItem role="menuitem" onClick={() => { window.open(context.item.url, '_blank', 'noopener,noreferrer'); setContext(null) }}>Open on GitHub</ContextMenuItem>{onCheckoutInWorktree && <ContextMenuItem role="menuitem" onClick={() => { onCheckoutInWorktree(context.item); setContext(null) }}>Check out in new worktree</ContextMenuItem>}</ContextMenuItems></ContextMenu>}
    {selectedItem && <PrScreenDetail item={selectedItem} client={client} directory={directory} requestNonce={requestNonce} onOpenUrlInPane={onOpenUrlInPane} />}
  </NavSurfaceFrame>
}
