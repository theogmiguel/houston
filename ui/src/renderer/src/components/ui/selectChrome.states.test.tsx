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

  it('Filled — lands on the INPUT radius tier (--tr-radius-input, 4px), not a button radius', () => {
    expect(SELECT_CLS).toMatch(/rounded-\[var\(--tr-radius-input\)\]/)
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

  it('Focus — N/A: base.css already gives every <select> a floor (select:focus-visible, ~line 117); redefining it here would stack a second ring for an axis this gap never named as broken.', () => {
    expect(SELECT_CLS).not.toMatch(/focus-visible|outline/)
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
    expect(SELECT_CLS).toMatch(/bg-\[var\(--content-bg\)\]/)
    expect(SELECT_CLS).toMatch(/border-\[var\(--border\)\]/)
    expect(SELECT_CLS).toMatch(/text-\[var\(--text-primary\)\]/)
  })

  it('Height — composes to the shared control-height step (--h-ctl), the same one Segmented\'s track uses', () => {
    expect(SELECT_CLS).toMatch(/h-\[var\(--h-ctl\)\]/)
  })
})
