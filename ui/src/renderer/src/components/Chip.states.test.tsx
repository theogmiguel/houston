// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chip } from './Chip'

describe('Chip — state matrix', () => {
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

  it('Empty — count variant with no count fetched yet renders a neutral placeholder', () => {
    act(() => {
      root.render(<Chip variant="count" label="sessions" />)
    })
    expect(container.querySelector('[data-testid="chip-empty"]')?.textContent).toBe('–')
  })

  it('Filled — count variant with a value renders the number', () => {
    act(() => {
      root.render(<Chip variant="count" label="sessions" count={7} />)
    })
    expect(container.querySelector('[data-testid="chip"]')?.textContent).toContain('7')
  })

  it('Hover — a pressable chip carries hover treatment in its class list', () => {
    act(() => {
      root.render(<Chip variant="removable" label="foo" onRemove={() => {}} />)
    })
    expect(container.querySelector('[data-testid="chip"]')?.className).toContain('hover:bg-')
  })

  it('Focus — the remove button carries a visible focus ring', () => {
    act(() => {
      root.render(<Chip variant="removable" label="foo" onRemove={() => {}} />)
    })
    const remove = container.querySelector('[aria-label="Remove foo"]')
    expect(remove?.className).toContain('focus-visible:shadow-')
  })

  it('Active — a pressable chip carries a press-scale treatment', () => {
    act(() => {
      root.render(<Chip variant="compound" label="foo" onClick={() => {}} />)
    })
    expect(container.querySelector('[data-testid="chip"]')?.className).toContain('active:scale-')
  })

  it('Selected — a selected chip is aria-pressed and carries accent styling', () => {
    act(() => {
      root.render(<Chip variant="compound" label="foo" onClick={() => {}} selected />)
    })
    const el = container.querySelector('[data-testid="chip"]')
    expect(el?.getAttribute('aria-pressed')).toBe('true')
    expect(el?.className).toContain('border-[var(--accent)]')
  })

  it('Disabled — carries its reason as a title and blocks the click handler', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(
        <Chip
          variant="removable"
          label="foo"
          onClick={onClick}
          onRemove={() => {}}
          disabled
          disabledReason="Locked by policy"
        />
      )
    })
    const el = container.querySelector('[data-testid="chip"]')
    expect(el?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Locked by policy')
    act(() => (el as HTMLButtonElement)?.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('Loading — count variant shows a spinner instead of a number', () => {
    act(() => {
      root.render(<Chip variant="count" label="sessions" loading />)
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
  })

  it('Error — N/A: a chip has no async operation of its own to fail; the container that supplies its value owns retry (Disclosure).', () => {
    expect(true).toBe(true)
  })

  it('Overflow — a long label truncates with an ellipsis and keeps the full text in a Tooltip', () => {
    const long = 'a'.repeat(40)
    act(() => {
      root.render(<Chip variant="state" label={long} />)
    })
    const label = container.querySelector('[data-testid="chip"] span')
    expect(label?.className).toContain('text-ellipsis')
    const chip = container.querySelector('[data-testid="chip"]')
    expect(chip?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(long)
  })

  it('Empty set — count variant with a known-zero tally renders the empty-set label, not "0"', () => {
    act(() => {
      root.render(<Chip variant="count" label="sessions" count={0} emptySetLabel="No sessions" />)
    })
    expect(container.querySelector('[data-testid="chip-empty-set"]')?.textContent).toBe(
      'No sessions'
    )
    expect(container.querySelector('[data-testid="chip"]')?.textContent).not.toContain('0')
  })
})
