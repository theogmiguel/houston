// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearancePicker } from './AppearancePicker'
import { THEMES, type ThemeName } from '../theme'

describe('AppearancePicker — state matrix', () => {
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

  const original: ThemeName = THEMES[0]
  const other: ThemeName = THEMES[1]

  function rows(): NodeListOf<Element> {
    return container.querySelectorAll('[data-testid="appearance-picker-row"]')
  }

  function picker(): HTMLElement {
    return container.querySelector('[data-testid="appearance-picker"]') as HTMLElement
  }

  function pressArrowDown(): void {
    act(() => {
      picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('Empty — N/A: the catalog is the static THEMES array, never unfetched; the picker always opens with a highlighted value (the current theme), so there is no "nothing highlighted yet" state to render.', () => {
    expect(true).toBe(true)
  })

  it('Filled — opens with every theme listed and the current one highlighted', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    expect(rows().length).toBe(THEMES.length)
    const selected = container.querySelector('[data-testid="appearance-picker-row"][aria-selected="true"]')
    expect(selected).not.toBeNull()
  })

  it('Hover — a row carries hover treatment in its class list', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    expect(rows()[0]?.className).toContain('hover:bg-')
  })

  it('Focus — the search input carries a visible focus ring', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    const search = container.querySelector('[data-testid="appearance-picker-search"]')
    expect(search?.className).toContain('focus-visible:shadow-')
  })

  it('Active — a row carries a press-scale treatment', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    expect(rows()[0]?.className).toContain('active:scale-')
  })

  it('Selected — the highlighted row is aria-selected and carries accent styling', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    const el = container.querySelector('[data-testid="appearance-picker-row"][aria-selected="true"]')
    expect(el).not.toBeNull()
    expect(el?.className).toContain('bg-[var(--accent-muted)]')
  })

  it('Disabled — N/A: every catalog entry is always selectable; nothing in the 24-palette list has a disablement condition to represent.', () => {
    expect(true).toBe(true)
  })

  it('Loading — N/A: the catalog is bundled statically (THEMES), never fetched over the wire, so there is no async load state.', () => {
    expect(true).toBe(true)
  })

  it('Error — N/A: same reasoning as Loading — nothing here can fail to load.', () => {
    expect(true).toBe(true)
  })

  it('Overflow — all 24 rows render inside a capped-height scroll track, no items dropped; measures the render (the 24-row virtualization decision)', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    act(() => root.unmount())
    root = createRoot(container)

    const start = performance.now()
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    const elapsedMs = performance.now() - start
    const list = container.querySelector('[data-testid="appearance-picker-list"]') as HTMLElement | null
    expect(list?.style.maxHeight).toBe('320px')
    expect(rows().length).toBe(THEMES.length)
    // eslint-disable-next-line no-console -- this log IS the measurement: the number that decided against virtualizing the list
    console.log(`AppearancePicker: warm render of all ${THEMES.length} rows took ${elapsedMs.toFixed(2)}ms`)
  })

  it('Empty set — a query matching no palette renders a named empty state, not a blank list', () => {
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={() => {}} onCommit={() => {}} />)
    })
    const search = container.querySelector('[data-testid="appearance-picker-search"]') as HTMLInputElement
    typeInto(search, 'zzz-no-such-palette')
    expect(container.querySelector('[data-testid="appearance-picker-empty-set"]')).not.toBeNull()
    expect(rows().length).toBe(0)
  })

  it('ACCEPTANCE — Escape after highlighting three different palettes restores the ORIGINAL, not the last-highlighted one', () => {
    const onPreview = vi.fn()
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={onPreview} onCommit={() => {}} />)
    })

    pressArrowDown()
    pressArrowDown()
    pressArrowDown()
    expect(onPreview.mock.calls.length).toBe(3)
    expect(onPreview.mock.calls.at(-1)?.[0]).toBe(THEMES[3])
    expect(onPreview.mock.calls.at(-1)?.[0]).not.toBe(original)

    act(() => {
      picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(onPreview).toHaveBeenLastCalledWith(original)
  })

  it('Unmount without commit restores the original theme', () => {
    const onPreview = vi.fn()
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={onPreview} onCommit={() => {}} />)
    })
    pressArrowDown()
    expect(onPreview).toHaveBeenLastCalledWith(other)
    act(() => {
      root.unmount()
    })
    expect(onPreview).toHaveBeenLastCalledWith(original)
  })

  it('Commit does not trigger the unmount-restore (only a real un-committed close does)', () => {
    const onPreview = vi.fn()
    const onCommit = vi.fn()
    act(() => {
      root.render(<AppearancePicker currentTheme={original} onPreview={onPreview} onCommit={onCommit} />)
    })
    pressArrowDown()
    act(() => {
      picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(onCommit).toHaveBeenCalledWith(other)
    const callsBeforeUnmount = onPreview.mock.calls.length
    act(() => {
      root.unmount()
    })
    expect(onPreview.mock.calls.length).toBe(callsBeforeUnmount)
  })
})
