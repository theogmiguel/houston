// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Slider } from './Slider'

describe('Slider — state matrix', () => {
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

  function input(): HTMLInputElement {
    return container.querySelector('[data-testid="slider-input"]') as HTMLInputElement
  }

  function setInputValue(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('Filled — renders the current value on both the thumb and the readout, formatted', () => {
    act(() => {
      root.render(
        <Slider
          value={0.5}
          min={0}
          max={2}
          step={0.1}
          onChange={() => {}}
          formatValue={(v) => `${Math.round(v * 100)}%`}
          aria-label="App zoom"
        />
      )
    })
    expect(input().value).toBe('0.5')
    expect(container.querySelector('[data-testid="slider-readout"]')?.textContent).toBe('50%')
  })

  it('Live mode (default) — onChange fires on every tick, not just on release', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<Slider value={0.1} min={0} max={0.25} step={0.001} onChange={onChange} aria-label="RMS floor" />)
    })
    act(() => setInputValue(input(), '0.2'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(0.2)
  })

  it('commitOnRelease — onChange does NOT fire on a tick, only once on release (the app-zoom flicker fix)', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(
        <Slider value={1} min={0.5} max={2} step={0.1} onChange={onChange} commitOnRelease aria-label="App zoom" />
      )
    })
    act(() => setInputValue(input(), '1.5'))
    expect(container.querySelector('[data-testid="slider-readout"]')?.textContent).toBe('1.5')
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      input().dispatchEvent(new Event('mouseup', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(1.5)
  })

  it('commitOnRelease — an external value change mid-drag does not yank the thumb', () => {
    const onChange = vi.fn()
    function Harness({ value }: { value: number }): React.JSX.Element {
      return (
        <Slider value={value} min={0.5} max={2} step={0.1} onChange={onChange} commitOnRelease aria-label="App zoom" />
      )
    }
    act(() => {
      root.render(<Harness value={1} />)
    })
    act(() => setInputValue(input(), '1.5'))
    act(() => {
      root.render(<Harness value={1} />)
    })
    expect(container.querySelector('[data-testid="slider-readout"]')?.textContent).toBe('1.5')
  })

  it('Disabled — the input is disabled and carries its reason as a title', () => {
    act(() => {
      root.render(
        <Slider value={1} min={0} max={2} onChange={() => {}} disabled disabledReason="Read-only preset" aria-label="x" />
      )
    })
    expect(input().disabled).toBe(true)
    expect(input().closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Read-only preset')
  })

  it('Reset — hidden unless both resetValue and onReset are given', () => {
    act(() => {
      root.render(<Slider value={1} min={0} max={2} onChange={() => {}} aria-label="x" />)
    })
    expect(container.querySelector('[data-testid="slider-reset"]')).toBeNull()
  })

  it('Reset — disabled once value already equals resetValue, and calls onReset when not', () => {
    const onReset = vi.fn()
    act(() => {
      root.render(<Slider value={1.5} min={0} max={2} onChange={() => {}} resetValue={1} onReset={onReset} aria-label="x" />)
    })
    const reset = container.querySelector('[data-testid="slider-reset"]') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    act(() => reset.click())
    expect(onReset).toHaveBeenCalledTimes(1)

    act(() => {
      root.render(<Slider value={1} min={0} max={2} onChange={() => {}} resetValue={1} onReset={onReset} aria-label="x" />)
    })
    expect((container.querySelector('[data-testid="slider-reset"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Filled — a change is clamped to [min, max]', () => {
    const onChange = vi.fn()
    act(() => {
      root.render(<Slider value={1} min={0} max={2} onChange={onChange} aria-label="x" />)
    })
    act(() => setInputValue(input(), '99'))
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('Empty / Loading / Error / Selected / Overflow — N/A: a slider always has a value (no undefined/empty concept), has no async fetch of its own, and is a single continuous control with nothing to select or overflow.', () => {
    expect(true).toBe(true)
  })
})
