import React from 'react'
import { Sidebar } from '../src/components/Sidebar'
import { RailResizeHandle } from '../src/components/RailResizeHandle'
import { WorkspacesEmpty } from '../src/components/WorkspacesEmpty'
import { setSettingsOpen } from '../src/settingsNav'
import { setUpdateInstallForTests } from '../src/updateInstall'
import type { SessionInfo, Workspace } from '../src/houston/client'
import { rememberRailGitFacts } from '../src/components/git/railGitCache'
import { rememberRailPr } from '../src/components/git/railPrCache'

const noop = (): void => {}

const WS_ROOT = '/home/dev/code'
const ws = (name: string): Workspace => ({ path: `${WS_ROOT}/${name}`, name }) as Workspace
const path = (name: string): string => `${WS_ROOT}/${name}`

const TAGS = [
  { id: 1, name: 'ui', color: '#5c8fff' },
  { id: 2, name: 'perf', color: '#f59e0b' },
  { id: 3, name: 'backend', color: '#4ade80' },
  { id: 4, name: 'release', color: '#c084fc' },
  { id: 5, name: 'api', color: '#f472b6' },
]

function seedStorage(opts: { collapsed?: string[]; tagFilter?: number[]; cardMode?: 'detailed' | 'compact'; groupBy?: 'none' | 'status' | 'pr' | 'workspace'; pinnedGridIds?: string[]; showTags?: boolean }): void {
  try {
    localStorage.setItem('tr-ws-collapsed', JSON.stringify([
      ...(opts.collapsed ?? []),
      path('envio_posicoes'),
      path('bot-service'),
    ]))
    localStorage.setItem('houston.tagFilter', JSON.stringify(opts.tagFilter ?? []))
    localStorage.setItem('tr-rail-prefs', JSON.stringify({
      v: 1,
      groupBy: opts.groupBy ?? 'workspace',
      sort: 'manual',
      cardMode: opts.cardMode ?? 'detailed',
      agentActivity: 'compact',
      properties: opts.cardMode === 'compact'
        ? ['status', 'unread']
        : ['status', 'unread', 'checkout', 'pr', 'diff', ...(opts.showTags ? ['tags'] : []), 'task', 'inline-agents'],
      filters: { hideIdle: false, hideDefaultBranch: false, hideEmptyGrids: opts.showTags ?? false },
      collapsedGroups: [],
      tags: [],
      customisedProperties: false,
    }))
    localStorage.setItem('tr-grid-pinned', JSON.stringify(opts.pinnedGridIds ?? []))
  } catch {}
}

interface RailProps {
  workspaces?: Workspace[]
  pinned?: string[]
  selected?: string
  renaming?: string | null
  collapsed?: string[]
  tagFilter?: number[]
  settingsOpen?: boolean
  updateVersion?: string | null
  withGrids?: boolean
  chromeTheme?: 'graphite' | 'paper'
  freezeMenuMotion?: boolean
  freezeCaret?: boolean
  cardMode?: 'detailed' | 'compact'
  sessions?: SessionInfo[]
  gridsByWorkspace?: Record<string, { id: string; name: string; count?: number; state?: 'starting' | 'working' | 'needs-input' | 'idle' | 'unavailable' | 'stopped'; sessionIds?: number[]; tagIds?: number[] }[]>
  pinnedGridIds?: string[]
  selectedGridId?: string
  showTags?: boolean
}

function RailFixtureStyle({ freezeMenuMotion, freezeCaret }: { freezeMenuMotion: boolean; freezeCaret: boolean }): React.JSX.Element | null {
  if (!freezeMenuMotion && !freezeCaret) return null
  const menuMotion = freezeMenuMotion ? '.ctxmenu { animation: none !important; }' : ''
  const caret = freezeCaret ? ' input { caret-color: transparent !important; }' : ''
  return <style>{`${menuMotion}${caret}`}</style>
}

