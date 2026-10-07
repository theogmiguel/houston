// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrInfo, SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { createSessionsStore, SessionsStoreContext } from '../../sessionsStore'
import { GridRailRow } from './GridRailRow'
import { GridRailRowFallback } from './GridRailRowFallback'
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

function mount({ tags = [], cardMode = 'detailed' }: { tags?: TagInfo[]; cardMode?: 'detailed' | 'compact' } = {}): {
  inspector: ReturnType<typeof vi.fn>
  contextMenu: ReturnType<typeof vi.fn>
} {
  const inspector = vi.fn()
  const contextMenu = vi.fn()
  const store = createSessionsStore(new Map([[session.id, session]]))
  root = createRoot(container)
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
      properties={['status', 'unread', 'checkout', 'pr', 'ci', 'diff', 'task', 'inline-agents', 'tags']}
      jumpNumber={1}
      onSelect={() => {}}
      onContextMenu={contextMenu}
      onOpenInspector={inspector}
    />
  </SessionsStoreContext.Provider>)))
  return { inspector, contextMenu }
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

describe('GridRailRowFallback', () => {
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
    expect(container.textContent).toContain('passing')
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
