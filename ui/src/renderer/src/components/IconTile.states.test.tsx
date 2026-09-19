// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IconTile } from './IconTile'

describe('IconTile — state matrix', () => {
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

  it('Empty — no icon assigned yet renders a dashed placeholder', () => {
    act(() => {
      root.render(<IconTile label="row" />)
    })
    expect(container.querySelector('[data-testid="icon-tile-placeholder"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="icon-tile"]')?.className).toContain('border-dashed')
  })

  it('Filled — an icon renders it, not the placeholder', () => {
    act(() => {
      root.render(<IconTile label="row" icon={<svg data-testid="glyph" />} />)
    })
    expect(container.querySelector('[data-testid="glyph"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="icon-tile-placeholder"]')).toBeNull()
  })

  it('Hover — an interactive tile carries hover treatment', () => {
    act(() => {
      root.render(<IconTile label="row" interactive icon={<svg />} />)
    })
    expect(container.querySelector('[data-testid="icon-tile"]')?.className).toContain('hover:bg-')
  })

  it('Focus — an interactive tile carries a visible focus ring', () => {
    act(() => {
      root.render(<IconTile label="row" interactive icon={<svg />} />)
    })
    expect(container.querySelector('[data-testid="icon-tile"]')?.className).toContain(
      'focus-visible:shadow-'
    )
  })

  it('Active — an interactive tile carries a press-scale treatment', () => {
    act(() => {
      root.render(<IconTile label="row" interactive icon={<svg />} />)
    })
    expect(container.querySelector('[data-testid="icon-tile"]')?.className).toContain(
      'active:scale-'
    )
  })

  it('Selected — a selected tile is aria-pressed and carries accent styling', () => {
    act(() => {
      root.render(<IconTile label="row" interactive icon={<svg />} selected />)
    })
    const el = container.querySelector('[data-testid="icon-tile"]')
    expect(el?.getAttribute('aria-pressed')).toBe('true')
    expect(el?.className).toContain('border-[var(--accent)]')
  })

  it('Disabled — carries its reason as a title and blocks the click handler', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(
        <IconTile
          label="row"
          interactive
          icon={<svg />}
          onClick={onClick}
          disabled
          disabledReason="Not available offline"
        />
      )
    })
    const el = container.querySelector('[data-testid="icon-tile"]')
    expect(el?.getAttribute('title')).toBe('Not available offline')
    act(() => (el as HTMLButtonElement)?.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  it('Loading — shows a spinner in place of the icon', () => {
    act(() => {
      root.render(<IconTile label="row" icon={<svg />} loading />)
    })
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="icon-tile-icon"]')).toBeNull()
  })

  it('Error — N/A: the tile renders a caller-supplied static glyph; it has no async operation to fail or retry — that belongs to the row/card that owns it.', () => {
    expect(true).toBe(true)
  })

  it('Overflow — N/A: the box is a fixed-size container for exactly one icon; nothing inside it can exceed the box.', () => {
    expect(true).toBe(true)
  })

  it('Empty set — N/A: a tile fronts one item, not a collection; there is no zero-items rendering distinct from Empty.', () => {
    expect(true).toBe(true)
  })
})
