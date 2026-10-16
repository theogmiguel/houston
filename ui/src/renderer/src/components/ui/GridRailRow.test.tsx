// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrInfo, SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { createSessionsStore, SessionsStoreContext } from '../../sessionsStore'
import { GridRailRow } from './GridRailRow'
import { GridRailRowFallback } from './GridRailRowFallback'
import { RAIL_DRAG_REFUSAL } from '../rail/railCardModel'
import { TagPopoverHost } from '../tags/TagPopover'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const session = {
  id: 7, agent: 'claude', project_dir: '/work', cwd: '/work', checkout_root: '/work', state: 'running',
  status: 'working', status_since_ms: 1, title: 'Rail task', codename: 'Rail', hidden: false,
  live_children: 0, children_waiting: 0, spawned_by: null
} as unknown as SessionInfo
const TAGS: TagInfo[] = [{ id: 1, name: 'Bug', color: '#f472b6' }, { id: 2, name: 'Teste', color: '#f59e0b' }]
const pr: PrInfo = {
  number: 41,
  url: 'https://example.test/pull/41',
  state: 'OPEN',
  review_decision: null,
  checks: 'passing',
  title: 'Rail update',
  head_ref: 'feature/rail',
  additions: 0,
  deletions: 0,
  is_draft: false,
}

function withTagPopover(children: React.ReactNode): React.JSX.Element {
  return <TagPopoverHost tags={TAGS} grids={[]} actions={{
    onCreate: (name, color) => ({ id: 99, name, color }),
    onUpdate: () => {},
    onDelete: () => {},
    onApply: () => {},
  }}>{children}</TagPopoverHost>
}

function mount({ tags = [], cardMode = 'detailed', reuseRoot = false, ...extra }: { tags?: TagInfo[]; cardMode?: 'detailed' | 'compact'; reuseRoot?: boolean } & Partial<React.ComponentProps<typeof GridRailRow>> = {}): {
  focus: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  inspector: ReturnType<typeof vi.fn>
  contextMenu: ReturnType<typeof vi.fn>
} {
  const focus = vi.fn()
  const select = vi.fn()
  const inspector = vi.fn()
  const contextMenu = vi.fn()
  const store = createSessionsStore(new Map([[session.id, session]]))
  if (!reuseRoot) root = createRoot(container)
  act(() => root.render(withTagPopover(<SessionsStoreContext.Provider value={store}>
    <GridRailRow
      name="Rail"
      workspace="/work"
      gridId="grid-1"
      selected
      paneIds={[session.id]}
      tags={tags}
      fallbackSessions={[session]}
      branches={new Map([[session.id, 'feature/rail']])}
      diffByDir={new Map()}
      prByDir={new Map([['/work', { gh: 'ready', pr }]])}
      cardMode={cardMode}
      tagDisplay="icon"
      properties={['status', 'unread', 'checkout', 'pr', 'diff', 'inline-agents', 'tags']}
      jumpNumber={1}
      onSelect={select}
      onFocusPane={focus}
      onContextMenu={contextMenu}
      onOpenInspector={inspector}
      {...extra}
    />
  </SessionsStoreContext.Provider>)))
  return { inspector, contextMenu, focus, select }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('grid rail row interactions', () => {
  it('moves keyboard focus across separately wrapped grid rows', () => {
    mount()
    const row = container.querySelector<HTMLElement>('[data-testid="grid-row"]')!
    const list = document.createElement('div')
    list.dataset.railGridList = ''
    const wrapper = document.createElement('div')
    row.parentElement!.append(list)
    list.append(wrapper)
    wrapper.append(row)
    const otherWrapper = document.createElement('div')
    const next = document.createElement('div')
    next.dataset.testid = 'grid-row'
    next.tabIndex = 0
    list.append(otherWrapper)
    otherWrapper.append(next)
    act(() => row.focus())
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(next)
    wrapper.parentElement!.parentElement!.append(row)
    list.remove()
  })

  it('selects the grid and focuses the clicked agent, once each', () => {
    const { focus, select } = mount()
    const agent = container.querySelector<HTMLElement>('[aria-label="Focus Rail task"]')!
    act(() => agent.click())
    expect(select).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledExactlyOnceWith(session.id)
    act(() => agent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(select).toHaveBeenCalledOnce()
  })

  it('opens and closes its hover card after the hover delay', async () => {
    vi.useFakeTimers()
    mount({ cardMode: 'compact' })
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(260))
    await vi.waitFor(() => expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull()
    act(() => row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(90))
    expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(60))
    expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
  })

  it('a pointer that only crosses the row never opens the hover card', async () => {
    vi.useFakeTimers()
    mount()
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(50))
    act(() => row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
  })

  it('hides the status label while the remove button shows on hover', () => {
    const store = createSessionsStore(new Map())
    root = createRoot(container)
    act(() => root.render(withTagPopover(<SessionsStoreContext.Provider value={store}>
      <GridRailRow name="Empty" workspace="/work" gridId="empty-grid" selected={false} paneIds={[]} fallbackSessions={[]} branches={new Map()} diffByDir={new Map()} prByDir={new Map()} onSelect={() => {}} onRemove={() => {}} onOpenInspector={() => {}} />
    </SessionsStoreContext.Provider>)))
    expect(container.querySelector('[data-testid="grid-state-dot"]')).not.toBeNull()
    expect(container.textContent).not.toContain('No live panes')
  })

  it('opens the grid context menu on right click', () => {
    const { contextMenu } = mount()
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
    expect(contextMenu).toHaveBeenCalledOnce()
  })

  it('shows jump numbers while Alt is held', () => {
    mount()
    const number = container.querySelector('[data-testid="rail-jump-number"]')!
    expect(number.classList.contains('hidden')).toBe(true)
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' })))
    expect(number.classList.contains('hidden')).toBe(false)
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' })))
    expect(number.classList.contains('hidden')).toBe(true)
  })

  it('opens the cached PR in the inspector', () => {
    const { inspector } = mount()
    const link = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('#41'))!
    act(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(inspector).toHaveBeenCalledWith(session.id, 'pull-request')
  })
})

function hoverRow(): void {
  const row = container.querySelector('[data-testid="grid-row"]')!
  act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  act(() => vi.advanceTimersByTime(260))
}

describe('grid rail row hover suppression', () => {
  it('never opens the hover card while hover is suppressed', async () => {
    vi.useFakeTimers()
    mount({ cardMode: 'compact', hoverSuppressed: true })
    hoverRow()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
  })

  it('closes an open hover card when hover becomes suppressed', async () => {
    vi.useFakeTimers()
    mount({ cardMode: 'compact' })
    hoverRow()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull())
    mount({ cardMode: 'compact', hoverSuppressed: true, reuseRoot: true })
    act(() => vi.advanceTimersByTime(300))
    expect(document.querySelector('[data-testid="grid-hover-card"]')).toBeNull()
  })
})

