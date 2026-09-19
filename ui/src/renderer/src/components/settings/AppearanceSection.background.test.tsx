// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_OVERRIDE_MESSAGE,
  backgroundState,
  setBackgroundStateForTests,
  setMode
} from '../../backgroundMode'
import { WINDOW_BACKGROUND_MAX_PIXELS } from './WindowBackgroundGroup'
import { AppearanceSection } from './AppearanceSection'
import type { ChromeTheme, TerminalPaletteChoice } from '../../theme'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)'
const MORE_CONTRAST = '(prefers-contrast: more)'

const DEFAULTS = {
  mode: 'solid',
  preset: 'graphite',
  pixelSize: 2,
  colorSteps: 4,
  originalColors: true,
  fieldOpacity: 100,
  chromeScrim: 72,
  paneScrim: 35,
  ceiling: 35,
  fadeStop: 100
} as const

type FakeMql = { matches: boolean; listeners: Set<() => void> }

function fakeMatchMedia(initial: Record<string, boolean> = {}): void {
  const mqls = new Map<string, FakeMql>()
  const get = (query: string): FakeMql => {
    let mql = mqls.get(query)
    if (!mql) {
      mql = { matches: initial[query] ?? false, listeners: new Set() }
      mqls.set(query, mql)
    }
    return mql
  }
  window.matchMedia = vi.fn((query: string) => {
    const state = get(query)
    return {
      get matches() {
        return state.matches
      },
      addEventListener: (_: string, cb: () => void) => {
        state.listeners.add(cb)
      },
      removeEventListener: (_: string, cb: () => void) => {
        state.listeners.delete(cb)
      }
    }
  }) as unknown as typeof window.matchMedia
}

const savedMatchMedia = window.matchMedia

function baseProps(): {
  chromeTheme: ChromeTheme
  onChromeTheme: (t: ChromeTheme) => void
  theme: TerminalPaletteChoice
  onTheme: (t: TerminalPaletteChoice) => void
  uiZoom: number
  onUiZoom: (z: number) => void
} {
  return {
    chromeTheme: 'graphite',
    onChromeTheme: () => {},
    theme: 'auto',
    onTheme: () => {},
    uiZoom: 1,
    onUiZoom: () => {}
  }
}

function segmentRadio(label: string): HTMLButtonElement {
  const btn = screen
    .getAllByRole('radio')
    .find((r) => r.textContent === label) as HTMLButtonElement | undefined
  if (!btn) throw new Error(`no radio labelled ${label}`)
  return btn
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  fakeMatchMedia({ [REDUCED_TRANSPARENCY]: false, [MORE_CONTRAST]: false })
  setBackgroundStateForTests(DEFAULTS)
  isTauriMock.mockReturnValue(true)
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'fs_window_background_info') return null
    if (cmd === 'fs_read_window_background') return new Uint8Array([1, 2, 3]).buffer
    throw new Error(`unexpected invoke: ${cmd}`)
  })
})

afterEach(() => {
  cleanup()
  window.matchMedia = savedMatchMedia
})

describe('the image cap', () => {
  it('exposes a defensive dimension cap', () => {
    expect(WINDOW_BACKGROUND_MAX_PIXELS).toBeGreaterThan(0)
  })
})