function fixtureGrids(gridsByWorkspace: RailProps['gridsByWorkspace'], withGrids: boolean): NonNullable<RailProps['gridsByWorkspace']> {
  if (gridsByWorkspace) return gridsByWorkspace
  if (!withGrids) return {}
  return {
    [path('acme-api')]: [
      { id: 'work-in', name: 'Work in', count: 5, state: 'working', tagIds: [1] },
      { id: 'review', name: 'Review pass', count: 2, state: 'needs-input', tagIds: [2] },
      { id: 'idle', name: 'Idle tab', state: 'idle' }
    ],
    [path('bridge')]: [{ id: 'one', name: 'Bridge tab', state: 'idle' }],
    [path('acme-core')]: [{ id: 'core', name: 'Core tab', state: 'unavailable' }]
  }
}

function RailFixture({
  workspaces = [ws('acme-core'), ws('acme-api'), ws('bridge'), ws('acme-ui'), ws('houston')],
  pinned = [path('acme-core')],
  selected = path('acme-api'),
  renaming = null,
  collapsed = [path('bridge')],
  tagFilter = [],
  settingsOpen = false,
  updateVersion = '9.9.9',
  withGrids = true,
  chromeTheme = 'graphite',
  freezeMenuMotion = false,
  freezeCaret = false,
  cardMode = 'detailed',
  sessions = [],
  gridsByWorkspace,
  pinnedGridIds = [],
  selectedGridId = 'work-in',
  showTags = false,
}: RailProps): React.JSX.Element {
  const ready = React.useRef(false)
  if (!ready.current) {
    seedStorage({ collapsed, tagFilter, cardMode, pinnedGridIds, showTags })
    setSettingsOpen(settingsOpen)
    ready.current = true
  }
  return (
    <div style={{ display: 'flex', height: '100%', width: 260 }}>
      <RailFixtureStyle freezeMenuMotion={freezeMenuMotion} freezeCaret={freezeCaret} />
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        selected={selected}
        selectedGridId={selectedGridId}
        gridsByWorkspace={fixtureGrids(gridsByWorkspace, withGrids)}
        customColors={{}}
        colorIndexByPath={{}}
        renaming={renaming}
        onSelect={noop}
        onAddWorkspace={noop}
        onRemoveWorkspace={noop}
        onRenameStart={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onChangeColor={noop}
        onReorderWorkspace={noop}
        pinnedWorkspaces={new Set(pinned)}
        onTogglePinWorkspace={noop}
        onSshConnect={noop}
        tags={TAGS}
        onTagCreate={noop}
        onTagUpdate={noop}
        onTagDelete={noop}
        onSetGridTags={noop}
        chromeTheme={chromeTheme}
        onToggleChromeTheme={noop}
        onSelectGrid={noop}
        onAddGrid={noop}
        onNewWorkspaceSession={noop}
        onRenameGrid={noop}
        onRemoveGrid={noop}
        onOpenSettings={noop}
        onOpenPalette={noop}
        onHideRail={noop}
        paletteChord="Ctrl K"
        harnessAttention={2}
        taskTurnCount={3}
        updateVersion={updateVersion}
      />
    </div>
  )
}

/** Retries `act` until it reports done: grid rows and menus arrive through lazy chunks. */
function useScript(act: (root: HTMLElement) => boolean): React.RefObject<HTMLDivElement | null> {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      const done = ref.current ? act(ref.current) : false
      if (done || tries > 100) window.clearInterval(timer)
    }, 30)
    return () => window.clearInterval(timer)
  }, [])
  return ref
}

function contextMenuOn(el: Element): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2 }))
}

function Scripted({ act, ...props }: RailProps & { act: (root: HTMLElement) => boolean }): React.JSX.Element {
  const ref = useScript(act)
  return <div ref={ref} style={{ height: '100%' }}><RailFixture {...props} /></div>
}

