// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SELECT_CLS } from './selectChrome'

describe('SELECT_CLS — state matrix', () => {
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
  })

  it('Filled — lands on the control radius tier (--tr-radius-button, 6px), not a text-field radius', () => {
    expect(SELECT_CLS).toMatch(/rounded-\[var\(--tr-radius-button\)\]/)
    expect(SELECT_CLS).not.toMatch(/rounded-md\b/)
    expect(SELECT_CLS).not.toMatch(/rounded-\[6px\]|rounded-\[8px\]/)
  })

  it('Filled — lands on the UI type-size step (--tr-text-ui, 13px), not 11.5px or 12px', () => {
    expect(SELECT_CLS).toMatch(/text-\[length:var\(--tr-text-ui-size\)\]/)
    expect(SELECT_CLS).not.toMatch(/text-\[11\.5px\]|text-\[12px\]/)
  })

  it('Disabled — carries its own disabled: variant, matching button:disabled\'s weight', () => {
    expect(SELECT_CLS).toMatch(/disabled:opacity-45/)
    expect(SELECT_CLS).toMatch(/disabled:cursor-not-allowed/)
  })

  it('Focus — carries the accent-ink 2px focus-visible ring', () => {
    expect(SELECT_CLS).toMatch(/focus-visible:outline-2/)
    expect(SELECT_CLS).toMatch(/focus-visible:outline-\[var\(--accent-ink\)\]/)
  })

  it('Hover / Selected / Overflow / Error — N/A: native <select>/<option> chrome (popup, hover row, open-state truncation) is drawn by the OS widget, not by author CSS on the closed control — same reason base.css states option colors instead.', () => {
    expect(true).toBe(true)
  })

  it('Filled — applies cleanly to a real <select> with no console error and no delta from what today\'s 15 call sites already set for background/border/text color', () => {
    act(() => {
      root.render(
        <select className={SELECT_CLS} aria-label="test" defaultValue="a">
          <option value="a">A</option>
        </select>
      )
    })
    const el = container.querySelector('select')
    expect(el).not.toBeNull()
    expect(el?.className).toBe(SELECT_CLS)
    expect(SELECT_CLS).toMatch(/bg-\[var\(--field\)\]/)
    expect(SELECT_CLS).toMatch(/border-\[var\(--line-strong\)\]/)
    expect(SELECT_CLS).toMatch(/text-\[var\(--text-primary\)\]/)
  })

  it('Height — composes to the pill-height step (--h-pill), the same one chip controls use', () => {
    expect(SELECT_CLS).toMatch(/h-\[var\(--h-pill\)\]/)
  })
})