describe('the Background segment under an OS override', () => {
  it('is disabled with the cause named under reduced-transparency', async () => {
    fakeMatchMedia({ [REDUCED_TRANSPARENCY]: true })
    await act(async () => {
      render(<AppearanceSection {...baseProps()} />)
      await Promise.resolve()
    })
    const custom = segmentRadio('Custom')
    expect(custom.disabled).toBe(true)
    expect(custom.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      BACKGROUND_OVERRIDE_MESSAGE['reduced-transparency']
    )
  })

  it('is disabled with the cause named under contrast:more', async () => {
    fakeMatchMedia({ [MORE_CONTRAST]: true })
    await act(async () => {
      render(<AppearanceSection {...baseProps()} />)
      await Promise.resolve()
    })
    const custom = segmentRadio('Custom')
    expect(custom.disabled).toBe(true)
    expect(custom.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(
      BACKGROUND_OVERRIDE_MESSAGE.contrast
    )
  })

  it('shows the stored mode through the mask, not the forced Solid', async () => {
    fakeMatchMedia({ [REDUCED_TRANSPARENCY]: true })
    setMode('custom')
    await act(async () => {
      render(<AppearanceSection {...baseProps()} />)
      await Promise.resolve()
    })
    const custom = segmentRadio('Custom')
    expect(custom.getAttribute('aria-checked')).toBe('true')
  })

  it('is enabled with no override', async () => {
    await act(async () => {
      render(<AppearanceSection {...baseProps()} />)
      await Promise.resolve()
    })
    expect(segmentRadio('Custom').disabled).toBe(false)
  })
})

describe('the dials exist only in Custom', () => {
  it('Solid shows the mode row and nothing else', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'solid' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    expect(segmentRadio('Solid')).not.toBeNull()
    expect(screen.queryAllByTestId('background-preset-tile')).toHaveLength(0)
    expect(screen.queryByTestId('background-preview')).toBeNull()
    expect(screen.queryByTestId('background-advanced')).toBeNull()
    expect(screen.queryByTestId('background-reset')).toBeNull()
  })

  it('Custom offers four dials and a fade switch — not a mixing desk', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    const sliders = screen.getAllByRole('slider').map((s) => s.getAttribute('aria-label'))
    expect(sliders).toEqual(['Pixel size', 'Brightness', 'Chrome coat', 'Pane coat'])
    expect(screen.getByTestId('background-fade')).not.toBeNull()
  })

  it('the fade switch writes the two values the ramp understands', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    await act(async () => {
      screen.getByTestId('background-fade').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(backgroundState().fadeStop).toBe(88)
    await act(async () => {
      screen.getByTestId('background-fade').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(backgroundState().fadeStop).toBe(100)
  })

  it('Custom shows the preview, the tiles and the advanced disclosure', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    expect(screen.getAllByTestId('background-preset-tile')).toHaveLength(3)
    expect(screen.getByTestId('background-preview')).not.toBeNull()
    expect(screen.getByTestId('background-advanced')).not.toBeNull()
  })

  it('an OS override hides nothing — the settings are still the user\'s own', async () => {
    fakeMatchMedia({ [REDUCED_TRANSPARENCY]: true })
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    expect(screen.getAllByTestId('background-preset-tile')).toHaveLength(3)
  })
})

describe('the image slot reverse states', () => {
  it('choosing a preset while a user image is set KEEPS the slot', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom', preset: 'user' })
    await flush()
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    await act(async () => {
      screen
        .getAllByTestId('background-preset-tile')
        .find((t) => t.getAttribute('data-preset') === 'graphite')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(invokeMock).not.toHaveBeenCalledWith('fs_remove_window_background')
  })

  it('Remove bumps the image generation, so no cache can hand the old picture back', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_window_background_info') return { filename: 'shot.png', size: 2048, ext: 'png' }
      if (cmd === 'fs_read_window_background') return new Uint8Array([1, 2, 3]).buffer
      if (cmd === 'fs_remove_window_background') return undefined
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom', preset: 'user' })
    await flush()
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    const before = backgroundState().imageVersion
    await act(async () => {
      screen.getByTestId('background-image-remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(backgroundState().imageVersion).toBe(before + 1)
  })

  it('a refused pick settles on the previous picture and keeps showing it', async () => {
    const settles: unknown[] = []
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'dialog_pick_image') return '/pictures/new.png'
      if (cmd === 'fs_set_window_background') return '/state/background/window-background.png'
      if (cmd === 'fs_window_background_info') return { filename: 'window-background.png', size: 3, ext: 'png' }
      if (cmd === 'fs_read_window_background') return new Uint8Array([1, 2, 3]).buffer
      if (cmd === 'fs_settle_window_background') {
        settles.push(args)
        return true
      }
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom', preset: 'user' })
    await flush()
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    await act(async () => {
      screen.getByTestId('background-image-choose').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(settles).toEqual([{ keep: 'previous' }])
    expect(invokeMock).not.toHaveBeenCalledWith('fs_remove_window_background')
    expect(backgroundState().preset).toBe('user')
    expect(screen.getByTestId('background-image-error').textContent).toContain('your previous background is back')
  })

  it('Remove sweeps the slot and falls back to a preset', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'fs_window_background_info') return { filename: 'shot.png', size: 2048, ext: 'png' }
      if (cmd === 'fs_read_window_background') return new Uint8Array([1, 2, 3]).buffer
      if (cmd === 'fs_remove_window_background') return undefined
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom', preset: 'user' })
    await flush()
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    await act(async () => {
      screen.getByTestId('background-image-remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('fs_remove_window_background')
  })

  it('Reset restores defaults and sweeps the slot', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, preset: 'user', mode: 'custom' })
    await flush()
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    await act(async () => {
      screen.getByTestId('background-reset').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('fs_remove_window_background')
  })

  it('the empty image row renders its Choose button', async () => {
    setBackgroundStateForTests({ ...DEFAULTS, mode: 'custom' })
    render(<AppearanceSection {...baseProps()} />)
    await flush()
    expect(screen.getByTestId('background-image-choose')).not.toBeNull()
  })
})