function RailMenu({ target, pick, ...props }: RailProps & { target: string; pick?: string }): React.JSX.Element {
  // `pick` is the visible text of the menu item to press once the menu is open.
  let stage = 0
  return (
    <Scripted
      {...props}
      freezeMenuMotion
      act={(root) => {
        if (stage === 0) {
          const el = root.querySelector(target)
          if (!el) return false
          contextMenuOn(el)
          stage = pick ? 1 : 2
          return stage === 2
        }
        const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent?.trim() === pick)
        if (stage === 1) {
          if (!item) return false
          item.click()
          if (pick !== 'Rename') return true
          stage = 2
          return false
        }
        const input = root.querySelector<HTMLInputElement>('input')
        if (!input) return false
        input.focus()
        input.setSelectionRange(0, 0)
        return true
      }}
    />
  )
}

function RailRename({ workspace }: { workspace: string }): React.JSX.Element {
  return <Scripted renaming={path(workspace)} freezeCaret act={(root) => {
    const input = root.querySelector<HTMLInputElement>('input')
    if (!input) return false
    input.focus()
    input.setSelectionRange(0, 0)
    return true
  }} />
}

function RailClick({ target, ...props }: RailProps & { target: string }): React.JSX.Element {
  return (
    <Scripted
      {...props}
      act={(root) => {
        const el = root.querySelector<HTMLElement>(target)
        if (!el) return false
        el.click()
        return true
      }}
    />
  )
}

function RailDrag(props: RailProps): React.JSX.Element {
  let stage = 0
  return (
    <Scripted
      {...props}
      act={(root) => {
        const rows = root.querySelectorAll<HTMLElement>('[data-ws-idx]')
        if (rows.length < 4) return false
        const from = rows[2].getBoundingClientRect()
        const to = rows[3].getBoundingClientRect()
        if (stage === 0) {
          rows[2].dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: from.left + 40,
            clientY: from.top + 10,
          }))
          stage = 1
          return false
        }
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: to.left + 40, clientY: to.top + 4 }))
        return true
      }}
    />
  )
}

function RailSettingsSearch({ query }: { query: string }): React.JSX.Element {
  return (
    <Scripted
      settingsOpen
      act={(root) => {
        const input = root.querySelector<HTMLInputElement>('input')
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, query)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }}
    />
  )
}

function UpdateFailed(): React.JSX.Element {
  React.useState(() => {
    setUpdateInstallForTests({ kind: 'failed', version: '9.9.9', error: 'checksum mismatch' })
    return null
  })
  return <RailFixture />
}

function UpdateRunning(): React.JSX.Element {
  React.useState(() => {
    setUpdateInstallForTests({ kind: 'downloading', downloaded: 40, total: 100 })
    return null
  })
  return <RailFixture />
}

const GRID_ROW = '[data-testid="grid-row"]'

