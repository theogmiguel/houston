// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeymapOverrides, WorkspaceAction } from '../../houston/client'
import { WorkspaceActions } from './WorkspaceActions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KEYMAP: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }
const ACTION: WorkspaceAction = { id: 'test', name: 'test', command: 'bun run test', shortcut: null }
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

function mount(onRun = vi.fn(), onSave = vi.fn(), onDelete = vi.fn()): HTMLElement {
  act(() => root.render(<WorkspaceActions actions={[ACTION]} keymapOverrides={KEYMAP} onRun={onRun} onSave={onSave} onDelete={onDelete} />))
  return container
}

describe('WorkspaceActions', () => {
  it('runs an action from its workspace list', () => {
    const run = vi.fn()
    const el = mount(run)
    const button = Array.from(el.querySelectorAll('button')).find((item) => item.textContent?.includes('▶ test'))!
    act(() => button.click())
    expect(run).toHaveBeenCalledWith(ACTION)
  })

  it('keeps row actions hidden until hover or keyboard focus', () => {
    const el = mount()
    const group = el.querySelector('[data-testid="workspace-actions"]')!
    const menu = el.querySelector('[aria-label="More actions for test"]')!.parentElement!
    expect(group.className).toContain('border-t')
    expect(menu.className).toContain('opacity-0')
    expect(menu.className).toContain('group-hover:opacity-100')
    expect(menu.className).toContain('group-focus-within:opacity-100')
  })

  it('uses compact, left-aligned fields in the action form', () => {
    const el = mount()
    act(() => Array.from(el.querySelectorAll('button')).find((button) => button.textContent === '＋ Add action')!.click())
    const dialog = el.querySelector('[role="dialog"]')!
    expect(dialog.className).toContain('text-left')
    expect(el.querySelector('input[aria-labelledby$="-label"]')?.className).toContain('bg-[var(--card-bg)]')
    expect(el.querySelectorAll('input')[1].className).toContain('font-mono')
    expect(Array.from(el.querySelectorAll('button')).some((button) => button.textContent === 'Save')).toBe(true)
    expect(Array.from(el.querySelectorAll('button')).some((button) => button.textContent === 'Press shortcut' && button.className.includes('bg-[var(--card-bg)]'))).toBe(true)
  })

  it('requires confirmation before deleting a saved action', () => {
    const onDelete = vi.fn()
    const el = mount(vi.fn(), vi.fn(), onDelete)
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="More actions for test"]')!.click())
    act(() => Array.from(el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((item) => item.textContent === 'Delete')!.click())
    expect(el.querySelector('[role="alertdialog"]')).not.toBeNull()
    act(() => el.querySelector<HTMLButtonElement>('[role="alertdialog"] button:last-child')!.click())
    expect(onDelete).toHaveBeenCalledWith('test')
  })

  it('captures a shortcut and refuses an owner already using it', () => {
    const el = mount()
    const buttons = Array.from(el.querySelectorAll('button'))
    act(() => buttons.find((button) => button.textContent === '＋ Add action')!.click())
    act(() => Array.from(el.querySelectorAll('button')).find((button) => button.textContent === 'Press shortcut')!.click())
    const event = new KeyboardEvent('keydown', { key: 't', code: 'KeyT', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    act(() => window.dispatchEvent(event))
    expect(el.textContent).toContain('Already bound')
    expect(el.textContent).toContain('new terminal in this workspace')
  })
})
