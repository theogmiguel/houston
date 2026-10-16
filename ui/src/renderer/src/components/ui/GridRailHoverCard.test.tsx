// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GridRailHoverCard,
  RAIL_HOVER_CLOSE_DELAY_MS,
  RAIL_HOVER_OPEN_DELAY_MS,
  RAIL_HOVER_WARM_WINDOW_MS,
} from './GridRailHoverCard'
import type { RailCard } from '../rail/railCardModel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GridRailHoverCard', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) act(() => root!.unmount())
    root = null
    container?.remove()
    container = null
    document.body.querySelector('[data-testid="grid-hover-card"]')?.remove()
  })

  it('renders compact checkout, PR and pane-count rows without a context hint', () => {
    const card = {
      gridId: 'grid-1',
      workspace: '/repo',
      title: 'Checkout identity',
      pinned: false,
      status: { kind: 'working', label: 'Working', since: null },
      checkouts: [{ kind: 'worktree', root: '/repo-wt', slug: 'identity', branch: 'feat/identity', detached: false }],
      pr: {
        gh: 'available',
        pr: {
          number: 7,
          url: 'https://github.com/example/repo/pull/7',
          state: 'OPEN',
          checks: 'passing',
          title: 'Track checkout identity',
          additions: 12,
          deletions: 3,
        },
      },
      diff: { added: 12, deleted: 3 },
      agents: [],
      lastActivityMs: 0,
    } as unknown as RailCard
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() =>
      root!.render(
        <GridRailHoverCard
          card={card}
          position={{ left: 10, top: 20 }}
        />,
      ),
    )

    const hoverCard = document.body.querySelector<HTMLElement>('[data-testid="grid-hover-card"]')!
    expect(hoverCard.className).toContain('w-[300px]')
    expect(hoverCard.textContent).toContain('Checkout identity')
    expect(hoverCard.textContent).toContain('wt/identity · feat/identity')
    expect(hoverCard.textContent).toContain('#7')
    expect(hoverCard.textContent).toContain('Track checkout identity')
    expect(hoverCard.textContent).toContain('+12')
    expect(hoverCard.textContent).toContain('0 panes')
    expect(hoverCard.textContent).not.toContain('Right-click')
  })

  it('is a read-only tooltip: the PR is text, not a control', () => {
    const card = {
      gridId: 'g', workspace: '/repo', title: 'PR grid', pinned: false,
      status: { kind: 'working', label: 'Working', since: null },
      checkouts: [], diff: null, agents: [], lastActivityMs: 0,
      pr: { gh: 'available', pr: { number: 7, url: 'https://github.com/example/repo/pull/7', state: 'OPEN', checks: 'passing', title: 'Track it', additions: 1, deletions: 1 } },
    } as unknown as RailCard
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<GridRailHoverCard card={card} position={{ left: 10, top: 20 }} />))
    const hoverCard = document.body.querySelector<HTMLElement>('[data-testid="grid-hover-card"]')!
    expect(hoverCard.getAttribute('role')).toBe('tooltip')
    expect(hoverCard.className).toContain('pointer-events-none')
    expect(hoverCard.textContent).toContain('#7')
    expect(hoverCard.querySelector('button, a')).toBeNull()
  })

  it('clamps its top against its measured height, not a fixed one', () => {
    const card = {
      gridId: 'g', workspace: '/repo', title: 'Tall', pinned: false,
      status: { kind: 'working', label: 'Working', since: null },
      checkouts: [], pr: null, diff: null, agents: [], lastActivityMs: 0,
    } as unknown as RailCard
    const innerHeight = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 500 } as DOMRect)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root!.render(<GridRailHoverCard card={card} position={{ left: 10, top: 600 }} />))
    const hoverCard = document.body.querySelector<HTMLElement>('[data-testid="grid-hover-card"]')!
    expect(hoverCard.style.top).toBe('192px')
    innerHeight.mockRestore()
    rect.mockRestore()
  })

  it('exports the T3 hover timing values', () => {
    expect([RAIL_HOVER_OPEN_DELAY_MS, RAIL_HOVER_CLOSE_DELAY_MS, RAIL_HOVER_WARM_WINDOW_MS]).toEqual([150, 0, 400])
  })
})
