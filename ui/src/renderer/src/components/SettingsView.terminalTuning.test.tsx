// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { baseSettingsViewProps, setInputValue } from './settingsViewTestFixtures'
import {
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_SCROLLBACK_MAX
} from '../usePreferences'

function openTerminal(): void {
  act(() => setSettingsNavForTests({ section: 'terminal' }))
}

describe('Settings › Terminal — Line height / Cursor blink / Scrollback (settings-11/-14/-15)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    openTerminal()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the current line height and commits an in-range change on blur', () => {
    const committed: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          terminalLineHeight={1.35}
          onTerminalLineHeight={(n) => committed.push(n)}
        />
      )
    })
    const input = container.querySelector(
      '[data-testid="settings-terminal-line-height"]'
    ) as HTMLInputElement
    expect(input.value).toBe('1.35')
    setInputValue(input, '1.6')
    act(() => {
      input.focus()
      input.blur()
    })
    expect(committed).toEqual([1.6])
  })

  it('rejects an out-of-range line height -- names the limit, the value asked for, and what is kept', () => {
    const committed: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          terminalLineHeight={1.35}
          onTerminalLineHeight={(n) => committed.push(n)}
        />
      )
    })
    const input = container.querySelector(
      '[data-testid="settings-terminal-line-height"]'
    ) as HTMLInputElement
    const tooHigh = TERMINAL_LINE_HEIGHT_MAX + 1
    setInputValue(input, String(tooHigh))
    act(() => {
      input.focus()
      input.blur()
    })
    expect(committed).toEqual([])
    expect(input.value).toBe('1.35')
    const rejection = container.querySelector(
      '[data-testid="settings-terminal-line-height-rejected"]'
    )
    expect(rejection?.textContent).toContain(String(TERMINAL_LINE_HEIGHT_MAX))
    expect(rejection?.textContent).toContain(String(tooHigh))
    expect(rejection?.textContent).toContain('1.35')
  })

  it('shows the cursor-blink toggle reflecting the current value and commits a change', () => {
    let current = true
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          terminalCursorBlink={true}
          onTerminalCursorBlink={(v) => {
            current = v
          }}
        />
      )
    })
    const toggle = container.querySelector(
      '[data-testid="settings-terminal-cursor-blink"]'
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    act(() => toggle.click())
    expect(current).toBe(false)
  })

  it('shows the current scrollback and commits an in-range change on blur', () => {
    const committed: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          terminalScrollbackLines={10_000}
          onTerminalScrollbackLines={(n) => committed.push(n)}
        />
      )
    })
    const input = container.querySelector(
      '[data-testid="settings-terminal-scrollback"]'
    ) as HTMLInputElement
    expect(input.value).toBe('10000')
    setInputValue(input, '20000')
    act(() => {
      input.focus()
      input.blur()
    })
    expect(committed).toEqual([20_000])
  })

  it('rejects an out-of-range scrollback value -- names the limit, the value asked for, and what is kept', () => {
    const committed: number[] = []
    act(() => {
      root.render(
        <SettingsView
          {...baseSettingsViewProps()}
          terminalScrollbackLines={10_000}
          onTerminalScrollbackLines={(n) => committed.push(n)}
        />
      )
    })
    const input = container.querySelector(
      '[data-testid="settings-terminal-scrollback"]'
    ) as HTMLInputElement
    const tooHigh = TERMINAL_SCROLLBACK_MAX + 1
    setInputValue(input, String(tooHigh))
    act(() => {
      input.focus()
      input.blur()
    })
    expect(committed).toEqual([])
    expect(input.value).toBe('10000')
    const rejection = container.querySelector('[data-testid="settings-terminal-scrollback-rejected"]')
    expect(rejection?.textContent).toContain(String(TERMINAL_SCROLLBACK_MAX))
    expect(rejection?.textContent).toContain(String(tooHigh))
    expect(rejection?.textContent).toContain('10000')
  })

  it('names the daemon-side ceiling on reattach in the scrollback row\'s own description', () => {
    act(() => {
      root.render(<SettingsView {...baseSettingsViewProps()} />)
    })
    const row = container.querySelector('[data-testid="settings-terminal-scrollback"]')!
    const rowText = row.closest('[data-testid="settings-row"]')!.textContent ?? ''
    expect(rowText.toLowerCase()).toMatch(/reattach|reconnect|detach/)
  })
})
