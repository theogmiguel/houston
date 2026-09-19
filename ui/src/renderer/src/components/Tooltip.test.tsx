// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOVER_DELAY_MS, Tooltip } from './Tooltip'

function bubble(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]')
}

describe('Tooltip (06-shell row 10)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = (label?: string | null): HTMLElement => {
    act(() => {
      root.render(
        <Tooltip label={label === undefined ? 'Close pane' : label}>
          <button>x</button>
        </Tooltip>
      )
    })
    return container.querySelector('button')!
  }

  const enter = (el: HTMLElement): void => {
    act(() => {
      el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
      el.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true }))
    })
  }

  it('says nothing until the pointer has rested — a sweep across the chrome shows no tooltip', () => {
    const btn = render()
    enter(btn)
    expect(bubble()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS - 1)
    })
    expect(bubble()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(bubble()?.textContent).toBe('Close pane')
  })

  it('leaving before the delay elapses cancels it outright', () => {
    const btn = render()
    enter(btn)
    act(() => {
      btn.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
      btn.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    })
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS * 4)
    })
    expect(bubble()).toBeNull()
  })

  it('a keyboard user waits for nothing', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()?.textContent).toBe('Close pane')
  })

  it('typing dismisses it, so a hint never sits over the field being typed in', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()).not.toBeNull()
    act(() => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    expect(bubble()).toBeNull()
  })

  it('escape dismisses it, and so does a click on the control', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(bubble()).toBeNull()

    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()).not.toBeNull()
    act(() => {
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(bubble()).toBeNull()
  })

  it('a scroll anywhere takes it away rather than letting it point at nothing', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()).not.toBeNull()
    act(() => {
      container.dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    expect(bubble()).toBeNull()
  })

  it('is inert to the pointer and announced to assistive tech', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    const tip = bubble()!
    expect(tip.className).toContain('pointer-events-none')
    expect(tip.getAttribute('role')).toBe('tooltip')
    const wrap = container.firstElementChild!
    expect(wrap.getAttribute('aria-describedby')).toBe(tip.id)
    expect(tip.id).not.toBe('')
  })

  it('an absent label suppresses the bubble, but keeps the wrapper -- a toggling label must not remount its child', () => {
    const btn = render(null)
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    expect(bubble()).toBeNull()
    expect(container.firstElementChild?.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBe(btn)
  })

  it('toggling label between empty and a string does not remount the child', () => {
    let setChecked: ((v: boolean) => void) | null = null
    function Wrapped({ label }: { label?: string }): React.JSX.Element {
      const [checked, setC] = useState(false)
      setChecked = setC
      return (
        <Tooltip label={label}>
          <input type="checkbox" checked={checked} onChange={() => {}} disabled={!!label} />
        </Tooltip>
      )
    }
    act(() => {
      root.render(<Wrapped label={undefined} />)
    })
    const input = container.querySelector('input')!
    act(() => setChecked!(true))
    expect(container.querySelector('input')).toBe(input)
    expect(input.checked).toBe(true)

    act(() => {
      root.render(<Wrapped label="disabled reason" />)
    })
    expect(container.querySelector('input')).toBe(input)
    expect(input.checked).toBe(true)
    expect(input.disabled).toBe(true)
  })

  it('renders outside the trigger subtree, where no overflow can clip it', () => {
    const btn = render()
    act(() => {
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    const tip = bubble()!
    expect(container.contains(tip)).toBe(false)
    expect(tip.parentElement).toBe(document.body)
  })
})
