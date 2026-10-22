// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreflightItem } from '../../houston/generated/PreflightItem'
import { NightShiftPreflight } from './NightShiftPreflight'
import { NIGHT_NOW } from '../../test/nightShiftFixtures'
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

const item = (id: string, status: PreflightItem['status'], extra: Partial<PreflightItem> = {}): PreflightItem => ({
  id, status, label: id, detail: `${id} detail`, limit: null, actual: null, ...extra
})

describe('NightShiftPreflight', () => {
  it('start disabled with blocking items', () => {
    const onStart = vi.fn()
    const onDuration = vi.fn()
    const items = [
      item('orchestration', 'ok'),
      item('memory', 'block', { detail: '4.0 GiB memory free; a run needs at least 6.0 GiB', limit: '6144 MiB', actual: '4096 MiB' }),
      item('on_battery', 'block'),
      item('restart_pending', 'warn')
    ]
    act(() => root.render(<NightShiftPreflight items={items} now={NIGHT_NOW} onDuration={onDuration} onStart={onStart} onCancel={() => {}} />))
    expect(onDuration).toHaveBeenCalledWith(NIGHT_NOW + 240 * 60_000)
    const start = host.querySelector<HTMLButtonElement>('[data-testid="night-preflight-start"]')!
    expect(start.textContent).toBe('Fix 2 items to start')
    expect(start.disabled).toBe(true)
    // The detail names the limit and the value once, in words.
    expect(host.querySelector('[data-testid="preflight-memory"]')?.textContent).toBe('4.0 GiB memory free; a run needs at least 6.0 GiB')
    const dot = (label: string): string | null => host.querySelector(`[aria-label="${label}"] [aria-hidden="true"]`)?.getAttribute('style') ?? null
    expect(dot('Blocks the run')).toContain('var(--stop)')
    expect(dot('Warning')).toContain('var(--warn)')
    expect(host.textContent).toContain('restart_pending detail')

    const twenty = Array.from(host.querySelectorAll('[role="radio"]')).find((b) => b.textContent === '20 min') as HTMLElement
    act(() => twenty.click())
    expect(onDuration).toHaveBeenLastCalledWith(NIGHT_NOW + 20 * 60_000)
    expect(host.textContent).toContain('Wrap-up at 15 min')

    act(() => root.render(<NightShiftPreflight items={[item('orchestration', 'ok'), item('restart_pending', 'warn')]} now={NIGHT_NOW}
      onDuration={onDuration} onStart={onStart} onCancel={() => {}} />))
    expect(start.textContent).toBe('Start')
    expect(start.disabled).toBe(false)
    act(() => start.click())
    expect(onStart).toHaveBeenCalledWith(NIGHT_NOW + 20 * 60_000)

    act(() => root.render(<NightShiftPreflight items={null} now={NIGHT_NOW} onDuration={onDuration} onStart={onStart} onCancel={() => {}} />))
    expect(start.disabled).toBe(true)
  })
})
