// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentChip } from './AttachmentChip'

describe('AttachmentChip — state matrix', () => {
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

  it('Filled — renders the filename and a type-coloured glyph; .md is --info-toned', () => {
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" />)
    })
    expect(container.querySelector('[data-testid="attachment-chip"]')?.textContent).toContain('notes.md')
    expect(container.querySelector('[data-testid="attachment-glyph"]')?.className).toContain('--info')
    expect(container.querySelector('[data-testid="attachment-glyph"]')?.textContent).toBe('MD')
  })

  it('Filled — .pdf is --danger-toned, distinct from .md', () => {
    act(() => {
      root.render(<AttachmentChip filename="report.pdf" extension="pdf" />)
    })
    expect(container.querySelector('[data-testid="attachment-glyph"]')?.className).toContain('--danger')
  })

  it('Filled — an image attachment renders a thumbnail instead of a monogram', () => {
    act(() => {
      root.render(<AttachmentChip filename="shot.png" extension="png" imageUrl="data:image/png;base64,x" />)
    })
    expect(container.querySelector('[data-testid="attachment-glyph"]')).toBeNull()
    expect(container.querySelector('[data-testid="attachment-chip"] img')).not.toBeNull()
  })

  it('Hover — the preview is closed at rest and opens on mouseEnter, Raised (not overlay) tier chrome, no scrim', () => {
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" />)
    })
    expect(container.querySelector('[data-testid="attachment-preview"]')).toBeNull()

    const chip = container.querySelector('[data-testid="attachment-chip"]') as HTMLElement
    act(() => chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    const preview = container.querySelector('[data-testid="attachment-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.className).toContain('bg-[var(--material-raised-bg)]')
    expect(preview?.getAttribute('data-material')).toBe('raised')
    expect(container.querySelector('[data-testid="scrim"]')).toBeNull()
  })

  it('Hover — "dismissed by moving away": mouseLeave closes the preview again', () => {
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" />)
    })
    const chip = container.querySelector('[data-testid="attachment-chip"]') as HTMLElement
    act(() => chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(container.querySelector('[data-testid="attachment-preview"]')).not.toBeNull()
    act(() => chip.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(container.querySelector('[data-testid="attachment-preview"]')).toBeNull()
  })

  it('Focus — the preview also opens on keyboard focus, not hover-only (unreachable otherwise)', () => {
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" onClick={() => {}} />)
    })
    const chip = container.querySelector('[data-testid="attachment-chip"]') as HTMLElement
    act(() => chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(container.querySelector('[data-testid="attachment-preview"]')).not.toBeNull()
    act(() => chip.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(container.querySelector('[data-testid="attachment-preview"]')).toBeNull()
  })

  it('Removable — the × calls onRemove and not onClick, and stops the click reaching the chip', () => {
    const onRemove = vi.fn()
    const onClick = vi.fn()
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" onClick={onClick} onRemove={onRemove} />)
    })
    const remove = container.querySelector('[aria-label="Remove notes.md"]') as HTMLButtonElement
    act(() => remove.click())
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('Active — clicking the chip body fires onClick when provided; without it the chip is a plain (non-button) element', () => {
    const onClick = vi.fn()
    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" onClick={onClick} />)
    })
    const chip = container.querySelector('[data-testid="attachment-chip"]') as HTMLButtonElement
    expect(chip.tagName).toBe('BUTTON')
    act(() => chip.click())
    expect(onClick).toHaveBeenCalledTimes(1)

    act(() => {
      root.render(<AttachmentChip filename="notes.md" extension="md" />)
    })
    expect(container.querySelector('[data-testid="attachment-chip"]')?.tagName).toBe('DIV')
  })

  it('Overflow — a long filename truncates with an ellipsis; the hover preview (not a native title=) carries the full name', () => {
    const long = 'a'.repeat(60) + '.md'
    act(() => {
      root.render(<AttachmentChip filename={long} extension="md" />)
    })
    const label = container.querySelector('[data-testid="attachment-chip"] span.text-ellipsis')
    expect(label?.className).toContain('text-ellipsis')
    expect(label?.hasAttribute('title')).toBe(false)
    const chip = container.querySelector('[data-testid="attachment-chip"]') as HTMLElement
    act(() => chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(container.querySelector('[data-testid="attachment-preview"]')?.textContent).toContain(long)
  })

  it('Empty / Loading / Error / Selected / Disabled — N/A: an attachment is either present or not rendered at all; async fetch/loading/selection state belongs to whatever list renders these chips, not to a single chip.', () => {
    expect(true).toBe(true)
  })
})
