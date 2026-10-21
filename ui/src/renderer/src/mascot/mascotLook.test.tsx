// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MascotCompanion from './MascotCompanion'
import { DEFAULT_PREFS, setMascotPrefsForTests } from './mascotPrefs'
import { emptyLedger, persistLedger } from './mascotDirector'
import { ymd } from './occasions'

vi.mock('../components/ui/MascotArt', () => ({
  MascotArt: () => <span className="eyes-look" data-testid="eyes" />,
  MascotArtSpecimen: () => null,
}))

let frames: FrameRequestCallback[] = []
const runFrame = (): void => {
  const pending = frames
  frames = []
  pending.forEach((callback) => callback(16))
}

beforeEach(() => {
  localStorage.clear()
  // greetedDate suppresses clock-dependent greeting moments so the look guard is open.
  persistLedger({ ...emptyLedger(Date.now()), introSeen: true, greetedDate: ymd(new Date()) })
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setMascotPrefsForTests({ ...DEFAULT_PREFS })
})

function mount(): { button: HTMLButtonElement; eyes: HTMLElement } {
  const { container } = render(<MascotCompanion existingUser={false} firstRun={false} />)
  return {
    button: container.querySelector<HTMLButtonElement>('[data-testid="mascot-companion"]')!,
    eyes: container.querySelector<HTMLElement>('.eyes-look')!,
  }
}
const pointerAt = (x: number, y: number): void => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })) }

describe('mascot eye tracking', () => {
  it('measures at most once per frame while pointer moves stream in', () => {
    const { button } = mount()
    const querySpy = vi.spyOn(button, 'querySelector')
    const rectSpy = vi.spyOn(button, 'getBoundingClientRect')
    for (let i = 0; i < 10; i += 1) act(() => pointerAt(200 + i, 150 + i))
    expect(querySpy).not.toHaveBeenCalled()
    expect(rectSpy).not.toHaveBeenCalled()
    act(runFrame)
    expect(querySpy).toHaveBeenCalledTimes(1)
    expect(rectSpy).toHaveBeenCalledTimes(1)
  })

  it('still points the eyes at the pointer and re-measures after a resize', () => {
    const { button, eyes } = mount()
    const rectSpy = vi.spyOn(button, 'getBoundingClientRect')
    act(() => pointerAt(300, 200))
    act(runFrame)
    expect(eyes.style.transform).toContain('translate')
    act(() => { window.dispatchEvent(new Event('resize')); pointerAt(40, 40) })
    act(runFrame)
    expect(rectSpy).toHaveBeenCalledTimes(2)
  })
})
