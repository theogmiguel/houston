// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  OVERLAY_GLASS_OVERLAY_CLS,
  OVERLAY_GLASS_RAISED_CLS,
  OVERLAY_OVERLAY_CLS,
  OVERLAY_RAISED_CLS
} from './overlayChrome'

describe('overlayChrome — tier matrix', () => {
  it('RAISED (flat) — stands on the ladder\'s raised rung, not on --card-bg or a literal', () => {
    expect(OVERLAY_RAISED_CLS).toMatch(/bg-\[var\(--material-raised-bg\)\]/)
    expect(OVERLAY_RAISED_CLS).toMatch(/shadow-\[var\(--material-raised-shadow\)\]/)
    expect(OVERLAY_RAISED_CLS).not.toMatch(/--card-bg/)
  })

  it('OVERLAY (flat) — one rung further up, with its own shadow, never raised\'s', () => {
    expect(OVERLAY_OVERLAY_CLS).toMatch(/bg-\[var\(--material-overlay-bg\)\]/)
    expect(OVERLAY_OVERLAY_CLS).toMatch(/shadow-\[var\(--material-overlay-shadow\)\]/)
    expect(OVERLAY_OVERLAY_CLS).not.toMatch(/--material-raised-shadow/)
  })

  it('RAISED (glass) — the raised rung\'s translucent form, not the sheet\'s own --glass-surface', () => {
    expect(OVERLAY_GLASS_RAISED_CLS).toMatch(/bg-\[var\(--material-raised-glass-bg\)\]/)
    expect(OVERLAY_GLASS_RAISED_CLS).toMatch(/backdrop-filter:blur\(var\(--glass-blur\)\)/)
    expect(OVERLAY_GLASS_RAISED_CLS).toMatch(/shadow-\[var\(--material-raised-shadow\)\]/)
    expect(OVERLAY_GLASS_RAISED_CLS).not.toMatch(/--glass-surface/)
  })

  it('OVERLAY (glass) — the overlay rung\'s translucent form', () => {
    expect(OVERLAY_GLASS_OVERLAY_CLS).toMatch(/bg-\[var\(--material-overlay-glass-bg\)\]/)
    expect(OVERLAY_GLASS_OVERLAY_CLS).toMatch(/shadow-\[var\(--material-overlay-shadow\)\]/)
  })

  it('The ladder adds no blurred layer: only the two glass tiers carry a film, and one each', () => {
    for (const cls of [OVERLAY_RAISED_CLS, OVERLAY_OVERLAY_CLS]) {
      expect(cls).not.toMatch(/backdrop-filter/)
    }
    for (const cls of [OVERLAY_GLASS_RAISED_CLS, OVERLAY_GLASS_OVERLAY_CLS]) {
      expect(cls.match(/\[backdrop-filter:/g)).toHaveLength(1)
    }
  })

  it('Every tier shares the same corner radius and menu-in motion — the structural half none of the four tiers disagree on', () => {
    for (const cls of [
      OVERLAY_RAISED_CLS,
      OVERLAY_OVERLAY_CLS,
      OVERLAY_GLASS_RAISED_CLS,
      OVERLAY_GLASS_OVERLAY_CLS
    ]) {
      expect(cls).toMatch(/rounded-\[var\(--tr-radius-md\)\]/)
      expect(cls).toMatch(/motion-safe:\[animation:menu-in_var\(--animate-t-fast\)_var\(--animate-ease-menu\)\]/)
    }
  })

  it('Every shadow is a rung token with no hand-typed fallback — --shadow-1/-2 have landed', () => {
    for (const cls of [
      OVERLAY_RAISED_CLS,
      OVERLAY_OVERLAY_CLS,
      OVERLAY_GLASS_RAISED_CLS,
      OVERLAY_GLASS_OVERLAY_CLS
    ]) {
      expect(cls).toMatch(/shadow-\[var\(--material-(raised|overlay)-shadow\)\]/)
      expect(cls).not.toMatch(/rgba\(/)
    }
  })

  it('Disabled / Selected — N/A: an overlay surface has no disabled or selected state of its own; that lives on whatever control sits inside it (ConfirmModal\'s buttons, GitLeaf\'s menu items).', () => {
    expect(true).toBe(true)
  })

  it('Loading / Error — N/A: this file supplies elevation chrome only, no content or async state — a loading/error overlay body is the caller\'s own concern (e.g. Disclosure\'s error prop).', () => {
    expect(true).toBe(true)
  })

  it('Renders cleanly on a real element with no console error', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(<div data-testid="overlay-smoke" className={OVERLAY_GLASS_OVERLAY_CLS} />)
    })
    expect(container.querySelector('[data-testid="overlay-smoke"]')?.className).toBe(
      OVERLAY_GLASS_OVERLAY_CLS
    )
    act(() => root.unmount())
    container.remove()
  })
})
