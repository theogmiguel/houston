// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NightShiftLive } from './NightShiftLive'
import { NIGHT_NOW, nightRun } from '../../test/nightShiftFixtures'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('NightShiftLive', () => {
  it('renders a live run', () => {
    const onWrapUp = vi.fn()
    const onStop = vi.fn()
    const onOpenSession = vi.fn()
    act(() => root.render(<NightShiftLive run={nightRun()} workers={['zcode', 'claude']} now={NIGHT_NOW} onWrapUp={onWrapUp} onStop={onStop} onOpenSession={onOpenSession}
      machine={{ memory_free_mib: 12_288, disk_free_mib: 102_400, on_battery: false, keep_awake: 'held' }} />))
    expect(host.querySelector('[data-testid="night-countdown"]')?.textContent).toBe('4 h 00 min left')
    expect(host.querySelectorAll('[data-testid="window-mark-interruption"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="window-progress"]')).not.toBeNull()
    expect(host.textContent).toContain('the daemon restarted; the run continued')

    const crew = host.querySelector('[aria-label="Crew"]')!
    expect(crew.textContent).toContain('Orchestrator · Claude Code')
    expect(crew.textContent).toContain('worker-1 · ZCode')
    expect(crew.textContent).toContain('Working')

    const plan = (name: string): string => host.querySelector(`section[aria-label="${name}"]`)?.textContent ?? ''
    expect(plan('Planned')).toContain('Faster attach')
    expect(plan('Pull requests')).toContain('#12 Tray fix')
    expect(plan('Deferred')).toContain('Rewrite the tray')
    expect(host.textContent).toContain('7.5')
    expect(host.textContent).toContain('Held')

    const buttons = Array.from(host.querySelectorAll('button'))
    act(() => buttons.find((b) => b.textContent === 'Wrap up now')!.click())
    act(() => buttons.find((b) => b.textContent === 'Stop')!.click())
    expect(onStop).not.toHaveBeenCalled()
    expect(host.textContent).toMatch(/Closes \d+ panes? now: Orchestrator \(pane 40\)/)
    const confirm = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Stop the run')!
    act(() => confirm.click())
    act(() => buttons.find((b) => b.textContent === 'Open')!.click())
    expect(onWrapUp).toHaveBeenCalledOnce()
    expect(onStop).toHaveBeenCalledOnce()
    expect(onOpenSession).toHaveBeenCalledWith(40)

    act(() => root.render(<NightShiftLive run={nightRun({ phase: 'wrapping_up' })} workers={['zcode', 'claude']} now={NIGHT_NOW} onWrapUp={onWrapUp} onStop={onStop}
      onOpenSession={onOpenSession} machine={{ memory_free_mib: null, disk_free_mib: null, on_battery: null, keep_awake: 'held' }} />))
    expect(host.textContent).toContain('Wrap-up: nothing new starts')
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Wrap up now')).toBe(false)
  })

  it('names what spawns of a limited provider become', () => {
    const machine = { memory_free_mib: null, disk_free_mib: null, on_battery: null, keep_awake: 'held' as const }
    const render = (workers: ('zcode' | 'claude')[]): void => act(() => root.render(<NightShiftLive run={nightRun({ limited: ['zcode'] })}
      workers={workers} now={NIGHT_NOW} onWrapUp={vi.fn()} onStop={vi.fn()} onOpenSession={vi.fn()} machine={machine} />))
    render(['zcode', 'claude'])
    expect(host.textContent).toContain('Limited this run: ZCode. ZCode spawns use Claude Code.')
    render(['zcode'])
    expect(host.textContent).toContain('ZCode spawns are refused: no other worker provider is available.')
    expect(host.textContent).not.toContain('next worker provider')
  })
})
