// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Segmented } from './Segmented'

const OPTIONS = [
  { value: 'grid', label: 'Grid' },
  { value: 'list', label: 'List' }
]

describe('Segmented — state matrix', () => {
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

  it('Empty — no value chosen yet, no option marked selected', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} />)
    })
    expect(container.querySelector('[data-testid="segmented"]')?.getAttribute('data-state')).toBe(
      'empty'
    )
    expect(container.querySelectorAll('[aria-checked="true"]').length).toBe(0)
  })

  it('Filled — a value maps to its option', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" />)
    })
    expect(container.querySelector('[data-testid="segmented"]')?.getAttribute('data-state')).toBe(
      'filled'
    )
  })

  it('Hover — an unselected option lifts its INK, and paints no hover fill (the reference has none)', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" />)
    })
    const listBtn = Array.from(container.querySelectorAll('button[role="radio"]')).find(
      (b) => b.textContent === 'List'
    )
    expect(listBtn?.className).toContain('hover:text-[var(--text-primary)]')
    expect(listBtn?.className).not.toContain('hover:bg-')
  })

  it('Focus — option buttons carry a visible focus ring', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" />)
    })
    const btn = container.querySelector('button[role="radio"]')
    expect(btn?.className).toContain('focus-visible:shadow-')
  })

  it('Selected — the chosen option is aria-checked and paints the reference’s NEUTRAL wash, never the accent tint', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    const buttons = Array.from(container.querySelectorAll('button[role="radio"]'))
    const listBtn = buttons.find((b) => b.textContent === 'List')
    expect(listBtn?.getAttribute('aria-checked')).toBe('true')
    expect(listBtn?.className).toContain(
      'bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)]'
    )
    expect(listBtn?.className).toContain('text-[var(--text-primary)]')
    expect(listBtn?.className).toContain('[font-weight:var(--tr-text-small-weight)]')
    expect(listBtn?.className).not.toContain('bg-[var(--accent-muted)]')
    expect(listBtn?.className).not.toContain('bg-[var(--accent)]')
  })

  it('Selected — the fill CROSS-FADES in place: no thumb element, and the transition is on color/background, never transform', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    expect(container.querySelector('[data-testid="segmented-thumb"]')).toBeNull()
    for (const b of container.querySelectorAll('button[role="radio"]')) {
      expect(b.className).toContain('motion-safe:transition-[color,background-color]')
      expect(b.className).toContain('motion-safe:duration-[180ms]')
      expect(b.className).not.toContain('transition-[transform')
    }
  })

  it('Unselected — the neutral branch owns its own bg-transparent (no same-layer emission tie)', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    const gridBtn = Array.from(container.querySelectorAll('button[role="radio"]')).find(
      (b) => b.textContent === 'Grid'
    )
    expect(gridBtn?.className).toContain('bg-transparent')
    expect(gridBtn?.className).toContain('text-[var(--text-secondary)]')
    expect(gridBtn?.className).toContain('[font-weight:var(--tr-text-small-weight)]')
  })

  it('Track — the reference’s contour and 4% fill at radius 8, not a pill (carve 0.1.9, re-decided 2026-08-26)', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    const group = container.querySelector('[data-testid="segmented"]')
    expect(group?.className).toContain('border-[var(--border)]')
    expect(group?.className).toContain('bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]')
    expect(group?.className).toContain('rounded-[var(--tr-radius-button)]')
    expect(group?.className).not.toContain('rounded-[var(--tr-radius-pill)]')
  })

  it('Item box — 54×22 minimum at radius 6, the reference’s own numbers', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    const btn = container.querySelector('button[role="radio"]')
    expect(btn?.className).toContain('min-w-[54px]')
    expect(btn?.className).toContain('h-[var(--h-ctl-mini)]')
    expect(btn?.className).toContain('px-[10px]')
    expect(btn?.className).toContain('rounded-[var(--tr-radius-sm)]')
    expect(btn?.className).toContain('[font-size:var(--tr-text-small-size)]')
  })

  it('Disabled — a disabled option carries its reason and blocks selection', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <Segmented
          aria-label="View"
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'list', label: 'List', disabled: true, disabledReason: 'Not in this mode' }
          ]}
          value="grid"
          onChange={onChange}
        />
      )
    })
    const buttons = Array.from(container.querySelectorAll('button[role="radio"]'))
    const listBtn = buttons.find((b) => b.textContent === 'List') as HTMLButtonElement
    expect(listBtn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Not in this mode')
    expect(listBtn.disabled).toBe(true)
    act(() => listBtn.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('Loading — the control is aria-busy and options are non-interactive', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" loading />)
    })
    expect(
      container.querySelector('[data-testid="segmented"]')?.getAttribute('aria-busy')
    ).toBe('true')
    const btn = container.querySelector('button[role="radio"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('Error — renders the failing message with a retry action', () => {
    const onRetry = vi.fn()
    act(() => {
      root.render(
        <Segmented aria-label="View" options={OPTIONS} error={{ message: 'Could not load views', onRetry }} />
      )
    })
    expect(container.querySelector('[data-testid="segmented"]')?.getAttribute('data-state')).toBe(
      'error'
    )
    expect(container.textContent).toContain('Could not load views')
    const retry = container.querySelector('button') as HTMLButtonElement
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('Overflow — the track scrolls horizontally instead of growing', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" />)
    })
    expect(container.querySelector('[data-testid="segmented"]')?.className).toContain(
      'overflow-x-auto'
    )
  })

  it('Radiogroup — the track is role=radiogroup, options are role=radio, and no option carries aria-pressed', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" />)
    })
    const group = container.querySelector('[data-testid="segmented"]')
    expect(group?.getAttribute('role')).toBe('radiogroup')
    const radios = Array.from(container.querySelectorAll('[role="radio"]'))
    expect(radios.length).toBe(OPTIONS.length)
    for (const r of radios) {
      expect(r.hasAttribute('aria-pressed')).toBe(false)
    }
  })

  it('Roving tabindex — only the selected option is a tab stop; the rest are -1', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" />)
    })
    const buttons = Array.from(container.querySelectorAll('button[role="radio"]')) as HTMLButtonElement[]
    const gridBtn = buttons.find((b) => b.textContent === 'Grid')!
    const listBtn = buttons.find((b) => b.textContent === 'List')!
    expect(listBtn.tabIndex).toBe(0)
    expect(gridBtn.tabIndex).toBe(-1)
  })

  it('Roving tabindex — nothing selected yet defaults the tab stop to the first enabled option', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} />)
    })
    const buttons = Array.from(container.querySelectorAll('button[role="radio"]')) as HTMLButtonElement[]
    expect(buttons[0].tabIndex).toBe(0)
    expect(buttons[1].tabIndex).toBe(-1)
  })

  it('ArrowRight/ArrowDown move forward, select, and wrap past the last option', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" onChange={onChange} />)
    })
    const group = container.querySelector('[data-testid="segmented"]') as HTMLDivElement
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('list')

    onChange.mockClear()
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" onChange={onChange} />)
    })
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('grid')
  })

  it('ArrowLeft/ArrowUp move backward, select, and wrap past the first option', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="grid" onChange={onChange} />)
    })
    const group = container.querySelector('[data-testid="segmented"]') as HTMLDivElement
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('list')

    onChange.mockClear()
    act(() => {
      root.render(<Segmented aria-label="View" options={OPTIONS} value="list" onChange={onChange} />)
    })
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('grid')
  })

  it('Home/End jump to the first and last option', () => {
    const THREE = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' }
    ]
    const onChange = vi.fn()
    act(() => {
      root.render(<Segmented aria-label="View" options={THREE} value="b" onChange={onChange} />)
    })
    const group = container.querySelector('[data-testid="segmented"]') as HTMLDivElement
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('c')

    onChange.mockClear()
    act(() => {
      root.render(<Segmented aria-label="View" options={THREE} value="b" onChange={onChange} />)
    })
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('a')
  })

  it('Arrows step from the FOCUSED option, so they keep advancing when a caller ignores onChange', () => {
    const three = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' }
    ]
    const onChange = vi.fn()
    act(() => {
      root.render(<Segmented aria-label="View" options={three} value="a" onChange={onChange} />)
    })
    const group = container.querySelector('[data-testid="segmented"]') as HTMLDivElement
    const press = (): void => {
      act(() => {
        group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      })
    }
    press()
    expect(onChange).toHaveBeenLastCalledWith('b')
    press()
    expect(onChange).toHaveBeenLastCalledWith('c')
    press()
    expect(onChange).toHaveBeenLastCalledWith('a')
  })

  it('Arrow keys skip disabled options', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <Segmented
          aria-label="View"
          options={[
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B', disabled: true },
            { value: 'c', label: 'C' }
          ]}
          value="a"
          onChange={onChange}
        />
      )
    })
    const group = container.querySelector('[data-testid="segmented"]') as HTMLDivElement
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith('c')
  })

  it('Empty set — zero options renders a distinct "no options" state, not an empty track', () => {
    act(() => {
      root.render(<Segmented aria-label="View" options={[]} />)
    })
    const el = container.querySelector('[data-testid="segmented"]')
    expect(el?.getAttribute('data-state')).toBe('empty-set')
    expect(el?.textContent).toBe('No options')
  })
})
