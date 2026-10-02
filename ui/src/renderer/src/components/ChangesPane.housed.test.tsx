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
  it('keeps diff scope and Git operations available through the compact actions control', () => {
    const h = mount({ compact: true })
    h.status([file()])
    expect(q('[aria-label="Diff scope"]')).toBeNull()
    click(q('[aria-label="Git actions and diff scope"]'))
    expect(q('[aria-label="Diff scope"]')).not.toBeNull()
    click(q('[aria-label="Git actions and diff scope"]'))
    expect(q('[aria-label="Diff scope"]')).toBeNull()
  })
})


describe('compact actions popover', () => {
  function open(): HTMLButtonElement {
    const h = mount({ compact: true })
    h.status([file()])
    const trigger = q('[aria-label="Git actions and diff scope"]') as HTMLButtonElement
    trigger.getBoundingClientRect = () => ({ right: 420, bottom: 80 } as DOMRect)
    click(trigger)
    return trigger
  }

  it('keeps the trigger in place and anchors an out-of-flow overlay to its right edge', () => {
    const trigger = open()
    const wrapper = trigger.closest('.changes-compact-tools')!
    const popover = document.querySelector<HTMLElement>('.changes-compact-tools-body')!
    expect(q('[aria-label="Git actions and diff scope"]')).toBe(trigger)
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