describe('grid rail row age labels', () => {
  it('keeps counting while the parent re-renders with a new onSelect every 10 s', () => {
    vi.useFakeTimers()
    const idle = { ...session, id: 8, status: 'idle', status_since_ms: Date.now() } as unknown as SessionInfo
    const store = createSessionsStore(new Map([[idle.id, idle]]))
    root = createRoot(container)
    const render = (): void => act(() => root.render(withTagPopover(<SessionsStoreContext.Provider value={store}>
      <GridRailRow name="Idle" workspace="/work" gridId="idle-grid" selected={false} paneIds={[idle.id]} fallbackSessions={[idle]} branches={new Map()} diffByDir={new Map()} prByDir={new Map()} onSelect={() => {}} onOpenInspector={() => {}} />
    </SessionsStoreContext.Provider>)))
    render()
    for (let elapsed = 0; elapsed < 80_000; elapsed += 10_000) {
      act(() => vi.advanceTimersByTime(10_000))
      render()
    }
    expect(container.querySelector('time')?.textContent).toBe('1m')
  })
})

describe('grid rail row card affordances', () => {
  it('offers no unread toggle while the unread property is off', () => {
    mount({ properties: ['status', 'checkout', 'pr', 'inline-agents'] })
    expect(container.querySelector('[data-testid="grid-unread-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="grid-state-dot"]')).not.toBeNull()
  })

  it('offers the unread toggle while the unread property is on', () => {
    mount()
    expect(container.querySelector('[data-testid="grid-unread-toggle"]')).not.toBeNull()
  })

  it('says No agents for a grid with no panes, but not in compact mode', () => {
    const store = createSessionsStore(new Map())
    root = createRoot(container)
    const render = (cardMode: 'detailed' | 'compact'): void => act(() => root.render(withTagPopover(<SessionsStoreContext.Provider value={store}>
      <GridRailRow name="Empty" workspace="/work" gridId="empty-grid" selected={false} paneIds={[]} fallbackSessions={[]} branches={new Map()} diffByDir={new Map()} prByDir={new Map()} cardMode={cardMode} onSelect={() => {}} onOpenInspector={() => {}} />
    </SessionsStoreContext.Provider>)))
    render('detailed')
    expect(container.querySelector('[data-testid="grid-no-agents"]')?.textContent).toBe('No agents')
    render('compact')
    expect(container.querySelector('[data-testid="grid-no-agents"]')).toBeNull()
  })

  it('shows the drag refusal reason as a tooltip', () => {
    vi.useFakeTimers()
    mount({ dragRefusal: RAIL_DRAG_REFUSAL.notManual })
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(500))
    expect(document.body.textContent).toContain('Switch to Manual sort to reorder')
  })
})

describe('GridRailRowFallback', () => {
  it.each(['Enter', ' '])('selects on %j like the real row', (key) => {
    const select = vi.fn()
    root = createRoot(container)
    act(() => root.render(<GridRailRowFallback name="Review" selected={false} jumpNumber={1} onSelect={select} onContextMenu={() => {}} />))
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    expect(select).toHaveBeenCalledOnce()
  })

  it('marks grid tags with one tag glyph in the first tag colour and counts the rest', async () => {
    mount({ tags: TAGS })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="rail-tags"]')).not.toBeNull())
    const mark = container.querySelector<HTMLElement>('[data-testid="rail-tags"]')!
    expect(mark.firstElementChild?.getAttribute('style')).toBe('color: rgb(244, 114, 182);')
    expect(mark.textContent).toBe('+1')
    expect(mark.getAttribute('aria-label')).toBe('Edit tags: Bug, Teste')
  })

  it('shows PR checks alongside the PR link', () => {
    mount()
    expect(container.querySelector('[aria-label="Checks passing"]')).not.toBeNull()
  })

  it('shows the cached PR title in the compact hover card', async () => {
    vi.useFakeTimers()
    mount({ cardMode: 'compact' })
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(260))
    await vi.waitFor(() => expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="grid-hover-card"]')?.textContent).toContain('Rail update')
  })

  it('claims no status while the row loads', () => {
    root = createRoot(container)
    act(() => root.render(<GridRailRowFallback name="Review" selected={false} jumpNumber={1} onSelect={() => {}} onContextMenu={() => {}} />))
    const dot = container.querySelector<HTMLElement>('[data-testid="grid-state-dot"]')
    expect(dot?.dataset.state).toBe('loading')
    expect(dot?.getAttribute('aria-label')).toBe('Loading status')
  })
})
