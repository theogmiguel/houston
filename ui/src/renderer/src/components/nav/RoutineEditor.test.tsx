// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineEditor } from './RoutineEditor'
import { SELECT_CLS } from '../selectChrome'

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

  it('Isolation is the app switch, not a native checkbox', () => {
    act(() => {
      root.render(<RoutineEditor mode="create" workspaces={[]} onSubmit={noop} onCancel={noop} />)
    })
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    const sw = container.querySelector('[data-testid="routine-isolate"]')!
    expect(sw.getAttribute('role')).toBe('switch')
  })
})
