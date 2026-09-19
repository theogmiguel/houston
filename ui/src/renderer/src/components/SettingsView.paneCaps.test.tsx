// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { baseSettingsViewProps, hostInfoFixture, setInputValue } from './settingsViewTestFixtures'
import { setSettingsNavForTests } from '../settingsNav'
import {
  IDLE_QUIET_MS_DEFAULT,
  STACK_CAP_DEFAULT,
  STACK_CAP_MAX,
  idleQuietMsDefault,
  passKeysToTerminal,
  setPaneCapsForTests,
  stackCapacity
} from '../paneCaps'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  setPaneCapsForTests({
    passThrough: false,
    idleQuietMs: IDLE_QUIET_MS_DEFAULT,
    stackCap: STACK_CAP_DEFAULT
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setPaneCapsForTests({
    passThrough: false,
    idleQuietMs: IDLE_QUIET_MS_DEFAULT,
    stackCap: STACK_CAP_DEFAULT
  })
})

function render(section: 'shortcuts' | 'orchestration' | 'terminal'): void {
  act(() => setSettingsNavForTests({ open: true, section }))
  act(() => {
    root.render(
      <SettingsView
        {...baseSettingsViewProps()}
        hostInfo={hostInfoFixture()}
        orchestrationState={{
          caps: { max_live_children: 4, max_spawn_depth: 4 },
          enabled: true,
          acpAgents: []
        }}
        keymapOverrides={{ bindings: {}, shortcuts_enabled: true }}
      />
    )
  })
}

function byTestId<T extends HTMLElement>(id: string): T {
  const el = container.querySelector(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on screen`)
  return el as T
}

describe('settings-20 — "Pass through to terminal" has a row', () => {
  it('reflects the current value and writes the store when toggled', () => {
    render('shortcuts')
    const sw = byTestId<HTMLButtonElement>('settings-pass-through')
    expect(sw.getAttribute('aria-checked')).toBe('false')

    act(() => sw.click())
    expect(passKeysToTerminal()).toBe(true)
    expect(byTestId<HTMLButtonElement>('settings-pass-through').getAttribute('aria-checked')).toBe(
      'true'
    )
  })
})

describe('settings-40 — "Panes per stack" has a bounded row', () => {
  it('commits a value inside the bounds', () => {
    render('terminal')
    const input = byTestId<HTMLInputElement>('settings-panes-per-stack')
    expect(input.value).toBe(String(STACK_CAP_DEFAULT))
    setInputValue(input, '6')
    act(() => {
      input.focus()
      input.blur()
    })
    expect(stackCapacity()).toBe(6)
  })

  it('refuses a value past the cap and NAMES the limit, the value and what was asked', () => {
    render('terminal')
    const input = byTestId<HTMLInputElement>('settings-panes-per-stack')
    setInputValue(input, String(STACK_CAP_MAX + 3))
    act(() => {
      input.focus()
      input.blur()
    })
    expect(stackCapacity()).toBe(STACK_CAP_DEFAULT)
    const msg = byTestId('settings-panes-per-stack-rejected').textContent ?? ''
    expect(msg).toContain(String(STACK_CAP_MAX + 3))
    expect(msg).toContain(String(STACK_CAP_MAX))
    expect(msg).toContain(String(STACK_CAP_DEFAULT))
  })
})

describe('settings-01 — the idle-quiet default has a bounded row', () => {
  it('commits a value inside the bounds', () => {
    render('terminal')
    const input = byTestId<HTMLInputElement>('settings-idle-quiet-ms')
    expect(input.value).toBe(String(IDLE_QUIET_MS_DEFAULT))
    setInputValue(input, '1200')
    act(() => {
      input.focus()
      input.blur()
    })
    expect(idleQuietMsDefault()).toBe(1200)
  })
})
