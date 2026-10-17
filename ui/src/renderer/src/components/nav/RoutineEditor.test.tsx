// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineEditor } from './RoutineEditor'
import { SELECT_CLS } from '../ui/selectChrome'
import { openSelect, closeSelect, pickOption, selectValue } from '../../test/selectHarness'
import type { RoutineEngineRefusal } from '../../houston/generated/RoutineEngineRefusal'
import type { RoutineFormValue } from './RoutineEditor'

const ZCODE_REASON = 'its edit mode waits for approval on every shell command, and nobody gives it'
const REFUSALS: RoutineEngineRefusal[] = [
  { engine: 'opencode', permission_mode: 'accept_edits', reason: 'its only unattended mode approves every action, as full access does' },
  { engine: 'zcode', permission_mode: 'accept_edits', reason: ZCODE_REASON }
]

function option(container: HTMLElement, testId: string, value: string): HTMLElement {
  const row = openSelect(container, testId).find((r) => r.dataset.value === value)
  if (!row) throw new Error(`no ${value} option in ${testId}`)
  return row
}

function tooltipOf(el: HTMLElement): string | null {
  return el.closest('[data-tooltip]')?.getAttribute('data-tooltip') ?? null
}

function noop(): void {}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('RoutineEditor', () => {
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

  it('disables submit until a name is entered', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    const submit = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create routine'
    ) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Leak watch"]'
    )!
    act(() => setValue(nameInput, 'Cert sweep'))
    expect(submit.disabled).toBe(false)
  })

  it('edit mode pre-fills every field and carries no bot field', () => {
    act(() => {
      root.render(
        <RoutineEditor
          mode="edit"
          workspaces={[{ id: '/home/dev/app', name: 'app' }]}
          initial={{
            engine: 'claude',
            model: null,
            effort: null,
            name: 'Cert sweep',
            prompt: 'p',
            cadence: { type: 'interval', seconds: 900 },
            workspaceId: '/home/dev/app',
            permissionMode: 'accept_edits',
            isolate: false
          }}
          onSubmit={noop}
          onCancel={noop}
        />
      )
    })
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Leak watch"]')!.value).toBe(
      'Cert sweep'
    )
    expect(container.textContent).not.toContain('Bot')
  })

  it('dropdown-01: every bounded picker uses the shared SELECT_CLS chrome', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    const triggers = Array.from(container.querySelectorAll('[role="combobox"]'))
    expect(triggers).toHaveLength(4)
    for (const t of triggers) {
      for (const cls of SELECT_CLS.split(/\s+/)) {
        expect(t.className).toContain(cls)
      }
    }
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model"]')).toBeTruthy()
  })

  it('accepts a provider model ID and hides effort where the CLI has no per-run flag', () => {
    act(() => {
      root.render(
        <RoutineEditor
          mode="edit"
          workspaces={[]}
          initial={{
            engine: 'opencode',
            model: 'opencode-go/deepseek-v4.1-flash',
            effort: null,
            name: 'Review',
            prompt: 'review',
            cadence: { type: 'interval', seconds: 900 },
            workspaceId: null,
            permissionMode: 'bypass_permissions',
            isolate: false
          }}
          onSubmit={noop}
          onCancel={noop}
        />
      )
    })
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Model"]')!.value).toBe(
      'opencode-go/deepseek-v4.1-flash'
    )
    expect(container.querySelector('[aria-label="Reasoning effort"]')).toBeNull()
  })

  it('switches a clock preset to Custom and edits hour/minute', () => {
    let submitted: unknown = null
    act(() => {
      root.render(
        <RoutineEditor
          mode="create"
          workspaces={[]}
          onSubmit={(v) => {
            submitted = v
          }}
          onCancel={noop}
        />
      )
    })
    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Leak watch"]'
    )!
    act(() => setValue(nameInput, 'Weekly sweep'))

    const dailyBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Daily 09:00'
    )!
    act(() => dailyBtn.click())
    const customBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Custom'
    )!
    act(() => customBtn.click())

    const numberInputs = Array.from(container.querySelectorAll('input[type="number"]'))
    act(() => setValue(numberInputs[0] as HTMLInputElement, '7'))

    const submit = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create routine'
    )!
    act(() => submit.click())
    expect(submitted).toEqual({
      engine: 'claude',
      model: null,
      effort: null,
      name: 'Weekly sweep',
      prompt: '',
      cadence: { type: 'clock', hour: 7, minute: 0, weekdays: null },
      workspaceId: null,
      permissionMode: 'accept_edits',
      isolate: false
    })
  })

  it('the custom clock cadence picks days with the segmented control, not a native checkbox', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    const dailyPreset = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Daily 09:00'
    )!
    act(() => dailyPreset.click())
    const customBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Custom'
    )!
    act(() => customBtn.click())

    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    const weekdaysOpt = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (b) => b.textContent === 'Weekdays'
    ) as HTMLButtonElement
    expect(weekdaysOpt).toBeTruthy()
    act(() => weekdaysOpt.click())
    expect(weekdaysOpt.getAttribute('aria-checked')).toBe('true')
  })

  it('with accept edits, the engines the daemon refuses are disabled and say what access they need', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} engineRefusals={REFUSALS} onSubmit={noop} onCancel={noop} />)
    })
    const zcode = option(container, 'routine-engine', 'zcode')
    expect(zcode.getAttribute('aria-disabled')).toBe('true')
    expect(tooltipOf(zcode)).toBe(
      `ZCode needs isolated full access: ${ZCODE_REASON}. Choose Full access under Access first; it needs isolation.`
    )
    expect(option(container, 'routine-engine', 'opencode').getAttribute('aria-disabled')).toBe('true')
    const claude = option(container, 'routine-engine', 'claude')
    expect(claude.getAttribute('aria-disabled')).toBeNull()
    expect(tooltipOf(claude)).toBeNull()
    act(() => zcode.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })))
    closeSelect(container, 'routine-engine')
    expect(selectValue(container, 'routine-engine')).toBe('Claude Code')
  })

  it('only providers a routine can run with are offered', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    const values = openSelect(container, 'routine-engine').map((r) => r.dataset.value)
    expect(values).toEqual(['claude', 'codex', 'antigravity', 'opencode', 'zcode'])
  })

  it('with isolated full access, ZCode is selectable, and accept edits and turning isolation off are not', () => {
    let submitted: RoutineFormValue | null = null
    act(() => {
      root.render(
        <RoutineEditor
          mode="create"
          workspaces={[{ id: '/home/dev/app', name: 'app' }]}
          engineRefusals={REFUSALS}
          initial={{
            engine: 'claude',
            model: null,
            effort: null,
            name: 'Sweep',
            prompt: 'p',
            cadence: { type: 'interval', seconds: 900 },
            workspaceId: '/home/dev/app',
            permissionMode: 'bypass_permissions',
            isolate: true
          }}
          onSubmit={(v) => { submitted = v }}
          onCancel={noop}
        />
      )
    })
    expect(option(container, 'routine-engine', 'zcode').getAttribute('aria-disabled')).toBeNull()
    pickOption(container, 'routine-engine', 'zcode')
    expect(selectValue(container, 'routine-engine')).toBe('ZCode')

    const acceptEdits = option(container, 'routine-access', 'accept_edits')
    expect(acceptEdits.getAttribute('aria-disabled')).toBe('true')
    expect(tooltipOf(acceptEdits)).toBe(`ZCode needs isolated full access: ${ZCODE_REASON}.`)
    closeSelect(container, 'routine-access')

    const isolate = container.querySelector<HTMLButtonElement>('[data-testid="routine-isolate"]')!
    expect(isolate.disabled).toBe(true)
    expect(container.textContent).toContain('Turning isolation off would switch this routine to accept edits.')

    act(() => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Create routine')!.click())
    expect(submitted).toMatchObject({ engine: 'zcode', permissionMode: 'bypass_permissions', isolate: true })
  })

  it('Isolation is the app switch, not a native checkbox', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    const sw = container.querySelector('[data-testid="routine-isolate"]')!
    expect(sw.getAttribute('role')).toBe('switch')
  })
})
