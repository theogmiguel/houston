// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
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
          closeTimer={{ current: null }}
          scheduleClose={() => {}}
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

  it('exports the T3 hover timing values', () => {
    expect([RAIL_HOVER_OPEN_DELAY_MS, RAIL_HOVER_CLOSE_DELAY_MS, RAIL_HOVER_WARM_WINDOW_MS]).toEqual([150, 0, 400])
  })
})
