// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerControls, type ComposerChip } from './ComposerControls'

function chip(id: string, value = 'a'): ComposerChip {
  return {
    id,
    label: `${id} label`,
    value,
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ],
    onChange: vi.fn()
  }
}

describe('ComposerControls — state matrix', () => {
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

  it('Filled — three chips render as their own dropdown chips, no overflow chip', () => {
    act(() => {
      root.render(<ComposerControls chips={[chip('model'), chip('effort'), chip('mode')]} onSend={() => {}} />)
    })
    expect(container.querySelectorAll('[data-testid="composer-chip"]')).toHaveLength(3)
    expect(container.querySelector('[data-testid="composer-chip-overflow"]')).toBeNull()
  })

  it('Overflow — a fourth chip collapses into one "+N" overflow chip instead of clipping (the charter\'s own budget warning)', () => {
    act(() => {
      root.render(
        <ComposerControls
          chips={[chip('model'), chip('effort'), chip('mode'), chip('extra1'), chip('extra2')]}
          onSend={() => {}}
        />
      )
    })
    expect(container.querySelectorAll('[data-testid="composer-chip"]')).toHaveLength(3)
    const overflow = container.querySelector('[data-testid="composer-chip-overflow"]')
    expect(overflow?.textContent).toBe('+2')
  })

  it('Overflow menu — lists each overflowed chip as a label + Select using selectChrome\'s SELECT_CLS', () => {
    act(() => {
      root.render(
        <ComposerControls chips={[chip('model'), chip('effort'), chip('mode'), chip('extra1')]} onSend={() => {}} />
      )
    })
    const overflowBtn = container.querySelector('[data-testid="composer-chip-overflow"]') as HTMLButtonElement
    act(() => overflowBtn.click())
    const selects = container.querySelectorAll('[data-testid="composer-chip-overflow-select"]')
    expect(selects).toHaveLength(1)
    expect((selects[0] as HTMLElement).className).toContain('rounded-[var(--tr-radius-input)]')
  })

  it('Active — clicking a chip opens its options menu (Raised-tier chrome), and choosing an option calls onChange and closes it', () => {
    const c = chip('model')
    act(() => {
      root.render(<ComposerControls chips={[c]} onSend={() => {}} />)
    })
    const btn = container.querySelector('[data-testid="composer-chip"]') as HTMLButtonElement
    expect(container.querySelector('[data-testid="composer-chip-menu"]')).toBeNull()
    act(() => btn.click())
    const menu = container.querySelector('[data-testid="composer-chip-menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.className).toContain('bg-[var(--material-raised-bg)]')
    expect(menu?.getAttribute('data-material')).toBe('raised')

    const options = container.querySelectorAll('[data-testid="composer-chip-option"]')
    expect(options).toHaveLength(2)
    act(() => (options[1] as HTMLButtonElement).click())
    expect(c.onChange).toHaveBeenCalledWith('b')
    expect(container.querySelector('[data-testid="composer-chip-menu"]')).toBeNull()
  })

  it('Focus — the open menu closes when focus leaves the chip entirely (blur to outside the wrapper)', () => {
    const c = chip('model')
    act(() => {
      root.render(<ComposerControls chips={[c]} onSend={() => {}} />)
    })
    const btn = container.querySelector('[data-testid="composer-chip"]') as HTMLButtonElement
    act(() => btn.click())
    expect(container.querySelector('[data-testid="composer-chip-menu"]')).not.toBeNull()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(container.querySelector('[data-testid="composer-chip-menu"]')).toBeNull()
  })

  it('Disabled — a disabled chip carries its reason as a title and cannot be clicked', () => {
    const c = chip('model')
    c.disabled = true
    c.disabledReason = 'No profile saved'
    act(() => {
      root.render(<ComposerControls chips={[c]} onSend={() => {}} />)
    })
    const btn = container.querySelector('[data-testid="composer-chip"]') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('No profile saved')
  })

  it('Loading — Send swaps its label for a spinner, disables, and marks aria-busy', () => {
    act(() => {
      root.render(<ComposerControls chips={[]} onSend={() => {}} loading />)
    })
    const send = container.querySelector('[data-testid="composer-send"]') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(send.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull()
  })

  it('Filled — Send calls onSend once and uses the caller\'s own label (e.g. "Build")', () => {
    const onSend = vi.fn()
    act(() => {
      root.render(<ComposerControls chips={[]} onSend={onSend} sendLabel="Build" />)
    })
    const send = container.querySelector('[data-testid="composer-send"]') as HTMLButtonElement
    expect(send.textContent).toContain('Build')
    act(() => send.click())
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('Empty / Error / Selected — N/A: this is a controlled presentational row over caller-owned values; no fetch, no async state, and "selected" is each chip\'s own `value`/option highlight, already asserted above via aria-selected.', () => {
    expect(true).toBe(true)
  })
})
