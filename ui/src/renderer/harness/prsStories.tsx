import type { PrListItem } from '../src/houston/client'
import { useEffect, useRef } from 'react'
import { Icon } from '../src/components/ui/Icon'
import { IconChevronLeft, IconGrid, IconSearch } from '../src/components/icons'
import { PullRequestsScreen } from '../src/components/prs/PullRequestsScreen'

const noop = (): void => {}
const now = Math.floor(Date.now() / 1000)

const pullRequests: PrListItem[] = [
  {
    number: 95,
    title: 'fix(panes): terminals keep their content while the inspector opens',
    url: 'https://github.com/owner/houston/pull/95',
    state: 'open',
    is_draft: false,
    author: 'maintainer',
    head_ref: 'fix/pane-content',
    base_ref: 'main',
    updated_at: now - 12 * 60,
    created_at: now - 50 * 60,
    additions: 91,
    deletions: 12,
    review_decision: null,
    checks: 'passing',
    labels: [{ name: 'bug', color: 'f04438' }],
    comments: 2,
    review_requested: false,
    mergeable: 'mergeable',
  },
  {
    number: 93,
    title: 'fix(codex): Codex panes start again with Codex CLI 0.160',
    url: 'https://github.com/owner/houston/pull/93',
    state: 'merged',
    is_draft: false,
    author: 'maintainer',
    head_ref: 'fix/codex-restart',
    base_ref: 'main',
    updated_at: now - 13 * 60,
    created_at: now - 70 * 60,
    additions: 156,
    deletions: 15,
    review_decision: null,
    checks: 'passing',
    labels: [],
    comments: 4,
    review_requested: false,
    mergeable: 'mergeable',
  },
  {
    number: 92,
    title: 'feat(remote): follow and answer agents from a paired phone or another computer',
    url: 'https://github.com/owner/houston/pull/92',
    state: 'open',
    is_draft: false,
    author: 'teammate',
    head_ref: 'feat/remote',
    base_ref: 'main',
    updated_at: now - 3 * 60 * 60,
    created_at: now - 5 * 60 * 60,
    additions: 9163,
    deletions: 18,
    review_decision: null,
    checks: 'failing',
    labels: [],
    comments: 8,
    review_requested: true,
    mergeable: 'conflicting',
  },
  {
    number: 79,
    title: 'feat(agents): ZCode runs in a pane with reported status, pane tools and resume',
    url: 'https://github.com/owner/houston/pull/79',
    state: 'open',
    is_draft: false,
    author: 'teammate',
    head_ref: 'feat/zcode',
    base_ref: 'main',
    updated_at: now - 24 * 60 * 60,
    created_at: now - 28 * 60 * 60,
    additions: 2551,
    deletions: 155,
    review_decision: 'APPROVED',
    checks: 'passing',
    labels: [],
    comments: 12,
    review_requested: false,
    mergeable: 'mergeable',
  },
  {
    number: 90,
    title: 'refactor(ui): every screen composes components/ui roles',
    url: 'https://github.com/owner/houston/pull/90',
    state: 'merged',
    is_draft: false,
    author: 'maintainer',
    head_ref: 'refactor/ui-roles',
    base_ref: 'main',
    updated_at: now - 2 * 24 * 60 * 60,
    created_at: now - 3 * 24 * 60 * 60,
    additions: 3410,
    deletions: 2987,
    review_decision: null,
    checks: 'passing',
    labels: [
      { name: 'ui', color: '3b82f6' },
      { name: 'refactor', color: 'a855f7' },
    ],
    comments: 6,
    review_requested: false,
    mergeable: 'mergeable',
  },
]