const CARD_WORKSPACES = [
  ws('dispatch'), ws('project_eagle'), ws('Houston'), ws('envio_posicoes'),
  ws('bot-service'), ws('finex'), ws('turbo-kart-rally'),
]
const CARD_NOW = Date.now()
const cardSession = (values: Partial<SessionInfo> & Pick<SessionInfo, 'id' | 'agent' | 'project_dir' | 'title' | 'status'>): SessionInfo => ({
  cwd: values.cwd ?? values.project_dir,
  checkout_root: values.checkout_root ?? values.project_dir,
  checkout: values.checkout ?? { root: values.project_dir, kind: 'primary', branch: 'main', head: null },
  activity: values.activity ?? { prompt: values.title, last_message: null, model: null, tool: null },
  state: values.state ?? 'running',
  codename: values.codename ?? `agent-${values.id}`,
  hidden: false,
  live_children: values.live_children ?? 0,
  children_waiting: values.children_waiting ?? 0,
  inbox_unread: values.inbox_unread ?? 0,
  tags: values.tags ?? [],
  resumable: false,
  status_since_ms: values.status_since_ms ?? CARD_NOW - 2 * 60_000,
  ...values,
})
const CARD_SESSIONS: SessionInfo[] = [
  cardSession({ id: 1, agent: 'shell', project_dir: path('dispatch'), title: 'zsh', status: 'idle', status_since_ms: CARD_NOW, activity: { prompt: 'zsh', last_message: null, model: null, tool: null } }),
  cardSession({ id: 2, agent: 'claude', project_dir: path('project_eagle'), title: 'Orchestrator', status: 'working', status_since_ms: CARD_NOW, live_children: 3, activity: { prompt: 'Orchestrator', last_message: 'aguardando 2 filhos', model: 'opus-5.5', tool: 'claude' } }),
  cardSession({ id: 3, agent: 'claude', project_dir: path('project_eagle'), title: 'eagle-tiers-ui', status: 'working', status_since_ms: CARD_NOW - 22 * 60_000, checkout: { root: `${path('project_eagle')}/wt/eagle-tiers-ui`, kind: { worktree: { slug: 'eagle-tiers-ui' } }, branch: 'feature/tiers-ui', head: null }, activity: { prompt: 'eagle-tiers-ui', last_message: 'Edit TiersTable.vue', model: 'sonnet-5.5', tool: 'Edit' } }),
  cardSession({ id: 4, agent: 'claude', project_dir: path('project_eagle'), title: 'dispatch-tiers', status: 'working', status_since_ms: CARD_NOW - 22 * 60_000, checkout: { root: `${path('project_eagle')}/wt/dispatch-tiers`, kind: { worktree: { slug: 'dispatch-tiers' } }, branch: 'feature/dispatch-tiers', head: null }, activity: { prompt: 'dispatch-tiers', last_message: 'Bash pytest -k tiers', model: 'sonnet-5.5', tool: 'Bash' } }),
  cardSession({ id: 5, agent: 'claude', project_dir: path('project_eagle'), title: 'eagle-tiers-backend', status: 'idle', status_since_ms: CARD_NOW - 16 * 60_000, checkout: { root: `${path('project_eagle')}/wt/eagle-tiers-backend`, kind: { worktree: { slug: 'eagle-tiers-backend' } }, branch: 'feature/eagle-tiers-backend', head: null }, activity: { prompt: 'eagle-tiers-backend', last_message: 'Done, migração e testes verdes', model: 'sonnet-5.5', tool: 'Bash' } }),
  cardSession({ id: 6, agent: 'claude', project_dir: path('Houston'), title: 'corrige o flicker da sidebar', status: 'working', status_since_ms: CARD_NOW, activity: { prompt: 'corrige o flicker da sidebar', last_message: 'Edit ghostty/surface.ts', model: 'opus-5.5', tool: 'Edit' } }),
  cardSession({ id: 7, agent: 'codex', project_dir: path('Houston'), title: 'inspector-polish', status: 'idle', status_since_ms: CARD_NOW - 6 * 60_000, checkout: { root: `${path('Houston')}/wt/inspector-polish`, kind: { worktree: { slug: 'inspector-polish' } }, branch: 'fix/inspector-polish', head: null }, activity: { prompt: 'inspector-polish', last_message: '4 commits, testes passando', model: 'gpt-6-luna', tool: 'codex' } }),
  cardSession({ id: 8, agent: 'codex', project_dir: path('Houston'), checkout_root: `${path('Houston')}/wt/pr-list`, title: 'tela de pull requests', status: 'needs-input', status_since_ms: CARD_NOW - 14 * 60_000, checkout: { root: `${path('Houston')}/wt/pr-list`, kind: { worktree: { slug: 'pr-list' } }, branch: 'houston/pr-list', head: null }, activity: { prompt: 'tela de pull requests', last_message: 'incluir filtro de autor?', model: 'gpt-6-luna', tool: 'codex' } }),
  cardSession({ id: 9, agent: 'claude', project_dir: path('finex'), title: 'arredondamento', status: 'idle', status_since_ms: CARD_NOW - 60 * 60_000, checkout: { root: path('finex'), kind: 'primary', branch: 'fix/rounding', head: null }, activity: { prompt: 'arredondamento', last_message: 'Done, testes verdes', model: 'sonnet-5.5', tool: 'Bash' } }),
]
const CARD_GRIDS: NonNullable<RailProps['gridsByWorkspace']> = {
  [path('dispatch')]: [{ id: 'terminal', name: 'Terminal', count: 1, state: 'idle', sessionIds: [1] }],
  [path('project_eagle')]: [{ id: 'mensageria', name: 'Mensageria access tiers', count: 4, state: 'working', sessionIds: [2, 3, 4, 5], tagIds: [3, 4, 5] }],
  [path('Houston')]: [
    { id: 'inspector-polish', name: 'Inspector polish', count: 2, state: 'working', sessionIds: [6, 7], tagIds: [1, 2] },
    { id: 'pr-screen', name: 'Pull requests screen', count: 1, state: 'needs-input', sessionIds: [8], tagIds: [1] },
  ],
  [path('finex')]: [{ id: 'rounding', name: 'Reconciliação', count: 1, state: 'stopped', sessionIds: [9] }],
}

