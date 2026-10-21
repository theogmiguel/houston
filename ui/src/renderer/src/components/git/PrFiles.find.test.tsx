// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PrFiles } from './PrFiles'
import { KeymapOverridesContext } from '../../layout/keymapOverridesContext'
import type { KeymapOverrides } from '../../houston/generated/KeymapOverrides'
import type { PrDiffView } from './usePrDetailSubscription'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const patch = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old needle',
  '+new',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1 +1 @@',
  '-x',
  '+second Needle'
].join('\n')

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  host?.remove()
  root = null
  host = null
})

function render(overrides: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }, truncated = false): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const diff = { number: 7, patch, truncated, message: null } as PrDiffView
  act(() => root!.render(
    <KeymapOverridesContext.Provider value={overrides}>
      <div data-testid="terminal-stand-in" tabIndex={0} />
      <PrFiles diff={diff} loading={false} drafts={[]} writeBusy={false} onAddDraft={() => {}} onReload={() => {}} />
    </KeymapOverridesContext.Provider>
  ))
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector)

function press(target: Element, init: KeyboardEventInit): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

function type(value: string): void {
  const input = q('[data-testid="diff-find-input"]') as HTMLInputElement
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const ctrlF = { key: 'f', code: 'KeyF', ctrlKey: true }
const fileHeading = (path: string): HTMLElement => q(`[data-testid="pr-file"][data-path="${path}"] [aria-expanded]`)!

describe('find in pull request files', () => {
  it('opens on Ctrl+F inside the diff, never from outside it', () => {
    render()
    press(q('[data-testid="terminal-stand-in"]')!, ctrlF)
    expect(q('[data-testid="diff-find-input"]')).toBeNull()
    press(q('[data-testid="pr-files"] [data-kind="ctx"]')!, ctrlF)
    expect(q('[data-testid="diff-find-input"]')).not.toBeNull()
  })

  it('counts matches, steps into a collapsed file and expands it', () => {
    render()
    press(q('[data-testid="pr-files"]')!, ctrlF)
    expect(fileHeading('b.ts').getAttribute('aria-expanded')).toBe('false')
    type('needle')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('1/2')
    expect(q('[data-diff-find-active]')?.textContent).toBe('needle')
    press(q('[data-testid="diff-find-input"]')!, { key: 'Enter' })
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('2/2')
    expect(fileHeading('b.ts').getAttribute('aria-expanded')).toBe('true')
    expect(q('[data-testid="pr-file"][data-path="b.ts"] [data-diff-find-active]')?.textContent).toBe('Needle')
    press(q('[data-testid="diff-find-input"]')!, { key: 'Enter', shiftKey: true })
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('1/2')
  })

  it('matches case on request and closes on Escape', () => {
    render()
    press(q('[data-testid="pr-files"]')!, ctrlF)
    type('Needle')
    act(() => q('[data-testid="diff-find-case"]')!.click())
    expect(q('[data-testid="diff-find-case"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('1/1')
    type('NEEDLE')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('No results')
    press(q('[data-testid="diff-find-input"]')!, { key: 'Escape' })
    expect(q('[data-testid="diff-find-input"]')).toBeNull()
    expect(document.querySelectorAll('[data-diff-find-mark]')).toHaveLength(0)
  })

  it('says the result is partial when the patch was truncated', () => {
    render(undefined, true)
    press(q('[data-testid="pr-files"]')!, ctrlF)
    type('absent')
    expect(q('[data-testid="diff-find-count"]')?.textContent).toBe('No results · partial')
  })

  it('follows a rebound chord', () => {
    render({ bindings: { 'find-in-diff': { code: 'KeyG', ctrl: true, alt: false, shift: false, meta: false } }, shortcuts_enabled: true })
    press(q('[data-testid="pr-files"]')!, ctrlF)
    expect(q('[data-testid="diff-find-input"]')).toBeNull()
    press(q('[data-testid="pr-files"]')!, { key: 'g', code: 'KeyG', ctrlKey: true })
    expect(q('[data-testid="diff-find-input"]')).not.toBeNull()
  })
})