function PrRail(): React.JSX.Element {
  return (
    <aside className="flex w-[270px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--rail-bg)] text-[var(--text-secondary)]">
      <div className="mx-2 flex h-8 items-center gap-2 rounded-md bg-[var(--hover-fill)] px-2 text-[12px] text-[var(--text-muted)]"><Icon glyph={IconSearch} role="small" />Search<span className="ml-auto rounded bg-[var(--hover-strong)] px-1.5">Ctrl K</span></div>
      <nav className="mt-2 flex flex-col px-2 text-[13px]">
        {['Tasks', 'Skills', 'Routines', 'Harness', 'Connections'].map((item) => <div key={item} className="flex h-8 items-center rounded px-2">{item}</div>)}
      </nav>
      <div className="flex items-center px-4 py-2 text-[12px] font-medium">Workspaces <span className="ml-auto">☷　⊞　＋</span></div>
      <div className="min-h-0 flex-1 overflow-hidden px-2 text-[12px]">
        <div className="flex h-8 items-center gap-2 px-2"><span className="text-[var(--text-faint)]">●</span>Pinned <span className="text-[var(--text-muted)]">2</span></div>
        <div className="flex h-8 items-center gap-2 px-2"><Icon glyph={IconGrid} role="small" />Terminal</div>
        <div className="ml-5 flex h-6 items-center text-[11px] text-[var(--text-muted)]">♧ main</div>
        <div className="flex h-8 items-center gap-2 px-2"><span className="text-[var(--ok)]">◌</span>Mensageria access tiers</div>
        <div className="ml-5 flex h-6 items-center text-[11px] text-[var(--text-muted)]">♧ main <span className="ml-auto text-[var(--ok)]">+932</span></div>
        <div className="my-2 h-px bg-[var(--divider)]" />
        <div className="flex h-8 items-center gap-2 px-2"><span>⌄</span>Houston <span className="text-[var(--text-muted)]">2</span></div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--hover-fill)] px-2 py-2">Inspector polish<div className="ml-4 mt-2 text-[11px] text-[var(--text-muted)]">♧ main　<span className="text-[var(--ok)]">+214</span>　<span className="text-[var(--stop)]">-38</span></div></div>
        <div className="mt-2 flex h-8 items-center gap-2 rounded-md px-2"><span className="text-[#d29b20]">●</span>Pull requests screen <span className="rounded border px-1 text-[10px]">draft</span></div>
        <div className="ml-5 flex h-6 items-center text-[11px] text-[var(--text-muted)]">♧ houston/pr-list　<span className="ml-auto text-[var(--ok)]">+1204</span></div>
        <div className="ml-5 flex h-6 items-center text-[11px] text-[var(--text-muted)]">◌　tela de pull requests</div>
      </div>
      <button type="button" className="flex h-10 shrink-0 items-center gap-2 border-t border-[var(--border)] px-5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--hover-fill)]"><Icon glyph={IconChevronLeft} role="small" />Back</button>
    </aside>
  )
}

export function PullRequestsScreenStory({ mode = 'populated' }: { mode?: 'populated' | 'empty' | 'loading' | 'sort' | 'filters' | 'hover' }): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const items = mode === 'empty' || mode === 'loading' ? [] : pullRequests
  useEffect(() => {
    const screen = rootRef.current?.querySelector('[data-testid="pull-requests-screen"]')
    if (mode === 'sort') Array.from(screen?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Sort')?.click()
    if (mode === 'filters') Array.from(screen?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Filters'))?.click()
  }, [mode])
  return (
    <div ref={rootRef} data-prs-hover={mode === 'hover' || undefined} className="flex h-full flex-col bg-[var(--background)] text-[var(--text-primary)]">
      {mode === 'hover' && <style>{'[data-prs-hover="true"] [data-testid="pr-row-95"] { background: var(--hover-fill); }'}</style>}
      <div className="flex h-[calc(100%-20px)] min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 text-[12px] text-[var(--text-muted)]"><span className="h-4 w-4 rounded-[5px] bg-gradient-to-br from-[#9b63ff] to-[#4e74ff]" /><span className="font-semibold text-[var(--text-primary)]">Houston</span><span className="ml-[150px]">◫</span><span className="ml-auto">▦　◫　−</span></header>
      <div className="flex min-h-0 flex-1">
        <PrRail />
        <PullRequestsScreen repoName="owner/houston" workspace="/workspace/houston" currentUser="maintainer" items={items} state={mode === 'filters' ? 'open' : 'all'} loading={mode === 'loading'} onRefresh={noop} onOpenPullRequest={noop} />
      </div>
      </div>
    </div>
  )
}