function RailCardModes({ openTagPopover = false, openOptions = false }: { openTagPopover?: boolean; openOptions?: boolean }): React.JSX.Element {
  const [compact, setCompact] = React.useState(false)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      rememberRailGitFacts(new Map([
        [path('project_eagle'), { added: 932, deleted: 120, ahead: 0, behind: 0, changedFiles: 21 }],
        [path('Houston'), { added: 214, deleted: 38, ahead: 0, behind: 0, changedFiles: 7 }],
        [`${path('Houston')}/wt/pr-list`, { added: 1204, deleted: 88, ahead: 0, behind: 0, changedFiles: 32 }],
      ]))
      rememberRailPr(path('project_eagle'), { gh: 'ready', pr: { number: 41, url: 'https://github.com/example/project-eagle/pull/41', state: 'open', title: 'Mensageria access tiers', head_ref: 'feature/tiers', additions: 932, deletions: 120, is_draft: false, review_decision: null, checks: 'running' } })
      rememberRailPr(path('Houston'), { gh: 'ready', pr: { number: 95, url: 'https://github.com/example/houston/pull/95', state: 'open', title: 'Inspector polish', head_ref: 'main', additions: 214, deletions: 38, is_draft: false, review_decision: null, checks: 'passing' } })
      rememberRailPr(`${path('Houston')}/wt/pr-list`, { gh: 'ready', pr: { number: 93, url: 'https://github.com/example/houston/pull/93', state: 'open', title: 'Pull requests screen', head_ref: 'houston/pr-list', additions: 1204, deletions: 88, is_draft: true, review_decision: null, checks: 'running' } })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [])
  React.useEffect(() => {
    if (!openTagPopover && !openOptions) return
    const timer = window.setTimeout(() => {
      const selector = openTagPopover ? '[data-testid="rail-tags"]' : '[data-testid="tree-filter-toggle"]'
      document.querySelector<HTMLElement>(selector)?.click()
    }, 60)
    return () => window.clearTimeout(timer)
  }, [openTagPopover, openOptions])
  return (
    <div className="flex h-full flex-col" data-rail-mode={compact ? 'compact' : 'detailed'}>
      <RailFixture
        key={String(compact)}
        workspaces={CARD_WORKSPACES}
        pinned={[]}
        selected={path('Houston')}
        selectedGridId="inspector-polish"
        cardMode={compact ? 'compact' : 'detailed'}
        sessions={CARD_SESSIONS}
        gridsByWorkspace={CARD_GRIDS}
        pinnedGridIds={['terminal', 'mensageria']}
        showTags
        collapsed={[]}
      />
      <button type="button" onClick={() => setCompact((current) => !current)}>
        Toggle {compact ? 'detailed' : 'compact'}
      </button>
    </div>
  )
}

function ResizeHandleStory({ dragging }: { dragging: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (dragging) ref.current?.querySelector('[data-testid="rail-resize-handle"]')?.setAttribute('data-dragging', 'true')
  }, [dragging])
  return (
    <div ref={ref} style={{ position: 'relative', height: '100%', ['--w-rail' as string]: '240px', background: 'var(--content-bg)' }}>
      <div style={{ width: 240, height: '100%', background: 'var(--rail-bg)' }} />
      <RailResizeHandle width={240} collapsed={false} onChange={noop} onCollapse={noop} />
    </div>
  )
}

