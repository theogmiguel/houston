// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Disclosure } from './Disclosure'

describe('Disclosure — state matrix', () => {
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

  it('Empty — closed, count not fetched yet: no badge shown', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" />)
    })
    expect(container.querySelector('[data-testid="disclosure"]')?.getAttribute('data-state')).toBe(
      'closed'
    )
    expect(container.querySelector('[data-testid="disclosure-count"]')).toBeNull()
  })

  it('Filled — open, with a count badge and body content shown', () => {
    act(() => {
      root.render(
        <Disclosure summary="Sessions" count={3} defaultOpen>
          <div>row 1</div>
        </Disclosure>
      )
    })
    expect(container.querySelector('[data-testid="disclosure-count"]')?.textContent).toBe('3')
    expect(container.querySelector('[data-testid="disclosure-body"]')?.textContent).toContain(
      'row 1'
    )
  })

  it('Hover — the summary button carries hover treatment', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" />)
    })
    expect(container.querySelector('button')?.className).toContain('hover:bg-')
  })

  it('Focus — the summary button carries a visible focus ring', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" />)
    })
    expect(container.querySelector('button')?.className).toContain('focus-visible:shadow-')
  })

  it('Active — the summary button carries a press-scale treatment', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" />)
    })
    expect(container.querySelector('button')?.className).toContain('active:scale-')
  })

  it('Selected — N/A: a disclosure is open or closed, not chosen among siblings; selection belongs to whatever list holds multiple disclosures.', () => {
    expect(true).toBe(true)
  })

  it('Disabled — carries its reason as a title and cannot be opened', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" disabled disabledReason="No project open" />)
    })
    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('No project open')
    act(() => btn.click())
    expect(
      container.querySelector('[data-testid="disclosure"]')?.getAttribute('data-state')
    ).toBe('closed')
  })

  it('Loading — open with a loading body shows a spinner and no content', () => {
    act(() => {
      root.render(
        <Disclosure summary="Sessions" defaultOpen loading>
          <div>row 1</div>
        </Disclosure>
      )
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="disclosure-body"]')).toBeNull()
  })

  it('Error — turns red, names the failing step, offers retry, and still reports elapsed time', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(
        <Disclosure
          summary="Sessions"
          defaultOpen
          error={{ message: 'connection refused', failingStep: 'daemon handshake', elapsedMs: 4200, onRetry }}
        />
      )
    })
    expect(container.querySelector('[data-testid="disclosure"]')?.className).toContain(
      'border-[var(--danger)]'
    )
    expect(container.textContent).toContain('daemon handshake')
    expect(container.textContent).toContain('connection refused')
    expect(container.querySelector('[data-testid="disclosure-elapsed"]')?.textContent).toBe('4.2s')
    const retry = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Try again'
    ) as HTMLButtonElement
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Overflow — the body scrolls internally instead of the card growing', () => {
    act(() => {
      root.render(
        <Disclosure summary="Sessions" defaultOpen maxBodyHeight={100}>
          <div>row 1</div>
        </Disclosure>
      )
    })
    const body = container.querySelector('[data-testid="disclosure-body"]') as HTMLElement
    expect(body.className).toContain('overflow-y-auto')
    expect(body.style.maxHeight).toBe('100px')
  })

  it('Empty set — open with a known-zero count shows the empty-set label, not an empty body', () => {
    act(() => {
      root.render(<Disclosure summary="Sessions" count={0} defaultOpen />)
    })
    expect(container.querySelector('[data-testid="disclosure-empty-set"]')?.textContent).toBe(
      'Nothing here yet'
    )
    expect(container.querySelector('[data-testid="disclosure-body"]')).toBeNull()
  })

  it('Error — keeps the body visible instead of replacing it', () => {
    act(() => {
      root.render(
        <Disclosure
          summary="Sessions"
          defaultOpen
          error={{ message: 'connection refused', elapsedMs: 4200, onRetry: () => {} }}
        >
          <div data-testid="payload">the rail that must survive</div>
        </Disclosure>
      )
    })
    expect(container.querySelector('[data-testid="payload"]')).not.toBeNull()
    expect(container.textContent).toContain('the rail that must survive')
    expect(container.textContent).toContain('connection refused')
  })

  it('Error — omits the elapsed readout when the caller reports it elsewhere', () => {
    act(() => {
      root.render(
        <Disclosure summary="Sessions" defaultOpen error={{ message: 'nope', onRetry: () => {} }} />
      )
    })
    expect(container.querySelector('[data-testid="disclosure-elapsed"]')).toBeNull()
    expect(container.textContent).toContain('nope')
  })
})
