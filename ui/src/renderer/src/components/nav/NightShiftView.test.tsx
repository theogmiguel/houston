// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { Routine } from '../../houston/generated/Routine'
import { NightShiftView } from './NightShiftView'
import { NIGHT_NOW, nightDefaults, nightRun } from '../../test/nightShiftFixtures'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = '/w'
const machine = { memory_free_mib: 8192, disk_free_mib: 51200, on_battery: false, keep_awake: 'off' as const }
const routine: Routine = {
  kind: 'night_shift', id: 3, name: 'Night shift · w', prompt: 'p', cadence: { type: 'clock', hour: 23, minute: 30, weekdays: null },
  enabled: false, workspace_id: WS, engine: 'claude', model: 'opus', next_run_at_ms: 0, permission_mode: 'bypass_permissions',
  isolate: true, revision: 'r'
}

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    nightShiftState: vi.fn(),
    nightShiftCreate: vi.fn(),
    nightShiftRunNow: vi.fn(),
    nightShiftStop: vi.fn(),
    nightShiftReport: vi.fn()
  }
  const emit = (msg: ServerMsg): void => act(() => handlers.get(msg.type)?.forEach((h) => h(msg)))
  return { client, emit }
}

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

const button = (text: string): HTMLButtonElement =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!

describe('NightShiftView', () => {
  it('sets up, follows a run live and lands on its report when it ends', () => {
    const { client, emit } = fakeClient()
    act(() => root.render(<NightShiftView client={client as unknown as HoustonClient} workspaces={[{ id: WS, name: 'w' }]} now={NIGHT_NOW} onOpenSession={() => {}} />))
    expect(client.nightShiftState).toHaveBeenCalledWith(WS)
    emit({ type: 'night_shift_state', workspace: WS, routine: null, settings: nightDefaults(), revision: 'r', runs: [], preflight: null, machine, merge_verify_command: false, child_cap: 6 })
    act(() => button('Set up Night shift').click())
    expect(client.nightShiftCreate).toHaveBeenCalledWith(WS)

    emit({ type: 'night_shift_state', workspace: WS, routine, settings: nightDefaults(), revision: 'r', runs: [], preflight: null, machine, merge_verify_command: false, child_cap: 6 })
    expect(host.querySelector('[data-testid="night-shift-setup"]')).not.toBeNull()
    act(() => button('Run now').click())
    expect(client.nightShiftState).toHaveBeenLastCalledWith(WS, NIGHT_NOW + 240 * 60_000)
    emit({ type: 'night_shift_state', workspace: WS, routine, settings: nightDefaults(), revision: 'r', runs: [], machine, merge_verify_command: false, child_cap: 6,
      preflight: [{ id: 'checks', status: 'ok', label: 'Checks', detail: '1 configured', limit: null, actual: null }] })
    act(() => button('Start').click())
    expect(client.nightShiftRunNow).toHaveBeenCalledWith(3, NIGHT_NOW + 240 * 60_000)

    emit({ type: 'night_shift_run_event', run: nightRun({ workspace: WS }) })
    expect(host.querySelector('[data-testid="night-shift-live"]')).not.toBeNull()
    act(() => button('Stop').click())
    expect(client.nightShiftStop).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Stop this Night shift run?')
    act(() => button('Stop the run').click())
    expect(client.nightShiftStop).toHaveBeenCalledWith(7)
    emit({ type: 'night_shift_run_event', run: nightRun({ workspace: WS, phase: 'settled', ended_at_ms: NIGHT_NOW, stop_reason: 'stopped' }) })
    expect(host.querySelector('[data-testid="night-shift-report"]')).not.toBeNull()
    expect(host.textContent).toContain('Stopped by you')
  })

  it('shows only Night shift refusals', () => {
    const { client, emit } = fakeClient()
    act(() => root.render(<NightShiftView client={client as unknown as HoustonClient} workspaces={[{ id: WS, name: 'w' }]} now={NIGHT_NOW} onOpenSession={() => {}} />))
    emit({ type: 'night_shift_state', workspace: WS, routine: null, settings: nightDefaults(), revision: 'r', runs: [], preflight: null, machine, merge_verify_command: false, child_cap: 6 })
    act(() => button('Set up Night shift').click())
    emit({ type: 'error', message: 'another view was refused', context: 'session:4' })
    expect(host.textContent).not.toContain('another view was refused')
    emit({ type: 'error', message: 'Night shift refused: not a git repository', context: 'night_shift' })
    expect(host.textContent).toContain('not a git repository')
  })
})
