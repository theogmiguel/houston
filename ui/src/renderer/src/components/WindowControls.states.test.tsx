// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowControls } from './WindowControls'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQUARE_GLYPH_D = 'M1 1v8h8V1H1zm7 7H2V2h6v6z'

describe('WindowControls — state matrix', () => {
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

  it('Empty — N/A: there is no "not yet loaded" state; the layout prop is always known synchronously (see Empty set for buttons: []).', () => {
    expect(true).toBe(true)
  })

  it('Filled — renders exactly the buttons the layout names, in its order, on its side', () => {
    act(() => {
      root.render(
        <WindowControls layout={{ side: 'left', buttons: ['close', 'minimize', 'maximize'] }} />
      )
    })
    const buttons = Array.from(container.querySelectorAll('[data-testid="window-controls"] button'))
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Close',
      'Minimize',
      'Maximize',
    ])
    const cls = container.querySelector('[data-testid="window-controls"]')?.className ?? ''
    expect(cls).not.toContain('order-first')
    expect(cls).not.toContain('order-last')
  })

  it('Hover — every DISC carries a hover treatment (the button is a bare hit area)', () => {
    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: ['minimize'] }} />)
    })
    const disc = container.querySelector('[data-testid="window-control-disc"]')
    expect(disc?.className).toContain('group-hover/wc:bg-')
  })

  it('Hover — close carries a distinct destructive hover the others do not', () => {
    act(() => {
      root.render(
        <WindowControls layout={{ side: 'right', buttons: ['minimize', 'close'] }} />
      )
    })
    const disc = (label: string): Element | null | undefined =>
      container.querySelector(`button[aria-label="${label}"] [data-testid="window-control-disc"]`)
    expect(disc('Close')?.className).toContain('var(--danger)')
    expect(disc('Minimize')?.className).not.toContain('var(--danger)')
  })

  it('Focus — focusing the button rings the DISC, not the invisible slot', () => {
    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: ['close'] }} />)
    })
    const disc = container.querySelector('[data-testid="window-control-disc"]')
    expect(disc?.className).toContain('group-focus-visible/wc:outline-')
  })

  it('Active — the press state is a deeper wash, never a scale: no platform shrinks its window buttons, and a scale bounce is a webby tell', () => {
    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: ['close'] }} />)
    })
    const disc = container.querySelector('[data-testid="window-control-disc"]')
    expect(disc?.className).toContain('group-active/wc:bg-')
  })

  it('Selected — N/A: window buttons are momentary actions, not a persisted selection; maximize communicates its own toggled state via icon, not a selected style.', () => {
    expect(true).toBe(true)
  })

  it('Disabled — N/A: every rendered button is always actionable; a host that cannot minimize/maximize/close simply omits that entry from the layout.', () => {
    expect(true).toBe(true)
  })

  it('Loading — N/A: these are synchronous native-window actions with no pending/in-flight visual state of their own.', () => {
    expect(true).toBe(true)
  })

  it('Error — N/A: no network/async call to fail; a failed minimize/maximize/close is an OS-level condition outside this component.', () => {
    expect(true).toBe(true)
  })

  it('Overflow — N/A: fixed-size icon buttons with no text content that can overflow.', () => {
    expect(true).toBe(true)
  })

  it('Empty set — buttons: [] renders nothing, not a stray container', () => {
    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: [] }} />)
    })
    expect(container.querySelector('[data-testid="window-controls"]')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('maximize glyph swaps to the restore icon when maximized, and the name follows it', () => {
    act(() => {
      root.render(
        <WindowControls layout={{ side: 'right', buttons: ['maximize'] }} maximized />
      )
    })
    expect(container.querySelector('button[aria-label="Maximize"]')).toBeNull()
    const button = container.querySelector('button[aria-label="Restore"]')
    expect(button).not.toBeNull()
    expect(button?.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Restore')
    const d = button?.querySelector('path')?.getAttribute('d') ?? ''
    expect(d).not.toBe(SQUARE_GLYPH_D)
    expect(d.match(/[Vv]/g)?.length ?? 0).toBeGreaterThan(2)
  })

  it('Geometry — the button neutralises every box property `.btn` sets on it', () => {
    const baseCssPath = resolve(process.cwd(), 'src/renderer/src/base.css')
    const baseCss = readFileSync(baseCssPath, 'utf8')
    const rule = /(^|\})\s*\.btn\s*\{([^}]*)\}/m.exec(baseCss)?.[2]
    expect(
      rule,
      'base.css no longer has a `.btn { ... }` rule — this test guards the chrome that rule supplies, so retarget it rather than deleting it'
    ).toBeTruthy()

    const NEUTRALISERS: Record<string, string> = {
      padding: 'p-0',
      margin: 'm-0',
      'border-radius': 'rounded-none',
      border: 'border-none',
      'border-width': 'border-none',
    }

    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: ['close'] }} />)
    })
    const cls = container.querySelector('button[aria-label="Close"]')?.className ?? ''

    const setProps = (rule ?? '')
      .split(';')
      .map((d) => d.split(':')[0]?.trim())
      .filter((name): name is string => Boolean(name) && name in NEUTRALISERS)
    expect(setProps.length, `parsed no box properties out of base.css's .btn rule: ${rule}`)
      .toBeGreaterThan(0)

    for (const prop of setProps) {
      expect(
        cls.split(/\s+/),
        `base.css's \`.btn\` rule sets \`${prop}\`, so WindowControls' button must carry \`${NEUTRALISERS[prop]}\` — without it the wash inside collapses to the glyph's width (this is the 10x20 "oval" regression)`
      ).toContain(NEUTRALISERS[prop])
    }
  })

  it('Geometry — the wash is a 6px rounded square, not a circle', () => {
    act(() => {
      root.render(<WindowControls layout={{ side: 'right', buttons: ['minimize'] }} />)
    })
    const wash = container.querySelector('[data-testid="window-control-disc"]')
    const cls = wash?.className ?? ''
    expect(cls).toContain('rounded-[6px]')
    expect(cls).not.toContain('rounded-full')
    expect(cls).toContain('w-[calc(20px/var(--shell-zoom,1))]')
    expect(cls).toContain('h-[calc(20px/var(--shell-zoom,1))]')
  })

  it('click handlers route to the matching prop, not any other button', () => {
    const onClose = vi.fn()
    const onMinimize = vi.fn()
    const onMaximize = vi.fn()
    act(() => {
      root.render(
        <WindowControls
          layout={{ side: 'right', buttons: ['minimize', 'maximize', 'close'] }}
          onClose={onClose}
          onMinimize={onMinimize}
          onMaximize={onMaximize}
        />
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Minimize"]')?.click()
    })
    expect(onMinimize).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(onMaximize).not.toHaveBeenCalled()
  })
})
