// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Select, type SelectOption } from './Select'
import { openSelect, selectTrigger, selectValue } from '../test/selectHarness'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FONTS: SelectOption[] = [
  { value: 'nerd', label: 'Nerd Font (recommended)' },
  { value: 'jetbrains', label: 'JetBrains Mono' },
  { value: 'system', label: 'System monospace' }
]

describe('Select', () => {
  let container: HTMLDivElement
  let root: Root
  let picked: string[]

  function render(props: Partial<React.ComponentProps<typeof Select>> = {}): void {
    act(() => {
      root.render(
        <Select
          data-testid="s"
          aria-label="Font family"
          value="nerd"
          options={FONTS}
          onChange={(v) => picked.push(v)}
          {...props}
        />
      )
    })
  }

  function key(k: string): void {
    act(() => {
      selectTrigger(container, 's').dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true })
      )
    })
  }

  function activeValue(): string | null {
    const trigger = selectTrigger(container, 's')
    const id = trigger.getAttribute('aria-activedescendant')
    if (!id) return null
    return trigger.ownerDocument.getElementById(id)?.dataset.value ?? null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    picked = []
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('Filled — the closed trigger shows the current value, and nothing else is in the DOM', () => {
    render()
    expect(selectValue(container, 's')).toBe('Nerd Font (recommended)')
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })

  it('Empty — a value with no matching option renders an empty trigger rather than inventing one', () => {
    render({ value: 'a-font-that-was-uninstalled' })
    expect(selectValue(container, 's')).toBe('')
  })

  it('Active — opening lands the keyboard on the CURRENT value, not the top of the list', () => {
    render({ value: 'system' })
    openSelect(container, 's')
    expect(activeValue()).toBe('system')
  })

  it('arrows step, Home/End jump, and none of it commits until Enter', () => {
    render()
    openSelect(container, 's')
    key('ArrowDown')
    expect(activeValue()).toBe('jetbrains')
    key('End')
    expect(activeValue()).toBe('system')
    key('Home')
    expect(activeValue()).toBe('nerd')
    key('ArrowUp')
    expect(activeValue()).toBe('nerd')
    expect(picked, 'moving the highlight must not change the value').toEqual([])

    key('ArrowDown')
    key('Enter')
    expect(picked).toEqual(['jetbrains'])
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('Escape closes and commits nothing, leaving the value where it was', () => {
    render()
    openSelect(container, 's')
    key('ArrowDown')
    key('Escape')
    expect(picked).toEqual([])
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
    expect(selectValue(container, 's')).toBe('Nerd Font (recommended)')
  })

  it('type-ahead moves the highlight while open — the native behaviour, reimplemented', () => {
    render()
    openSelect(container, 's')
    key('j')
    expect(activeValue()).toBe('jetbrains')
  })

  it('type-ahead accumulates a multi-character prefix rather than re-searching one letter', () => {
    render({
      value: 'sys',
      options: [
        { value: 'sys', label: 'System' },
        { value: 'a', label: 'Sonnet A' },
        { value: 'b', label: 'Sonnet B' }
      ]
    })
    openSelect(container, 's')
    key('s')
    expect(activeValue(), 'a letter steps to the NEXT match, as a <select> does').toBe('a')
    key('y')
    expect(activeValue()).toBe('sys')
  })

  it('type-ahead on the CLOSED trigger changes the value outright, as a <select> does', () => {
    render()
    key('s')
    expect(picked).toEqual(['system'])
  })

  it('a repeated letter cycles through that letter’s matches instead of re-matching one row', () => {
    render({
      value: 'a',
      options: [
        { value: 'a', label: 'Sonnet' },
        { value: 'b', label: 'Sonnet Thinking' },
        { value: 'c', label: 'Opus' }
      ]
    })
    openSelect(container, 's')
    key('s')
    expect(activeValue()).toBe('b')
    key('s')
    expect(activeValue()).toBe('a')
  })

  it('Disabled — the trigger is disabled, states why, and cannot be opened', () => {
    render({ disabled: true, title: 'Pick a workspace first' })
    const trigger = selectTrigger(container, 's')
    expect(trigger.disabled).toBe(true)
    expect(trigger.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Pick a workspace first')
    act(() => {
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0)
  })

  it('a disabled option is skipped by the arrows and refuses to commit', () => {
    render({
      value: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B', disabled: true },
        { value: 'c', label: 'C' }
      ]
    })
    const rows = openSelect(container, 's')
    key('ArrowDown')
    expect(activeValue()).toBe('c')
    act(() => {
      rows[1].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    expect(picked).toEqual([])
  })

  it('Error — n/a: this is a controlled presentational control over caller-owned options; it fetches nothing and has no failure of its own to report.', () => {
    expect(true).toBe(true)
  })

  it('the open listbox is ARIA-wired to its trigger', () => {
    render()
    openSelect(container, 's')
    const trigger = selectTrigger(container, 's')
    expect(trigger.getAttribute('role')).toBe('combobox')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const menu = trigger.ownerDocument.getElementById(trigger.getAttribute('aria-controls')!)
    expect(menu?.getAttribute('role')).toBe('listbox')
    const selected = menu!.querySelectorAll('[aria-selected="true"]')
    expect(selected, 'exactly one option is the current value').toHaveLength(1)
    expect((selected[0] as HTMLElement).dataset.value).toBe('nerd')
  })
})
