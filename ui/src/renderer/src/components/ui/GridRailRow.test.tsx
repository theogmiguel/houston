// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../../houston/client'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { createSessionsStore, SessionsStoreContext } from '../../sessionsStore'
import { GridRailRow } from './GridRailRow'
import { GridRailRowFallback } from './GridRailRowFallback'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const session = {
  id: 7, agent: 'claude', project_dir: '/work', cwd: '/work', checkout_root: '/work', state: 'running',
  status: 'working', status_since_ms: 1, title: 'Rail task', codename: 'Rail', hidden: false,
  live_children: 0, children_waiting: 0, spawned_by: null
} as unknown as SessionInfo
const TAGS: TagInfo[] = [{ id: 1, name: 'Bug', color: '#f472b6' }, { id: 2, name: 'Teste', color: '#f59e0b' }]
const pr = { number: 41, url: 'https://example.test/pull/41', state: 'OPEN', review_decision: null, checks: 'passing' } as const

function mount({ tags = [], width = 240 }: { tags?: TagInfo[]; width?: number } = {}): { inspector: ReturnType<typeof vi.fn>; external: ReturnType<typeof vi.fn>; contextMenu: ReturnType<typeof vi.fn> } {
  const inspector = vi.fn()
  const external = vi.fn()
  const contextMenu = vi.fn()
  const store = createSessionsStore(new Map([[session.id, session]]))
  root = createRoot(container)
  act(() => root.render(<SessionsStoreContext.Provider value={store}>
    <GridRailRow name="Rail" selected paneIds={[session.id]} tags={tags} fallbackSessions={[session]} branches={new Map([[session.id, 'feature/rail']])} diffByDir={new Map()} prByDir={new Map([['/work', { gh: 'ready', pr }]])} width={width} jumpNumber={1} onSelect={() => {}} onContextMenu={contextMenu} onOpenInspector={inspector} onOpenExternal={external} />
  </SessionsStoreContext.Provider>))
  return { inspector, external, contextMenu }
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
    mount()
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(260))
    await vi.waitFor(() => expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="grid-hover-card"]')).not.toBeNull()
    act(() => row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    act(() => vi.advanceTimersByTime(90))
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
    act(() => root.render(<SessionsStoreContext.Provider value={store}>
      <GridRailRow name="Empty" selected={false} paneIds={[]} fallbackSessions={[]} branches={new Map()} diffByDir={new Map()} prByDir={new Map()} width={240} onSelect={() => {}} onRemove={() => {}} onOpenInspector={() => {}} onOpenExternal={() => {}} />
    </SessionsStoreContext.Provider>))
    expect(container.querySelector('[data-testid="grid-state-dot"]')?.className).toContain('group-hover:invisible')
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

  it('opens the cached PR in the browser on Ctrl+click', async () => {
    const { external, inspector } = mount()
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Open pull request 41"]')).not.toBeNull())
    const badge = container.querySelector('[aria-label="Open pull request 41"]')!
    act(() => badge.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })))
    expect(external).toHaveBeenCalledWith(pr.url)
    expect(inspector).not.toHaveBeenCalled()
  })
})

describe('GridRailRowFallback', () => {
  it('marks grid tags with one tag glyph in the first tag colour and counts the rest', async () => {
    mount({ tags: TAGS })
    await vi.waitFor(() => expect(container.querySelector('[data-testid="rail-tags"]')).not.toBeNull())
    const mark = container.querySelector<HTMLElement>('[data-testid="rail-tags"]')!
    expect(mark.querySelector<HTMLElement>('[data-testid="rail-tag-glyph"]')!.style.color).toBe('rgb(244, 114, 182)')
    expect(mark.textContent).toBe('+1')
    expect(mark.getAttribute('aria-label')).toBe('Tags: Bug, Teste')
  })

  it('drops the tag mark below its width so the branch keeps its room', async () => {
    mount({ tags: TAGS, width: 200 })
    await vi.waitFor(() => expect(container.querySelector('.rail-grid-line2')).not.toBeNull())
    expect(container.querySelector('[data-testid="rail-tags"]')).toBeNull()
  })

  it('shows PR checks as a glyph, never as a dot that reads like agent status', async () => {
    mount()
    await vi.waitFor(() => expect(container.querySelector('.rail-pr')).not.toBeNull())
    const badge = container.querySelector('.rail-pr')!
    expect(badge.querySelectorAll('svg')).toHaveLength(2)
    expect(badge.querySelector('.rounded-full')).toBeNull()
  })

  it('leaves agent icons to the hover card even on a wide rail', async () => {
    mount({ width: 420 })
    await vi.waitFor(() => expect(container.querySelector('.rail-grid-line2')).not.toBeNull())
    expect(container.querySelector('.rail-agents')).toBeNull()
  })

  it('names the grid tags in the hover card', async () => {
    vi.useFakeTimers()
    mount({ tags: TAGS })
    const row = container.querySelector('[data-testid="grid-row"]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(260))
    await vi.waitFor(() => expect(document.querySelector('[data-testid="grid-hover-tags"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="grid-hover-tags"]')!.textContent).toBe('BugTeste')
  })

  it('claims no status while the row loads', () => {
    root = createRoot(container)
    act(() => root.render(<GridRailRowFallback name="Review" selected={false} jumpNumber={1} onSelect={() => {}} onContextMenu={() => {}} />))
    const dot = container.querySelector<HTMLElement>('[data-testid="grid-state-dot"]')
    expect(dot?.dataset.state).toBe('loading')
    expect(dot?.getAttribute('aria-label')).toBe('Loading status')
  })
})
