// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ShortcutSheet } from './ShortcutSheet'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import type { KeymapOverrides } from '../houston/generated/KeymapOverrides'

describe('ShortcutSheet (fix round F1)', () => {
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

  function render(overrides: KeymapOverrides): void {
    act(() => {
      root.render(
        <KeymapOverridesContext.Provider value={overrides}>
          <ShortcutSheet onClose={() => {}} />
        </KeymapOverridesContext.Provider>
      )
    })
  }

  function sectionLabels(): string[] {
    return Array.from(container.querySelectorAll('label')).map((l) => l.textContent ?? '')
  }

  function rowFor(description: string): HTMLElement {
    const row = Array.from(container.querySelectorAll('label + div > div')).find((r) =>
      r.textContent?.includes(description)
    )
    if (!row) throw new Error(`no row found for "${description}"`)
    return row as HTMLElement
  }

  it('renders an "IN THE EDITOR" section with the split-down row', () => {
    render({ bindings: {}, shortcuts_enabled: true })
    expect(sectionLabels()).toContain('IN THE EDITOR')
    expect(container.textContent).toContain('split the editor pane down')
    expect(container.textContent).toContain('Ctrl+Shift+D')
  })

  it('dims the editor row (and the global rows) while shortcuts are off, leaving terminal alone', () => {
    render({ bindings: {}, shortcuts_enabled: false })

    const editorRow = rowFor('split the editor pane down')
    expect(editorRow.className).toContain('opacity-[0.45]')

    const globalRow = rowFor('new terminal in this workspace')
    expect(globalRow.className).toContain('opacity-[0.45]')

    const terminalRow = rowFor('find in the terminal')
    expect(terminalRow.className).not.toContain('opacity-[0.45]')
  })

  it('leaves every row at full opacity while shortcuts are on', () => {
    render({ bindings: {}, shortcuts_enabled: true })
    const editorRow = rowFor('split the editor pane down')
    expect(editorRow.className).not.toContain('opacity-[0.45]')
  })

  it("the OFF banner names both sections it silences, not just KEYBOARD", () => {
    render({ bindings: {}, shortcuts_enabled: false })
    const banner = Array.from(container.querySelectorAll('div')).find((d) =>
      d.textContent?.startsWith('Global shortcuts are OFF')
    )
    expect(banner?.textContent).toContain('KEYBOARD')
    expect(banner?.textContent).toContain('IN THE EDITOR')
  })

  it('shows no OFF banner while shortcuts are on', () => {
    render({ bindings: {}, shortcuts_enabled: true })
    const banner = Array.from(container.querySelectorAll('div')).find((d) =>
      d.textContent?.startsWith('Global shortcuts are OFF')
    )
    expect(banner).toBeUndefined()
  })
})
