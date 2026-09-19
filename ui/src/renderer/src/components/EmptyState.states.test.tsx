// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

describe('EmptyState — state matrix', () => {
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

  it('Filled — renders the display-step headline, description and one primary action', () => {
    act(() => {
      root.render(
        <EmptyState
          headline="An agent, not a workspace"
          description="A name, an engine, two memory files."
          action={{ label: 'Create your first agent', onClick: () => {} }}
        />
      )
    })
    const headline = container.querySelector('[data-testid="empty-state-headline"]')
    expect(headline?.textContent).toBe('An agent, not a workspace')
    expect(headline?.className).toContain('text-[length:var(--tr-text-display-size)]')
    expect(container.textContent).toContain('A name, an engine, two memory files.')
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('[data-testid="empty-state-action"]')?.textContent).toContain(
      'Create your first agent'
    )
  })

  it('Empty — N/A: an EmptyState IS the empty display for its screen, not a variant of itself; a screen with real content renders something else entirely.', () => {
    expect(true).toBe(true)
  })

  it('Filled — description is optional; the headline and action stand alone without it', () => {
    act(() => {
      root.render(<EmptyState headline="Nothing here yet" action={{ label: 'Add one', onClick: () => {} }} />)
    })
    expect(container.querySelector('[data-testid="empty-state-headline"]')?.textContent).toBe(
      'Nothing here yet'
    )
    expect(container.querySelector('p')).toBeNull()
  })

  it('Loading — the action swaps its label for a spinner, disables, and marks aria-busy', () => {
    act(() => {
      root.render(
        <EmptyState headline="Working" action={{ label: 'Create', onClick: () => {} }} loading />
      )
    })
    const btn = container.querySelector('[data-testid="empty-state-action"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
  })

  it('Disabled — the action carries its reason as a title and blocks the click handler', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(
        <EmptyState
          headline="Locked"
          action={{ label: 'Create', onClick, disabled: true, disabledReason: 'Workspace required' }}
        />
      )
    })
    const btn = container.querySelector('[data-testid="empty-state-action"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Workspace required')
    act(() => btn.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('Hover / Selected — N/A: the single action is BTN_PRIMARY, whose hover treatment is buttonChrome.ts\'s own concern, not restated per consumer.', () => {
    act(() => {
      root.render(<EmptyState headline="x" action={{ label: 'Go', onClick: () => {} }} />)
    })
    expect(container.querySelector('[data-testid="empty-state-action"]')?.className).toContain(
      'hover:bg-'
    )
  })

  it('Overflow — an icon slot is optional and renders nothing by default (no invented placeholder)', () => {
    act(() => {
      root.render(<EmptyState headline="x" action={{ label: 'Go', onClick: () => {} }} />)
    })
    expect(container.querySelector('[aria-hidden]')).toBeNull()
    act(() => {
      root.render(
        <EmptyState headline="x" action={{ label: 'Go', onClick: () => {} }} icon={<span>*</span>} />
      )
    })
    expect(container.querySelector('[aria-hidden]')).not.toBeNull()
  })

  it("Error — N/A: an empty state has no async fetch of its own to fail; the primary action's own onClick is where a caller surfaces a failure (a toast, or a Disclosure elsewhere on the screen).", () => {
    expect(true).toBe(true)
  })

  it('Active — clicking the primary action fires onClick exactly once', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(<EmptyState headline="x" action={{ label: 'Go', onClick }} />)
    })
    const btn = container.querySelector('[data-testid="empty-state-action"]') as HTMLButtonElement
    act(() => btn.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  function headline(): HTMLElement {
    const el = container.querySelector('[data-testid="empty-state-headline"]')
    if (!(el instanceof HTMLElement)) throw new Error('no headline')
    return el
  }

  it('Size — full keeps the 44px display serif, and is the default', () => {
    act(() => {
      root.render(<EmptyState headline="x" action={{ label: 'Go', onClick: () => {} }} />)
    })
    expect(container.querySelector('[data-testid="empty-state"]')?.getAttribute('data-size')).toBe('full')
    expect(headline().className).toContain('var(--tr-text-display-size)')
    expect(headline().className).toContain('var(--tr-text-display-family)')
  })

  it('Size — compact steps down to the subhead rung and drops the display serif', () => {
    act(() => {
      root.render(
        <EmptyState size="compact" headline="x" description="y" action={{ label: 'Go', onClick: () => {} }} />
      )
    })
    expect(headline().className).toContain('var(--tr-text-subhead-size)')
    expect(headline().className).not.toContain('var(--tr-text-display-size)')
    expect(headline().className).not.toContain('display-family')
    expect(container.querySelector('p')?.className).toContain('var(--tr-text-small-size)')
    expect(container.querySelector('[data-testid="empty-state-action"]')?.className).toContain(
      'h-[var(--h-ctl)]'
    )
  })

  it('Size — compact still renders the one required action', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(<EmptyState size="compact" headline="x" action={{ label: 'New chat', onClick }} />)
    })
    const btn = container.querySelector('[data-testid="empty-state-action"]') as HTMLButtonElement
    expect(btn.textContent).toContain('New chat')
    act(() => btn.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
