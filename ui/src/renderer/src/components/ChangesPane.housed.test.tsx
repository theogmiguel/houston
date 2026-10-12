// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { click, file, mount, q, teardown } from './ChangesPane.harness'

afterEach(teardown)

describe('Changes pane — housed ground', () => {
  it('keeps the pane root off terminal-only background tokens', () => {
    const h = mount()
    h.status([file()])
    const root = q('[data-testid="changes-pane"]')!

    expect(root.className).not.toContain('bg-[var(--pane-bg)]')
    expect(root.className).not.toContain('bg-[var(--tool-code-bg)]')
    expect(root.className).toContain('bg-[var(--material-shell-bg)]')
  })
})


describe('compact side panel changes', () => {
  it('maximized changes use a review workspace and navigate only filtered files', () => {
    const h = mount({ compact: true, maximized: true })
    h.status([file({ path: 'a.ts' }), file({ path: 'b.ts' })])
    expect(q('[data-testid="changes-review-workspace"]')).not.toBeNull()
    const pane = q('[data-testid="changes-pane"]')!
    act(() => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })))
    expect(q('[data-testid="changes-file-position"]')?.textContent).toBe('File 2 of 2')
    act(() => pane.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })))
    const filter = q<HTMLInputElement>('[aria-label="Filter files"]')!
    expect(document.activeElement).toBe(filter)
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(filter, 'a.ts')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(q('[data-testid="changes-file-position"]')?.textContent).toBe('File 1 of 1')
    expect(q('[data-path="b.ts"]')).toBeNull()
  })

  it('shows independent distinct-path comparison counts and ignores other repositories', () => {
    const h = mount({ compact: true })
    h.status([file(), file({ staged: true }), file({ path: 'b.ts' })])
    h.status([file({ path: 'c.ts' })], { base: 'main' })
    expect(q('[data-testid="changes-scope-working"]')?.textContent).toBe('Uncommitted 2')
    expect(q('[data-testid="changes-scope-branch"]')?.textContent).toBe('vs main 1')
    expect(h.client.gitStatusCalls).toContainEqual({ dir: '/repo', base: 'main' })
    act(() => h.client.emit({ type: 'git_status', dir: '/other', base: null, files: [] }))
    expect(q('[data-testid="changes-scope-working"]')?.textContent).toBe('Uncommitted 2')
  })

  it('keeps diff scope and Git operations available through the compact actions control', () => {
    const h = mount({ compact: true })
    h.status([file()])
    expect(q('[aria-label="Compare"]')).not.toBeNull()
    expect(q('[aria-label="Compare"]')).not.toBeNull()
    click(q('[aria-label="View"]'))
    expect(q('[data-testid="changes-review"]')).not.toBeNull()
    click(q('[aria-label="View"]'))
    expect(q('[aria-label="Compare"]')).not.toBeNull()
  })
})


describe('compact actions popover', () => {
  function open(): HTMLButtonElement {
    const h = mount({ compact: true })
    h.status([file()])
    const trigger = q('[aria-label="View"]') as HTMLButtonElement
    trigger.getBoundingClientRect = () => ({ right: 420, bottom: 80 } as DOMRect)
    click(trigger)
    return trigger
  }

  it('keeps the trigger in place and anchors an out-of-flow overlay to its right edge', () => {
    const trigger = open()
    const wrapper = trigger.closest('[data-changes-view]')!
    const popover = document.querySelector<HTMLElement>('.changes-compact-tools-body')!
    expect(q('[aria-label="View"]')).toBe(trigger)
    expect(wrapper.contains(popover)).toBe(false)
    expect(popover.style.position).toBe('fixed')
    expect(popover.style.top).toBe('80px')
    expect(popover.style.right).toBe(`${window.innerWidth - 420}px`)
  })

  it('closes on an outside mousedown', () => {
    const trigger = open()
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.changes-compact-tools-body')).toBeNull()
  })

  it('closes on Escape', () => {
    const trigger = open()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on window blur', () => {
    const trigger = open()
    act(() => window.dispatchEvent(new Event('blur')))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps inside interactions open and lets the trigger toggle it closed', () => {
    const trigger = open()
    const popover = document.querySelector('.changes-compact-tools-body')!
    act(() => popover.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    act(() => trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('maximized review presentation', () => {
  it('uses glyph-width key hints instead of settings binding fields', () => {
    const h = mount({ compact: true, maximized: true })
    h.status([file()])
    expect(document.querySelectorAll('[data-testid="changes-pane"] [class*="w-shortcut-keycap"]')).toHaveLength(0)
  })

  it('opens the first displayed file and keeps the footer at the selected displayed index', () => {
    const h = mount({ compact: true, maximized: true })
    h.status([file({ path: 'z/first.ts' }), file({ path: 'a/second.ts' })])
    const choices = Array.from(document.querySelectorAll('[data-testid="changes-file"]'))
    const selectedIndex = choices.findIndex((choice) => choice.getAttribute('aria-selected') === 'true')
    expect(q('[data-testid="changes-file-position"]')?.textContent).toBe(`File ${selectedIndex + 1} of 2`)
    expect(choices[selectedIndex].getAttribute('data-path')).toBe('z/first.ts')
  })
})