function WorkspacesEmptyStory({ variant }: { variant: 'plain' | 'pending' | 'refused' | 'shortcuts-off' }): React.JSX.Element {
  const overrides = { bindings: {}, shortcuts_enabled: variant !== 'shortcuts-off' }
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {variant === 'pending' && (
        <style>{'[data-testid="workspaces-empty"] [role="status"] { animation-play-state: paused !important; }'}</style>
      )}
      <WorkspacesEmpty
        onAdd={noop}
        pending={variant === 'pending'}
        refusals={variant === 'refused'
          ? [
            'refused: /home/dev/code/acme is already registered as a workspace',
            'refused: /tmp/scratch is not a git project folder',
          ]
          : []}
        error={variant === 'refused' ? 'The picker could not open: no display available' : null}
        keymapOverrides={overrides}
        footer={variant === 'plain' ? <div style={{ marginTop: 16, color: 'var(--text-muted)' }}>footer slot</div> : undefined}
      />
    </div>
  )
}

export const RAIL_STORIES: Record<string, () => React.JSX.Element> = {
  'rail/card-modes': () => <RailCardModes />,
  'rail/card-modes-options': () => <RailCardModes openOptions />,
  'rail/card-modes-tag-popover': () => <RailCardModes openTagPopover />,
  'rail/states': () => <RailFixture />,
  'rail/states-paper': () => <RailFixture chromeTheme="paper" />,
  'rail/tag-filter-active': () => <RailFixture tagFilter={[1]} />,
  'rail/plain-selected': () => <RailFixture selected={path('acme-ui')} />,
  'rail/renaming': () => <RailRename workspace="acme-ui" />,
  'rail/renaming-expanded': () => <RailRename workspace="acme-api" />,
  'rail/ws-menu': () => <RailMenu target='[data-ws-idx="3"]' />,
  'rail/ws-menu-pinned': () => <RailMenu target='[data-ws-idx="0"]' />,
  'rail/grid-menu': () => <RailMenu target={GRID_ROW} />,
  'rail/grid-rename': () => <RailMenu target={GRID_ROW} pick="Rename" freezeCaret />,
  'rail/nav-menu': () => <RailMenu target='[data-testid="rail-nav-row"]' />,
  'rail/tag-menu': () => <RailClick target='[data-testid="tree-filter-toggle"]' tagFilter={[2]} />,
  'rail/tag-menu-empty': () => <RailClick target='[data-testid="tree-filter-toggle"]' />,
  'rail/add-menu': () => <RailClick target='button[aria-label="Add workspace"]' />,
  'rail/drag': () => <RailDrag />,
  'rail/settings': () => <RailFixture settingsOpen />,
  'rail/settings-nomatch': () => <RailSettingsSearch query="zzzz" />,
  'rail/settings-hit': () => <RailSettingsSearch query="theme" />,
  'rail/empty': () => <RailFixture workspaces={[]} withGrids={false} />,
  'rail/empty-filtered': () => <RailFixture tagFilter={[2]} workspaces={[ws('acme-core')]} withGrids={false} />,
  'rail/update-failed': () => <UpdateFailed />,
  'rail/update-running': () => <UpdateRunning />,
  'rail/resize-handle': () => <ResizeHandleStory dragging={false} />,
  'rail/resize-handle-drag': () => <ResizeHandleStory dragging />,
  'shell/workspaces-empty': () => <WorkspacesEmptyStory variant="plain" />,
  'shell/workspaces-empty-pending': () => <WorkspacesEmptyStory variant="pending" />,
  'shell/workspaces-empty-refused': () => <WorkspacesEmptyStory variant="refused" />,
  'shell/workspaces-empty-shortcuts-off': () => <WorkspacesEmptyStory variant="shortcuts-off" />
}
