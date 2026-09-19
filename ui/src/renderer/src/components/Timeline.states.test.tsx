// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Timeline, type TimelineStep } from './Timeline'

const STEPS: TimelineStep[] = [
  { id: 'a', label: 'Read files', status: 'done' },
  { id: 'b', label: 'Edit code', status: 'done' }
]

describe('Timeline — state matrix', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('Empty — no run started yet: collapsed summary says so, and opening shows a placeholder, not a rail', () => {
    act(() => {
      root.render(<Timeline defaultOpen />)
    })
    expect(container.querySelector('[data-testid="timeline-summary"]')?.textContent).toBe('Not started')
    expect(container.querySelector('[data-testid="timeline-empty"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="timeline-rail"]')).toBeNull()
  })

  it('Filled — collapsed summary reports elapsed time; open shows the rail with a terminal check', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} elapsedMs={218000} defaultOpen />)
    })
    expect(container.querySelector('[data-testid="timeline-summary"]')?.textContent).toBe('Worked for 3m 38s')
    const steps = container.querySelectorAll('[data-testid="timeline-step"]')
    expect(steps.length).toBe(2)
    expect(container.querySelector('[data-testid="disclosure-count"]')?.textContent).toBe('2')
  })

  it('Hover — the summary button (from Disclosure) carries hover treatment', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} />)
    })
    expect(container.querySelector('button')?.className).toContain('hover:bg-')
  })

  it('Focus — the summary button carries a visible focus ring', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} />)
    })
    expect(container.querySelector('button')?.className).toContain('focus-visible:shadow-')
  })

  it('Active — the summary button carries a press-scale treatment', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} />)
    })
    expect(container.querySelector('button')?.className).toContain('active:scale-')
  })

  it('Selected — N/A: a timeline is one run, not chosen among sibling runs; selection belongs to whatever list holds multiple timelines.', () => {
    expect(true).toBe(true)
  })

  it('Disabled — carries its reason as a title and cannot be opened', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} disabled disabledReason="Run not readable" />)
    })
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Run not readable')
    act(() => btn.click())
    expect(container.querySelector('[data-testid="disclosure"]')?.getAttribute('data-state')).toBe('closed')
  })

  it('Loading — open with loading shows a spinner and no rail', () => {
    act(() => {
      root.render(<Timeline steps={STEPS} defaultOpen loading />)
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="timeline-rail"]')).toBeNull()
  })

  it('Error — the failure twin: red header, red terminal step, Try again, and elapsed time still shown', () => {
    const onRetry = vi.fn()
    const failingSteps: TimelineStep[] = [
      { id: 'a', label: 'Read files', status: 'done' },
      { id: 'b', label: 'Push to remote', status: 'error' }
    ]
    act(() => {
      root.render(
        <Timeline
          steps={failingSteps}
          elapsedMs={250000}
          defaultOpen
          failure={{ message: 'connection refused', onRetry }}
        />
      )
    })
    expect(container.querySelector('[data-testid="timeline-summary"]')?.textContent).toBe('Worked 4m 10s')
    expect(container.querySelector('[data-testid="timeline-summary"]')?.className).toContain(
      'text-[var(--status-blocked-text)]'
    )
    const steps = container.querySelectorAll('[data-testid="timeline-step"]')
    expect(
      steps[steps.length - 1].querySelector('[data-testid="timeline-step-label"]')?.className
    ).toContain('text-[var(--status-blocked-text)]')
    expect(container.querySelector('[data-testid="disclosure-body"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="timeline-rail"]')).not.toBeNull()
    expect(container.textContent).toContain('connection refused')
    expect(container.textContent).toContain('Push to remote')
    expect(container.querySelector('[data-testid="disclosure"]')?.className).toContain(
      'border-[var(--danger)]'
    )
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again'
    ) as HTMLButtonElement
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="disclosure-elapsed"]')).toBeNull()
    expect(container.textContent).toContain('Worked 4m 10s')
  })

  it('Overflow — the rail scrolls internally instead of the card growing (inherited from Disclosure)', () => {
    const manySteps: TimelineStep[] = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      label: `Step ${i}`,
      status: 'done' as const
    }))
    act(() => {
      root.render(<Timeline steps={manySteps} defaultOpen />)
    })
    const body = container.querySelector('[data-testid="disclosure-body"]') as HTMLElement
    expect(body.className).toContain('overflow-y-auto')
  })

  it('Empty set — a run that produced zero steps shows the empty-set label, not an empty rail', () => {
    act(() => {
      root.render(<Timeline steps={[]} defaultOpen />)
    })
    expect(container.querySelector('[data-testid="disclosure-empty-set"]')?.textContent).toBe('No steps yet')
    expect(container.querySelector('[data-testid="timeline-rail"]')).toBeNull()
  })
})
